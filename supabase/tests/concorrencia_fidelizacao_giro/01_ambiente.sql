-- Ambiente mínimo que as fixtures esperam e que o PGlite já dá de graça.
-- Postgres descartável do CI: papéis do Supabase, schema auth e o stub de cron.
set client_min_messages to warning;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'reativa_responsavel_executor') then
    create role reativa_responsavel_executor nologin;
  end if;
end $$;

create schema if not exists auth;
create schema if not exists internal;

-- pg_cron não existe aqui: as travas dos scripts só exigem que a tabela exista
-- e que o job esteja PAUSADO.
create schema if not exists cron;
create table if not exists cron.job (jobid int primary key, jobname text, active boolean);
insert into cron.job values (8, 'fidelizacao_liberar_vencidos', false),
                            (43, 'reposicao_carteira_minuto', false)
  on conflict (jobid) do nothing;

-- Privilégio padrão de FUNÇÕES como em produção (medido em 13/11/2026).
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
