-- VIGIA DE CARGA: registra alertas quando o banco entra em pressao (sob_carga),
-- para visibilidade proativa ("avisar antes"). Complementa o disjuntor:
-- disjuntor PROTEGE (barra o pesado); vigia AVISA (registra que apertou).
-- Limitacao: se o banco ja estiver 100% saturado o cron pode nao iniciar; o valor
-- esta em capturar a SUBIDA da pressao antes do pico.

create table if not exists public.sistema_carga_alertas (
  id            bigint generated always as identity primary key,
  detectado_em  timestamptz not null default now(),
  ativos        int,
  ativos_longos int,
  idle_in_tx    int,
  amostra       jsonb
);
create index if not exists idx_sistema_carga_alertas_detectado on public.sistema_carga_alertas (detectado_em desc);

alter table public.sistema_carga_alertas enable row level security;
-- Sem policies = deny-all para clientes; acesso apenas via funcoes SECURITY DEFINER.

create or replace function public.sistema_carga_vigia()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare s jsonb;
begin
  s := public.sistema_sob_carga();
  if (s->>'sob_carga')::boolean then
    if not exists (select 1 from public.sistema_carga_alertas where detectado_em > now() - interval '5 minutes') then
      insert into public.sistema_carga_alertas(ativos, ativos_longos, idle_in_tx, amostra)
      values ((s->>'ativos')::int, (s->>'ativos_longos')::int, (s->>'idle_in_tx')::int, s);
    end if;
  end if;
  delete from public.sistema_carga_alertas where detectado_em < now() - interval '30 days';
  return s;
end $$;
revoke all on function public.sistema_carga_vigia() from public;
grant execute on function public.sistema_carga_vigia() to service_role;

create or replace function public.sistema_carga_alertas_recentes(p_horas int default 24)
returns setof public.sistema_carga_alertas
language sql
security definer
set search_path to 'public'
stable
as $$
  select * from public.sistema_carga_alertas
  where public.usuario_e_gestao()
    and detectado_em > now() - make_interval(hours => greatest(p_horas,1))
  order by detectado_em desc
  limit 500;
$$;
revoke all on function public.sistema_carga_alertas_recentes(int) from public;
grant execute on function public.sistema_carga_alertas_recentes(int) to authenticated, service_role;

-- Agendamento do coletor (executado via cron.schedule; job 11 em PROD):
-- select cron.schedule('vigia_carga', '*/2 * * * *', 'select public.sistema_carga_vigia();');
