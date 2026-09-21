-- D-2: gatilhos de resolucao FAIL-SAFE + indice por parcela_id.
-- Risco tratado: tg_acordo_alerta_resolve_parcela/acordo rodam AFTER UPDATE de parcelas/acordos como SECURITY DEFINER e nao tinham tratamento
-- de excecao; um erro no mecanismo SECUNDARIO (alerta) abortaria a operacao financeira PRINCIPAL (parcela PAGO/CANCELADA, acordo QUITADO/CANCELADO).
-- Agora o erro e capturado num sub-bloco (savepoint), registrado em auditoria (mesmo padrao do fluxo de pagamentos) e a operacao principal prevalece.
-- QUERY_CANCELED (statement_timeout) nao e capturado por WHEN OTHERS: mesmo comportamento dos demais gatilhos do fluxo. Nao cria nem altera alertas.
begin;

CREATE OR REPLACE FUNCTION public.tg_acordo_alerta_resolve_parcela() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  begin
    update public.acordo_alertas_parcela set resolvido_em = now(),
           resolucao = case when upper(coalesce(new.status,'')) = 'PAGO' then 'PAGA' else 'SUBSTITUIDA' end
     where parcela_id = new.id and resolvido_em is null;
  exception when others then
    begin
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'ALERTA_D2_RESOLVE_FALHOU', 'parcelas', new.id, jsonb_build_object('erro', SQLERRM, 'sqlstate', SQLSTATE));
    exception when others then null;
    end;
  end;
  return null;
end; $function$;

CREATE OR REPLACE FUNCTION public.tg_acordo_alerta_resolve_acordo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  begin
    update public.acordo_alertas_parcela set resolvido_em = now(),
           resolucao = case when upper(coalesce(new.status,'')) = 'QUITADO' then 'ACORDO_QUITADO' else 'ACORDO_CANCELADO' end
     where acordo_id = new.id and resolvido_em is null;
  exception when others then
    begin
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'ALERTA_D2_RESOLVE_FALHOU', 'acordos', new.id, jsonb_build_object('erro', SQLERRM, 'sqlstate', SQLSTATE));
    exception when others then null;
    end;
  end;
  return null;
end; $function$;

-- O unico indice existente (acordo_id, parcela_id, tipo) so serve a busca por acordo_id; a resolucao por parcela e o ON DELETE CASCADE de
-- parcelas -> alertas filtram por parcela_id (varredura da tabela inteira a cada baixa e a cada exclusao de parcela).
create index if not exists acordo_alertas_parcela_parcela_idx on public.acordo_alertas_parcela (parcela_id);

-- ACL preservada por CREATE OR REPLACE; reafirmada por seguranca (gatilhos sem EXECUTE direto).
revoke all on function public.tg_acordo_alerta_resolve_parcela(), public.tg_acordo_alerta_resolve_acordo() from public, anon, authenticated;
commit;
