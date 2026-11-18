-- REPRODUCAO do schema auth do Supabase para o banco descartavel do CI.
-- auth.jwt() le as claims do PostgREST (request.jwt.claims); auth.uid() = claim sub.
-- Diferenca declarada: o Supabase real le as claims assinadas pelo gateway; aqui as
-- claims sao definidas pelo teste (pg_temp.como), sem assinatura.
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;
create or replace function auth.email() returns text language sql stable as $$
  select nullif(lower(auth.jwt() ->> 'email'), '')
$$;
