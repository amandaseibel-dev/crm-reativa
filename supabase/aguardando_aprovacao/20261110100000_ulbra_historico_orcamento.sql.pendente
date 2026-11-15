-- =============================================================================
-- ULBRA — orçamento compartilhado do histórico somente leitura.
-- PENDENTE. NÃO APLICAR sem autorização expressa.
--
-- O que muda: uma tabela de contagem diária e uma função que reserva chamadas
-- de forma atômica, por operador e global, entre instâncias e requisições.
-- Não guarda texto de mensagem. Não toca grants de tabelas existentes.
--
-- Atomicidade: um lock de transação por dia serializa as reservas. Assim duas
-- requisições simultâneas não passam juntas do teto.
-- =============================================================================

create table if not exists public.ulbra_historico_uso (
  escopo   text    not null,            -- e-mail do operador, ou '*' para o global
  dia      date    not null,
  usadas   integer not null default 0 check (usadas >= 0),
  primary key (escopo, dia)
);

alter table public.ulbra_historico_uso enable row level security;
revoke all on table public.ulbra_historico_uso from public, anon, authenticated;
grant select, insert, update on table public.ulbra_historico_uso to service_role;

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
