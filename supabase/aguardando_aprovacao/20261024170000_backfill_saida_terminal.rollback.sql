-- REVERSÃO DO BACKFILL DA SAÍDA TERMINAL
-- =============================================================================
-- Devolve cada pagamento ao status que a auditoria da própria transição
-- registra, por id exato. Não apaga o que entrou depois: só toca pagamento que
-- está HOJE em ENCERRADO_SEM_EFEITO_FINANCEIRO e tem linha
-- 'CONCILIACAO_SAIDA_TERMINAL' na auditoria.
--
-- A decisão na fila NÃO é desfeita aqui -- ela é anterior a esta frente e
-- continua valendo. O que se reverte é só a transição de status.
-- =============================================================================

begin;

create temporary table _reverter_saida_terminal on commit drop as
select distinct on (au.registro_id)
       au.registro_id as pagamento_id,
       au.detalhes -> 'estado_anterior' ->> 'status_conciliacao' as status_antes
  from public.auditoria au
  join public.pagamentos p on p.id = au.registro_id
 where au.acao = 'CONCILIACAO_SAIDA_TERMINAL'
   and p.status_conciliacao = 'ENCERRADO_SEM_EFEITO_FINANCEIRO'
 order by au.registro_id, au.id desc;

do $g$
declare v_n int;
begin
  select count(*) into v_n from _reverter_saida_terminal
   where status_antes is null
      or status_antes not in ('AGUARDANDO_ACORDO','AGUARDANDO_AMARRACAO',
                              'PARCELA_JA_PAGA','REVISAO','SEM_VINCULO',
                              'ACORDO_CONFIRMADO_SEM_ESTRUTURA','TITULO_ORIGINAL_LIQUIDADO');
  if v_n > 0 then
    raise exception 'REVERSAO RECUSADA: % linha(s) sem status anterior reconhecivel na auditoria.', v_n;
  end if;
end
$g$;

update public.pagamentos p
   set status_conciliacao = r.status_antes
  from _reverter_saida_terminal r
 where p.id = r.pagamento_id
   and p.status_conciliacao = 'ENCERRADO_SEM_EFEITO_FINANCEIRO';

insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
select coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao'),
       'CONCILIACAO_SAIDA_TERMINAL_REVERTIDA', 'pagamentos', r.pagamento_id,
       jsonb_build_object('status_restaurado', r.status_antes,
                          'sem_efeito_financeiro', true)
  from _reverter_saida_terminal r;

select count(*) as ainda_terminais from public.pagamentos
 where status_conciliacao = 'ENCERRADO_SEM_EFEITO_FINANCEIRO';

-- Esperado: ainda_terminais = 0. COMMIT SÓ DEPOIS DE CONFERIR.
-- commit;
rollback;
