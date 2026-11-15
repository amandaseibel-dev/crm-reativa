-- EFETIVIDADE — RESUMO DE CAIXA CONFIRMADO POR SEMESTRE (leitura agregada).
--
-- PENDENTE: esta migration foi escrita nesta branch e NÃO foi aplicada em
-- produção. Aplicação e registro no ledger dependem de autorização específica.
-- Rollback em docs/rollbacks/efetividade-caixa-resumo-semestre-rollback.sql.
--
-- POR QUE EXISTE. A tela autenticada não consegue ler `efetividade_caixa_origem`
-- (sem grant para `authenticated`) e não deve receber linhas de pagamento. Esta
-- função devolve SOMENTE agregados por semestre de origem: nenhum CPF, aluno,
-- título, acordo ou pagamento individual sai daqui.
--
-- CRITÉRIO DE CAIXA CONFIRMADO. Mesmo critério medido em 15/11/2026 sobre a view:
--   confianca = 'PROVADA' AND status_conciliacao = 'BAIXADO'.
-- Tudo o mais é "pendente de classificação" e NÃO é contado como recebido:
-- CHAVE_EXATA sem status ou em revisão, parcela já paga, aguardando amarração.
-- Pagamento sem origem determinada (confianca = 'INDETERMINADA') não é atribuído
-- a semestre nenhum: sai como total à parte, nunca como zero.
--
-- RATEIO NÃO ENTRA AQUI. O "recuperado por rateio" é outra grandeza (status da
-- parcela, não dinheiro) e continua nas RPCs de efetividade, identificado como tal.
--
-- PORTÃO. Gestão ativa ou diretoria, como `carteira_2026_1_pode_ler`, sem o
-- atalho de `auth.jwt() is null`. Sem sessão autorizada, levanta erro.

create or replace function public.efetividade_caixa_resumo_semestre(p_semestre text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not (coalesce(public.usuario_e_gestao(), false) or coalesce(public.usuario_e_diretoria(), false)) then
    raise exception 'sem permissão para o resumo de caixa' using errcode = '42501';
  end if;

  if p_semestre is null or p_semestre not in ('2024/1','2024/2','2025/1','2025/2','2026/1','2026/2') then
    raise exception 'semestre inválido: %', p_semestre using errcode = '22023';
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

  return v;
end;
$$;

revoke all on function public.efetividade_caixa_resumo_semestre(text) from public, anon;
grant execute on function public.efetividade_caixa_resumo_semestre(text) to authenticated;
