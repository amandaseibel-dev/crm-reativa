-- DESFAZER 20260831310000_excluir_titulo_que_nao_existe.sql
--
-- ATENCAO: a ficha passa a chamar `titulo_excluir`. Removendo-a sem voltar o
-- front junto, o botao "Excluir" quebra.
--
-- Os titulos JA EXCLUIDOS nao voltam sozinhos -- mas nao se perderam. A linha
-- inteira esta em audit_log, gravada pelo gatilho `trg_audit` no DELETE:
--
--   select dados_antes from public.audit_log
--    where tabela='acordos_titulos' and operacao='DELETE'
--    order by criado_em desc;
--
-- Para restaurar um deles, reinserir a partir de `dados_antes` e recalcular o
-- aluno.
--
-- O gatilho `titulos_por_status_acordo` tambem volta ao comportamento antigo:
-- cancelar acordo devolve TODOS os titulos vinculados para ABERTO, inclusive o
-- boleto do proprio acordo -- que foi o defeito relatado pela Amanda em 31/08.

drop function if exists public.titulo_excluir(uuid, text);

create or replace function public.titulos_por_status_acordo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status='QUITADO' then
    update public.acordos_titulos t set situacao='PAGO', atualizado_em=now()
    from public.acordo_titulo_vinculo v
    where v.titulo_id=t.id and v.acordo_id=new.id and coalesce(v.ativo,true) and t.situacao in ('ABERTO','NEGOCIADO');
  elsif new.status='CANCELADO' then
    update public.acordos_titulos t set situacao='ABERTO', atualizado_em=now()
    from public.acordo_titulo_vinculo v
    where v.titulo_id=t.id and v.acordo_id=new.id and coalesce(v.ativo,true) and t.situacao='NEGOCIADO';
  end if;
  return new;
end;$function$;
