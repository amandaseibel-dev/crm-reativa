-- EFETIVIDADE — RESUMO DE CAIXA CONFIRMADO E SALDO POR SEMESTRE (leitura agregada).
--
-- PENDENTE: escrita nesta branch e NÃO aplicada em produção. Aplicação e registro
-- no ledger dependem de autorização específica (ver docs/seguranca/migracoes-aprovadas.tsv).
-- Rollback: docs/rollbacks/efetividade-caixa-resumo-semestre-rollback.sql.
--
-- O QUE DEVOLVE. Somente agregados por semestre de origem. Nenhum CPF, aluno,
-- título, acordo ou pagamento individual sai daqui.
--
-- CAIXA CONFIRMADO. confianca = 'PROVADA' AND status_conciliacao = 'BAIXADO' na
-- view `efetividade_caixa_origem` (medido em 15/11/2026: 639 pagamentos em 2026/1,
-- 594 em 2026/2). Todo o resto é "pendente de classificação" e NÃO é recebido.
-- Pagamento sem origem determinada (INDETERMINADA) não é atribuído a semestre: sai
-- como total à parte, nunca como zero.
--
-- SALDO DE 2026/2 (só este semestre). Vem do classificador oficial
-- `carteira_2026_2_classificar()`, o mesmo universo da carteira original: 10.822
-- títulos, R$ 17.232.872,41, batendo com `carteira_2026_2_contexto`. O saldo total
-- em aberto é a soma de `saldo` fora de CANCELADO. Ele é decomposto em conferência,
-- ajuste acadêmico, sem pendência e acordos. Os acordos ativos NÃO substituem o
-- saldo total. Em 2026/1 estes campos ficam nulos: o saldo vem da fotografia
-- `seis_linhas`, sem recálculo ao vivo aqui.
--
-- RATEIO NÃO ENTRA AQUI. O recuperado por rateio é outra grandeza e continua nas RPCs
-- de efetividade, identificado como tal.
--
-- PORTÃO. Gestão ativa autorizada: e-mail na lista de `usuario_e_gestao()` E linha
-- correspondente em `usuarios` com `ativo = true`. Diretoria NÃO entra por este
-- caminho. Usuário anon e sessão sem e-mail são negados.

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
  v_conf boolean;
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
    )
      into v_saldo
      from public.carteira_2026_2_classificar() c;
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
    ),
    'saldo_2026_2', v_saldo
  )
    into v
    from public.efetividade_caixa_origem
   where semestre_origem = p_semestre;

  return v;
end;
$$;

revoke all on function public.efetividade_caixa_resumo_semestre(text) from public, anon;
grant execute on function public.efetividade_caixa_resumo_semestre(text) to authenticated;
