-- ROLLBACK da 20261115120000. Transacional por si só. Não apaga histórico de uso.
-- Volta a reserva à versão instalada (20261112111006, sem guarda) e remove as colunas de bloqueio.
begin;
do $$
begin
  if exists (select 1 from public.ulbra_sync_estado where historico_bloqueado_ate is not null or historico_bloqueado_sem_prazo) then
    raise notice 'HA_BLOQUEIO_ATIVO: o rollback remove o bloqueio; confirme que é o desejado';
  end if;
end $$;
create or replace function public.ulbra_historico_reservar(
  p_operador text, p_dia date, p_quantidade integer, p_teto_operador integer, p_teto_global integer)
returns table (permitido boolean, usadas_operador integer, usadas_global integer)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare uo integer; ug integer;
begin
  if p_quantidade is null or p_quantidade < 1 then raise exception 'quantidade inválida'; end if;
  perform pg_advisory_xact_lock(hashtext('ulbra_historico_' || p_dia::text));
  insert into public.ulbra_historico_uso (escopo, dia) values (p_operador, p_dia), ('*', p_dia) on conflict do nothing;
  select usadas into uo from public.ulbra_historico_uso where escopo = p_operador and dia = p_dia;
  select usadas into ug from public.ulbra_historico_uso where escopo = '*' and dia = p_dia;
  if uo + p_quantidade > p_teto_operador or ug + p_quantidade > p_teto_global then
    return query select false, uo, ug; return;
  end if;
  update public.ulbra_historico_uso set usadas = usadas + p_quantidade where dia = p_dia and escopo in (p_operador, '*');
  return query select true, uo + p_quantidade, ug + p_quantidade;
end;
$$;
revoke all on function public.ulbra_historico_reservar(text, date, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.ulbra_historico_reservar(text, date, integer, integer, integer) to service_role;
alter table public.ulbra_sync_estado drop column if exists historico_bloqueado_ate, drop column if exists historico_bloqueado_sem_prazo;
commit;
