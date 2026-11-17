-- EFETIVIDADE — RESUMO DE CAIXA CONFIRMADO E SALDO POR SEMESTRE (leitura agregada).
--
-- PENDENTE: escrita nesta branch e NÃO aplicada em produção. Aplicação e registro
-- no ledger dependem de autorização específica. O registro em
-- docs/seguranca/migracoes-aprovadas.tsv NÃO está nesta PR: a linha é criada no
-- momento da aprovação, com a janela de 30 minutos do runbook.
-- Rollback: docs/rollbacks/efetividade-caixa-resumo-semestre-rollback.sql.
--
-- NEGOCIADO NÃO É A MESMA GRANDEZA NOS DOIS SEMESTRES. 2026/1: saldo ainda não pago de acordo
-- (fotografia). 2026/2: valor original dos títulos em acordo. A RPC devolve `negociado_definicao`
-- com o nome de cada uma. Não são diretamente comparáveis.
--
-- O QUE DEVOLVE. Somente agregados por semestre. Nenhum CPF, aluno, título, acordo
-- ou pagamento individual sai daqui. A tela só exibe estes campos: não calcula nada.
--
-- CAIXA CONFIRMADO. confianca = 'PROVADA' AND status_conciliacao = 'BAIXADO' na view
-- `efetividade_caixa_origem`. Todo o resto é "pendente de classificação" e não é
-- recebido. INDETERMINADA não é atribuído a semestre: sai como total à parte.
--
-- CARTEIRA ORIGINAL E TÍTULOS.
--   2026/2: classificador oficial `carteira_2026_2_classificar()`, mesmo universo do saldo.
--   2026/1: fotografia `carteira_efetividade_ler('seis_linhas','2026','1')`, campo
--           situacoes.entrou. Fonte declarada em `carteira_fonte`. A fotografia pode
--           estar defasada: a RPC não a recalcula.
--
-- PERCENTUAL. `percentual_recuperado_caixa` = caixa confirmado ÷ carteira original,
-- em %, calculado AQUI. É recuperação por caixa confirmado identificado, não
-- recuperação total: o valor sem classificação fica separado e visível.
--
-- SALDO DE 2026/2 (bloco `saldo_2026_2`). Saldo total em aberto = soma de `saldo`
-- fora de CANCELADO. Conferência, acadêmico e acordos ativos são subconjuntos
-- informativos, NÃO partição do total: não somam ao total. Acordos ativos não
-- substituem o total.
--
-- RATEIO NÃO ENTRA AQUI. O recuperado por rateio é outra grandeza e continua nas RPCs
-- de efetividade, identificado como tal.
--
-- VOLATILIDADE. Declarada VOLATILE por cautela. A versão final só lê: não chama carteira_2026_2_negociacoes()
-- nem nenhuma função que escreva. O negociado de 2026/2 é consulta de leitura própria.
--
-- PORTÃO POR SEMESTRE. Gestão ativa (lista de `usuario_e_gestao()` E linha
-- em `usuarios` com `ativo = true`). Diretoria (`usuario_e_diretoria()`) só em 2026/1.

create or replace function public.efetividade_caixa_resumo_semestre(p_semestre text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
  v_saldo jsonb := null;
  v_carteira numeric := null;
  v_titulos bigint := null;
  v_fonte text := null;
  v_saldo_aberto numeric := null;
  v_negociado numeric := null;
  v_def_fotografia boolean := null;
  v_gerado_fotografia text := null;
  f jsonb;
begin
  -- Gestão ativa: lista de usuario_e_gestao() E usuarios.ativo = true (como antes).
  -- Diretoria: só em 2026/1, espelhando relatorio_mensalidades_2026_1_sem_negociacao()
  -- (que aceita usuario_e_diretoria()). Em 2026/2 o relatório é só de gestão, então a
  -- diretoria NÃO entra. Nenhum outro perfil entra.
  if not (
    (coalesce(public.usuario_e_gestao(), false)
       and exists (
         select 1 from public.usuarios u
          where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
            and u.ativo is true))
    or (coalesce(p_semestre = '2026/1', false) and coalesce(public.usuario_e_diretoria(), false))
  ) then
    raise exception 'sem permissão para o resumo de caixa' using errcode = '42501';
  end if;

  if p_semestre is null or p_semestre not in ('2024/1','2024/2','2025/1','2025/2','2026/1','2026/2') then
    raise exception 'semestre inválido: %', p_semestre using errcode = '22023';
  end if;

  if p_semestre = '2026/2' then
    select jsonb_build_object(
      'carteira_original', round(sum(c.valor_original), 2),
      'titulos_carteira', count(*),
      'saldo_em_aberto_total', round(coalesce(sum(c.saldo) filter (where c.faixa <> 'CANCELADO'), 0), 2),
      'saldo_em_conferencia', round(coalesce(sum(c.saldo) filter (where c.faixa = 'EM_CONFERENCIA'), 0), 2),
      'saldo_academico', round(coalesce(sum(c.saldo) filter (where c.faixa = 'ACADEMICO'), 0), 2),
      'saldo_acordos_ativos', round(coalesce(sum(c.saldo) filter (
          where c.faixa <> 'CANCELADO' and c.acordo_id is not null
            and c.acordo_estado in ('regular','atraso','quebrado')), 0), 2)
    ), round(sum(c.valor_original), 2), count(*),
       round(coalesce(sum(c.saldo) filter (where c.faixa <> 'CANCELADO'), 0), 2)
      into v_saldo, v_carteira, v_titulos, v_saldo_aberto
      from public.carteira_2026_2_classificar() c;
    -- Negociado de 2026/2 por consulta de leitura equivalente à de carteira_2026_2_negociacoes()
    -- (mesmos filtros e critérios), SEM a função escritora. Não usa tabela temporária.
    with serie as (
      select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(semestre) semestre
        from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
    ),
    parc as (
      select acordo_id,
             coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
             coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas,
             count(*) filter (where status = 'VENCIDA' and vencimento >= current_date - 30) venc_ate30,
             count(*) filter (where status = 'VENCIDA' and vencimento <  current_date - 30) venc_mais30
        from public.parcelas group by 1
    ),
    acordo as (
      select a.id,
             case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                  then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                  when a.status = 'QUITADO' then 1 else 0 end ratio
        from public.acordos a left join parc p on p.acordo_id = a.id
    ),
    n as (
      select t.id titulo_id, t.valor_original vo, ac.id acordo_id,
             round(t.valor_original * ac.ratio, 2) recebido,
             round(t.valor_original * (1 - ac.ratio), 2) saldo,
             lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') cpf
        from public.acordos_titulos t
        left join public.acordo_titulo_vinculo v on v.titulo_id = t.id and v.ativo
        left join serie s on s.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
        join acordo ac on ac.id = coalesce(t.acordo_id, v.acordo_id)
       where t.situacao <> 'DUPLICADA'
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
         and coalesce(s.semestre,
               case when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01'
                    then '2026/2' end) = '2026/2'
    )
    select round(coalesce(sum(vo),0),2) into v_negociado from n;
    v_fonte := 'classificador_2026_2';
  elsif p_semestre = '2026/1' then
    f := public.carteira_efetividade_ler('seis_linhas', '2026', '1');
    v_carteira     := (f -> 'situacoes' -> 'entrou'  ->> 'valor')::numeric;
    v_titulos      := (f -> 'situacoes' -> 'entrou'  ->> 'titulos')::bigint;
    v_saldo_aberto := (f -> 'situacoes' -> 'em_aberto' ->> 'valor')::numeric;
    v_negociado    := (f -> 'situacoes' -> 'negociado' ->> 'valor')::numeric;
    v_fonte := 'fotografia_seis_linhas_2026_1';
    v_def_fotografia := coalesce((f -> 'snapshot' ->> 'atualizacao_pendente')::boolean, false);
    v_gerado_fotografia := f ->> 'gerado_em';
  end if;

  select jsonb_build_object(
    'semestre', p_semestre,
    'caixa_confirmado',
      coalesce(sum(valor_pago) filter (
        where coalesce(confianca = 'PROVADA' and status_conciliacao = 'BAIXADO', false)), 0),
    'pagamentos_confirmados',
      count(*) filter (
        where coalesce(confianca = 'PROVADA' and status_conciliacao = 'BAIXADO', false)),
    'pendente_classificacao',
      coalesce(sum(valor_pago) filter (
        where not coalesce(confianca = 'PROVADA' and status_conciliacao = 'BAIXADO', false)), 0),
    'pagamentos_pendentes',
      count(*) filter (
        where not coalesce(confianca = 'PROVADA' and status_conciliacao = 'BAIXADO', false)),
    'data_referencia', max(data_pagamento),
    'sem_origem_determinada', (
      select coalesce(sum(valor_pago), 0)
        from public.efetividade_caixa_origem
       where confianca = 'INDETERMINADA'
    )
  )
    into v
    from public.efetividade_caixa_origem
   where semestre_origem = p_semestre;

  v := v || jsonb_build_object(
    'carteira_original', v_carteira,
    'titulos_carteira', v_titulos,
    'saldo_em_aberto', v_saldo_aberto,
    'fotografia_atualizacao_pendente', v_def_fotografia,
    'fotografia_gerada_em', v_gerado_fotografia,
    'base_carteira', case when p_semestre = '2026/2'
      then 'todos os títulos do universo, inclusive cancelados (denominador)'
      else 'fotografia seis_linhas, entrou' end,
    'negociado', v_negociado,
    'negociado_definicao', case when p_semestre = '2026/2'
      then 'Valor original dos títulos em acordo'
      else 'Saldo de acordos a receber' end,
    'carteira_fonte', v_fonte,
    'percentual_recuperado_caixa',
      case when coalesce(v_carteira, 0) > 0
           then round(100 * (v->>'caixa_confirmado')::numeric / v_carteira, 1) end,
    'saldo_2026_2', v_saldo
  );

  return v;
end;
$$;

-- Contrato restrito: só authenticated (com o portão interno). PUBLIC, anon e
-- service_role saem; outros papéis herdados por privilégio padrão também saem,
-- se existirem neste projeto.
revoke all on function public.efetividade_caixa_resumo_semestre(text) from public, anon;
-- service_role e papéis de executor só existem em alguns ambientes (no Supabase sim;
-- num Postgres puro de CI não). Revoga apenas os que existem.
do $$
declare r text;
begin
  foreach r in array array['service_role', 'reativa_responsavel_executor'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.efetividade_caixa_resumo_semestre(text) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function public.efetividade_caixa_resumo_semestre(text) to authenticated;
