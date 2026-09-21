-- ROLLBACK de 20260922120000: volta aos gatilhos sem tratamento de excecao (texto de 20260922110000) e remove o indice.
begin;
CREATE OR REPLACE FUNCTION public.tg_acordo_alerta_resolve_parcela() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  update public.acordo_alertas_parcela set resolvido_em = now(),
         resolucao = case when upper(coalesce(new.status,'')) = 'PAGO' then 'PAGA' else 'SUBSTITUIDA' end
   where parcela_id = new.id and resolvido_em is null;
  return null;
end; $function$;
CREATE OR REPLACE FUNCTION public.tg_acordo_alerta_resolve_acordo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  update public.acordo_alertas_parcela set resolvido_em = now(),
         resolucao = case when upper(coalesce(new.status,'')) = 'QUITADO' then 'ACORDO_QUITADO' else 'ACORDO_CANCELADO' end
   where acordo_id = new.id and resolvido_em is null;
  return null;
end; $function$;
drop index if exists public.acordo_alertas_parcela_parcela_idx;
commit;
