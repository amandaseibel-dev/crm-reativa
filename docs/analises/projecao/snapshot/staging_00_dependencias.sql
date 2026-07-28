-- =============================================================================
-- STAGING ONLY — Recriação das dependências mínimas da Projeção Hora a Hora
-- Projeto: crm-reativa-staging (edlzlfbstshojxrudwaa)
-- NÃO É MIGRATION DE PRODUÇÃO. Estes objetos já existem em prod; aqui são
-- recriados só para permitir testar o snapshot em staging.
-- Fonte fiel das definições: docs/analises/projecao/raw-prod/ (extraído read-only).
-- =============================================================================

-- Extensões usadas pelo pacote projeção (idempotente)
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tabelas mínimas lidas por projecao_dashboard (subconjunto fiel de colunas)
-- ---------------------------------------------------------------------------
create table if not exists public.pagamentos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid,
  cpf text,
  data_pagamento date,
  valor_pago numeric,
  valor_honorario numeric default 0,
  tipo_pagamento text,
  operador_email text,
  operador_nome text,
  aluno_nome text,
  retroativo boolean not null default false,
  titulo_numero text,
  numero_parcela_completo text,
  importacao_id uuid,
  created_at timestamp without time zone default now()
);

create table if not exists public.metas_projecao (
  id uuid primary key default gen_random_uuid(),
  mes_referencia text not null unique,
  meta_recuperacao numeric not null default 0,
  meta_honorario numeric not null default 0,
  meta_operacional numeric not null default 0,
  meta_unidades numeric not null default 0,
  m1_valor numeric not null default 0, m1_percentual numeric not null default 0,
  m2_valor numeric not null default 0, m2_percentual numeric not null default 0,
  m3_valor numeric not null default 0, m3_percentual numeric not null default 0,
  m4_valor numeric not null default 0, m4_percentual numeric not null default 0,
  atualizado_por text,
  atualizado_em timestamp with time zone not null default now()
);

-- Índice sargável de data (apoia os filtros por período reescritos como range)
create index if not exists idx_pagamentos_data_pagamento on public.pagamentos (data_pagamento);
create index if not exists idx_pagamentos_operador_email on public.pagamentos (lower(operador_email));

-- ---------------------------------------------------------------------------
-- Função auxiliar de guard (cópia fiel de prod, OID via pg_get_functiondef)
-- ---------------------------------------------------------------------------
create or replace function public.perfil_do_usuario_atual()
 returns text
 language sql
 stable security definer
 set search_path to 'public', 'auth'
as $function$
  select u.perfil from public.usuarios u
  where lower(u.email) = lower(auth.email()) and u.ativo limit 1;
$function$;
