-- ROLLBACK das 3 protecoes operacionais (casos 17138, 17148, 17155).
--
-- NAO EXECUTADO. Preparado em 11/09/2026 a pedido da Amanda.
-- Usar quando a conciliacao Prime x CRM for concluida e os 3 casos tiverem
-- destino definido.
--
-- Desfaz exatamente o que a migration 20260911233508
-- (`excecao_conciliacao_nao_acionar_3_casos`) fez: devolve `nao_acionar`,
-- `observacao_operacional`, `caso_atualizado_por` e `caso_atualizado_em` aos
-- valores guardados em `_backup_excecao_conciliacao_20260912`.
--
-- Nao toca em saldo, titulo, acordo, parcela nem pagamento -- porque a ida
-- tambem nao tocou.
--
-- ATENCAO: ao reverter, os 3 voltam a ser candidatos da
-- `reposicao_carteira_processar` (roda a cada minuto). Reverter so quando eles
-- puderem voltar a ser distribuidos, ou depois de zerar a divida na conciliacao.

begin;

-- confere que o backup esta intacto antes de qualquer coisa
do $chk$
begin
  if (select count(*) from public._backup_excecao_conciliacao_20260912) <> 3 then
    raise exception 'backup nao tem os 3 casos -- abortando rollback';
  end if;
end
$chk$;

update public.casos c
   set nao_acionar            = b.nao_acionar_antes,
       observacao_operacional = b.observacao_antes,
       caso_atualizado_por    = b.atualizado_por_antes,
       caso_atualizado_em     = b.atualizado_em_antes
  from public._backup_excecao_conciliacao_20260912 b
 where c.id = b.caso_id
   and c.caso_atualizado_por = 'gestao_excecao_conciliacao'
returning c.caso_codigo, c.nao_acionar, c.operador_email, c.total_em_aberto;

-- conferir o retorno: tem que vir 3 linhas, todas com nao_acionar = false.
-- Se vier diferente, dar ROLLBACK em vez de COMMIT.

commit;
