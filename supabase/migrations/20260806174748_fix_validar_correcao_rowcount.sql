-- Fix: v_ok era boolean mas recebia row_count (int) e comparava v_ok > 0,
-- gerando "operator does not exist: boolean > integer" a cada validação.
create or replace function public.validar_correcao(p_id uuid, p_ok boolean, p_comentario text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  update public.sugestoes s
     set status = case when p_ok then 'FEITA' else 'REABERTO' end,
         retorno_operador = case when p_ok then s.retorno_operador else nullif(btrim(coalesce(p_comentario, '')), '') end,
         validado_em = case when p_ok then now() else s.validado_em end,
         status_em = now(),
         status_por = public.app_email()
   where s.id = p_id
     and lower(coalesce(s.autor_email, '')) = public.app_email()
     and s.status = 'AGUARDANDO_VALIDACAO'
     and public.app_usuario_ativo();
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.validar_correcao(uuid, boolean, text) from public, anon;
grant execute on function public.validar_correcao(uuid, boolean, text) to authenticated;
