-- AMBIENTE DESCARTÁVEL: stubs só das dependências externas da RPC.
-- Não é produção. A própria função de resumo NÃO é stubada.
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
-- auth.jwt() lê as claims que cada caso define com set_config.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
create table public.usuarios (
  email text primary key,
  perfil text not null,
  ativo boolean not null
);
-- Colunas da view que a RPC lê. A view real tem mais colunas; só estas importam aqui.
create table public.efetividade_caixa_origem (
  pagamento_id uuid primary key default gen_random_uuid(),
  valor_pago numeric not null,
  data_pagamento date,
  confianca text,
  status_conciliacao text,
  semestre_origem text
);
-- Classificador oficial 2026/2: stub com a assinatura e as colunas que a RPC usa.
create or replace function public.carteira_2026_2_classificar()
returns table(titulo_id uuid, valor_original numeric, saldo numeric, faixa text,
              acordo_id uuid, acordo_estado text)
language sql stable as $$
  select null::uuid, null::numeric, null::numeric, null::text, null::uuid, null::text where false
$$;
-- Mesma definição de produção (lista de e-mails de gestão, sem checar ativo).
create or replace function public.usuario_e_gestao() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br');
$$;
-- Fotografia 2026/1 (stub): só o bloco que a RPC lê, situacoes.entrou.
create or replace function public.carteira_efetividade_ler(p_bloco text, p_ano text, p_semestre text)
returns jsonb language sql stable as $$
  select jsonb_build_object('situacoes', jsonb_build_object(
           'entrou', jsonb_build_object('valor', 1000, 'titulos', 3)))
$$;
