-- PREPARAÇÃO (postgres) — SOMENTE banco descartável de CI. Papel LOGIN com BYPASSRLS, sem bypass de manutenção.
-- Prova a TRIGGER isoladamente (RLS não interfere). Não é papel de produção e não é concedido a usuários.
\set ON_ERROR_STOP on
do $$ begin
  if not exists (select 1 from pg_roles where rolname='app_teste_rls') then
    create role app_teste_rls login bypassrls password 'app_teste_rls_pw'; end if;
end $$;
grant usage on schema public to app_teste_rls;
grant select, update on public.aluno_movimentacoes to app_teste_rls;
grant select on public.usuarios to app_teste_rls;
