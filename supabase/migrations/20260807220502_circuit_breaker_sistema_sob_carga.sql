-- DISJUNTOR DE CARGA (pos-incidente 2026-08-07) — parte 1/2: mecanismo.
--
-- Objetivo: barrar consultas pesadas ANTES do banco saturar, mantendo a operacao
-- viva. Melhor uma operacao pesada falhar com "sistema ocupado, tente em instantes"
-- do que a operacao inteira travar.
--
-- Uso (parte 2/2, a fazer): chamar `perform public.exigir_capacidade('<contexto>')`
-- no INICIO de cada RPC pesada (calibragem, nivelamento, saude da carteira,
-- snapshots, analiticas). Aqui vao apenas o sensor e a guarda reutilizavel.

create or replace function public.sistema_sob_carga()
returns jsonb
language sql
security definer
set search_path to 'public','pg_catalog'
stable
as $$
  select jsonb_build_object(
    'sob_carga', (
         count(*) filter (where state='active' and clock_timestamp()-query_start > interval '5 seconds') >= 2
      or count(*) filter (where state='active') >= 25
    ),
    'ativos',        count(*) filter (where state='active'),
    'ativos_longos', count(*) filter (where state='active' and clock_timestamp()-query_start > interval '5 seconds'),
    'idle_in_tx',    count(*) filter (where state='idle in transaction'),
    'medido_em',     clock_timestamp()
  )
  from pg_stat_activity
  where backend_type='client backend' and pid <> pg_backend_pid();
$$;

comment on function public.sistema_sob_carga() is
  'Disjuntor de carga: retorna sob_carga=true quando o banco esta pressionado. Usado para barrar consultas pesadas antes de saturar.';

revoke all on function public.sistema_sob_carga() from public;
grant execute on function public.sistema_sob_carga() to anon, authenticated, service_role;

create or replace function public.exigir_capacidade(p_contexto text default 'operacao pesada')
returns void
language plpgsql
security definer
set search_path to 'public','pg_catalog'
as $$
begin
  if (public.sistema_sob_carga()->>'sob_carga')::boolean then
    raise exception 'Sistema sob carga no momento (%). Tente novamente em instantes.', p_contexto
      using errcode='55006', hint='Aguarde alguns segundos e repita a acao.';
  end if;
end;
$$;

comment on function public.exigir_capacidade(text) is
  'Guarda do disjuntor: chamar no inicio de RPCs pesadas. Aborta com 55006 se sistema_sob_carga.';

revoke all on function public.exigir_capacidade(text) from public;
grant execute on function public.exigir_capacidade(text) to authenticated, service_role;
