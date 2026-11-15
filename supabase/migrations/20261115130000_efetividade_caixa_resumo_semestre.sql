-- EFETIVIDADE — RESUMO DE CAIXA CONFIRMADO E SALDO POR SEMESTRE (leitura agregada).
--
-- PENDENTE: escrita nesta branch e NÃO aplicada em produção. Aplicação e registro
-- no ledger dependem de autorização específica. O registro em
-- docs/seguranca/migracoes-aprovadas.tsv NÃO está nesta PR: a linha é criada no
-- momento da aprovação, com a janela de 30 minutos do runbook.
-- Rollback: docs/rollbacks/efetividade-caixa-resumo-semestre-rollback.sql.
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
-- fora de CANCELADO, com decomposição (conferência, acadêmico, sem pendência,
-- acordos ativos). Os acordos ativos não substituem o total.
--
-- RATEIO NÃO ENTRA AQUI. O recuperado por rateio é outra grandeza e continua nas RPCs
-- de efetividade, identificado como tal.
--
-- PORTÃO. Gestão ativa autorizada: e-mail na lista de `usuario_e_gestao()` E linha
-- em `usuarios` com `ativo = true`. Diretoria NÃO entra por este caminho.

create or replace function public.efetividade_caixa_resumo_semestre(p_semestre text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
  v_saldo jsonb := null;
  v_carteira numeric := null;
  v_titulos bigint := null;
  v_fonte text := null;
begin
  if not (
    coalesce(public.usuario_e_gestao(), false)
    and exists (
      select 1 from public.usuarios u
       where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
         and u.ativo is true
    )
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
      'saldo_sem_pendencia', round(coalesce(sum(c.saldo) filter (where c.faixa in ('SEM_NEGOCIACAO','CONVERTIDO')), 0), 2),
      'saldo_acordos_ativos', round(coalesce(sum(c.saldo) filter (
          where c.faixa <> 'CANCELADO' and c.acordo_id is not null
            and c.acordo_estado in ('regular','atraso','quebrado')), 0), 2)
    ), round(sum(c.valor_original), 2), count(*)
      into v_saldo, v_carteira, v_titulos
      from public.carteira_2026_2_classificar() c;
    v_fonte := 'classificador_2026_2';
  elsif p_semestre = '2026/1' then
    v_carteira := (public.carteira_efetividade_ler('seis_linhas', '2026', '1')
                    -> 'situacoes' -> 'entrou' ->> 'valor')::numeric;
    v_titulos  := (public.carteira_efetividade_ler('seis_linhas', '2026', '1')
                    -> 'situacoes' -> 'entrou' ->> 'titulos')::bigint;
    v_fonte := 'fotografia_seis_linhas_2026_1';
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
    'carteira_fonte', v_fonte,
    'percentual_recuperado_caixa',
      case when coalesce(v_carteira, 0) > 0
           then round(100 * (v->>'caixa_confirmado')::numeric / v_carteira, 1) end,
    'saldo_2026_2', v_saldo
  );

  return v;
end;
$$;

revoke all on function public.efetividade_caixa_resumo_semestre(text) from public, anon;
grant execute on function public.efetividade_caixa_resumo_semestre(text) to authenticated;
