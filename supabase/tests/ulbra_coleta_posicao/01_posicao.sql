-- Prova da migration 20261109160000 (rodar num Postgres descartável, nunca em produção).
-- Espera: a coluna existe; a função só executa para service_role; o valor é gravado
-- e limpo; e o rollback remove tudo sem tocar nas outras colunas.
\set ON_ERROR_STOP on
begin;
-- 1. coluna e função existem
select 1 / (case when exists (select 1 from information_schema.columns
  where table_schema='public' and table_name='ulbra_sync_estado' and column_name='offset_pendente') then 1 else 0 end);
select 1 / (case when exists (select 1 from information_schema.routines
  where routine_schema='public' and routine_name='ulbra_sync_posicao_gravar') then 1 else 0 end);
-- 2. grants: service_role sim; authenticated, anon e public não
select 1 / (case when has_function_privilege('service_role','public.ulbra_sync_posicao_gravar(integer)','execute') then 1 else 0 end);
select 1 / (case when not has_function_privilege('authenticated','public.ulbra_sync_posicao_gravar(integer)','execute') then 1 else 0 end);
select 1 / (case when not has_function_privilege('anon','public.ulbra_sync_posicao_gravar(integer)','execute') then 1 else 0 end);
-- 3. grava, lê e limpa
insert into public.ulbra_sync_estado (id) values (true) on conflict (id) do nothing;
select public.ulbra_sync_posicao_gravar(123);
select 1 / (case when (select offset_pendente from public.ulbra_sync_estado where id) = 123 then 1 else 0 end);
select public.ulbra_sync_posicao_gravar(null);
select 1 / (case when (select offset_pendente from public.ulbra_sync_estado where id) is null then 1 else 0 end);
rollback;
