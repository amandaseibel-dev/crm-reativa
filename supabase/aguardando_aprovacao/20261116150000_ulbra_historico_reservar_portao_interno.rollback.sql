-- ROLLBACK da 20261116150000 — NÃO APLICADO. Restaura a definição aplicada em 20261112111006 (sem portão).
-- Só use se o portão causar problema comprovado; a versão sem portão não tem o portão interno (exposição em produção não comprovada).
do $$
begin
  if position('acesso negado à reserva do histórico' in pg_get_functiondef('public.ulbra_historico_reservar(text,date,integer,integer,integer)'::regprocedure)) = 0 then
    raise exception 'ROLLBACK: portão já ausente';
  end if;
end $$;

create or replace function public.ulbra_historico_reservar(
  p_operador text,
  p_dia date,
  p_quantidade integer,
  p_teto_operador integer,
  p_teto_global integer
)
returns table (permitido boolean, usadas_operador integer, usadas_global integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uo integer;
  ug integer;
begin
  if p_quantidade is null or p_quantidade < 1 then
    raise exception 'quantidade inválida';
  end if;
  perform pg_advisory_xact_lock(hashtext('ulbra_historico_' || p_dia::text));
  insert into public.ulbra_historico_uso (escopo, dia)
       values (p_operador, p_dia), ('*', p_dia)
  on conflict do nothing;
  select usadas into uo from public.ulbra_historico_uso where escopo = p_operador and dia = p_dia;
  select usadas into ug from public.ulbra_historico_uso where escopo = '*' and dia = p_dia;
  if uo + p_quantidade > p_teto_operador or ug + p_quantidade > p_teto_global then
    return query select false, uo, ug;
    return;
  end if;
  update public.ulbra_historico_uso
     set usadas = usadas + p_quantidade
   where dia = p_dia and escopo in (p_operador, '*');
  return query select true, uo + p_quantidade, ug + p_quantidade;
end;
$$;

revoke all on function public.ulbra_historico_reservar(text, date, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.ulbra_historico_reservar(text, date, integer, integer, integer) to service_role;
