-- BANCADA DA RODADA INCREMENTAL — estrutura de produção de 21/10/2026.
--
-- ESCOPO DECLARADO, para não haver dúvida sobre o que está provado:
--
-- O que estes testes exercitam é o ENVELOPE DE SEGURANÇA da rodada -- lote,
-- orçamento de tempo, fronteira de 14/09, decisão da gestão, espera de quem já
-- falhou, isolamento de erro, registro e indicadores. A DECISÃO FINANCEIRA é
-- toda de `pagamento_conciliar_um`, que tem 24.824 caracteres em produção e
-- AQUI É DUBLADO de forma controlada. Isso é proposital: o contrato que a
-- rodada tem com o motor é "chamo uma vez por pagamento, leio `status` e
-- `baixou`, sobrevivo ao seu erro" -- e é esse contrato que se testa.
-- Nenhum teste daqui afirma que a regra de baixa está correta.
--
-- `sistema_sob_carga()` entra com o CORPO EXATO de produção, conferido por md5.
--
-- NENHUM DADO REAL: CPF, nome e e-mail são sintéticos.

-- Sem pgcrypto: a bancada nao usa gen_random_uuid(), todo id vem do teste.

-- Os papeis do Supabase. A migration faz revoke/grant neles, entao precisam
-- existir para que o teste exercite as permissoes de verdade.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  -- BYPASSRLS como em producao (pg_roles.rolbypassrls = true, conferido em 21/10):
  -- sem isto a bancada nao reproduziria a leitura do service_role com RLS ligado.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;

create table if not exists public.alunos (
  id uuid primary key,
  nome text, cpf text, saldo_total numeric default 0
);

create table if not exists public.pagamentos (
  id uuid primary key,
  aluno_id uuid, cpf text, data_pagamento date, valor_pago numeric,
  created_at timestamptz default now(),
  status_conciliacao text, conciliacao_motivo text, conciliacao_em timestamptz,
  origem_vinculo text, origem_vinculo_ref text
);

create table if not exists public.fila_pagamento_sem_vinculo (
  id bigserial primary key,
  pagamento_id uuid, boleto text, data_pagamento date, valor_pago numeric,
  motivo text, detectado_em timestamptz default now(),
  decisao text, decidido_por text, decidido_em timestamptz,
  status_conciliacao text,
  consulta_portador_em timestamptz, consulta_estrutura_resultado text,
  primeira_tentativa_em timestamptz, ultima_tentativa_em timestamptz,
  quantidade_tentativas integer, conclusao text
);

create table if not exists public.fluxo_pagamentos_execucoes (
  id bigserial primary key,
  rodou_em timestamptz not null default now(),
  origem text, carteira_antes numeric, carteira_depois numeric,
  resultado jsonb, erro text
);

create table if not exists public.fluxo_pagamentos_config (
  etapa text primary key, ligado boolean not null default false
);

create schema if not exists auth;

-- Stub da bancada: devolve as claims do GUC, '{}' quando não há.
create or replace function auth.jwt() returns jsonb
 language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- CORPO EXATO DE PRODUÇÃO.
CREATE OR REPLACE FUNCTION public.sistema_sob_carga()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- CORPO EXATO DE PRODUÇÃO.
CREATE OR REPLACE FUNCTION public.calibragem_e_gestao()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_email = '' then return false; end if;
  if v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then return true; end if;
  return false;
end; $function$;

-- ===========================================================================
-- DUBLÊS CONTROLADOS. Marcados como tal, de propósito.
-- ===========================================================================

-- Painel de controle do dublê do motor: o teste diz como ele deve reagir.
create table if not exists public._dub_motor (
  pagamento_id uuid primary key,
  status text default 'AGUARDANDO_ACORDO',
  baixou boolean default false,
  levanta text,
  dorme_ms int default 0
);
-- Registro de CADA chamada: é assim que se prova "uma vez por pagamento".
create table if not exists public._dub_chamadas (
  n bigserial primary key, pagamento_id uuid, aplicar boolean, em timestamptz default clock_timestamp()
);

create or replace function public.pagamento_conciliar_um(p_pagamento_id uuid, p_aplicar boolean)
returns jsonb language plpgsql volatile as $$
declare d record;
begin
  insert into public._dub_chamadas (pagamento_id, aplicar) values (p_pagamento_id, p_aplicar);
  select * into d from public._dub_motor where pagamento_id = p_pagamento_id;
  if d.dorme_ms is not null and d.dorme_ms > 0 then
    perform pg_sleep(d.dorme_ms / 1000.0);
  end if;
  if d.levanta is not null then
    raise exception '%', d.levanta;
  end if;
  if p_aplicar then
    update public.pagamentos
       set status_conciliacao = coalesce(d.status, 'AGUARDANDO_ACORDO'),
           conciliacao_em = now()
     where id = p_pagamento_id;
    update public.fila_pagamento_sem_vinculo
       set quantidade_tentativas = coalesce(quantidade_tentativas,0) + 1,
           ultima_tentativa_em = now()
     where pagamento_id = p_pagamento_id and decisao is null;
  end if;
  return jsonb_build_object('status', coalesce(d.status,'AGUARDANDO_ACORDO'),
                            'baixou', coalesce(d.baixou,false));
end; $$;

-- Dublê dos indicadores, com contador e interruptor de falha.
create table if not exists public._dub_indicadores (
  n bigserial primary key, em timestamptz default clock_timestamp()
);
create table if not exists public._dub_indicadores_falha (falhar boolean);

create or replace function public.atualizar_snapshots_gerenciais(p_ano int)
returns void language plpgsql volatile as $$
begin
  if exists (select 1 from public._dub_indicadores_falha where falhar) then
    raise exception 'snapshot gerencial recusou (dublê)';
  end if;
  insert into public._dub_indicadores default values;
end; $$;

-- CANÁRIO. A varredura global que derrubou o banco em 24/09. Se a rodada
-- incremental chamar isto, o teste QUEBRA -- é a prova de que ela não chama.
create or replace function public.parcelas_amarrar_boleto()
returns jsonb language plpgsql volatile as $$
begin
  raise exception 'CANARIO: parcelas_amarrar_boleto foi chamada pela rodada incremental';
end; $$;

-- ===========================================================================
-- SEGUNDA CAMADA — o que as migrations corretivas de 21/10 precisam exercitar.
-- ===========================================================================

-- Tabelas financeiras que o dublê SUJO vai tentar escrever. A prova de que a
-- prévia não as toca exige que elas existam e tenham conteúdo.
create table if not exists public.parcelas (
  id uuid primary key, acordo_id uuid, numero int, valor numeric,
  vencimento date, status text, pago_em date
);
create table if not exists public.acordos (
  id uuid primary key, aluno_id uuid, status text, saldo numeric
);
create table if not exists public.auditoria (
  id bigserial primary key, usuario text, acao text, tabela_afetada text,
  registro_id text, detalhes jsonb, criado_em timestamptz default now()
);
create table if not exists public.baixas_pagamento (
  id uuid primary key, aluno_id uuid, valor_pago numeric,
  status_baixa text, baixado_em timestamptz, baixado_por_email text
);

-- Onde o GATILHO deixa rastro. É assim que se prova que efeito indireto
-- também é desfeito pela prévia.
create table if not exists public._efeito_indireto (
  n bigserial primary key, pagamento_id uuid, em timestamptz default clock_timestamp()
);

create or replace function public._trg_efeito_indireto()
returns trigger language plpgsql as $$
begin
  insert into public._efeito_indireto (pagamento_id) values (NEW.id);
  return NEW;
end; $$;

drop trigger if exists trg_efeito_indireto on public.pagamentos;
create trigger trg_efeito_indireto
  after update on public.pagamentos
  for each row execute function public._trg_efeito_indireto();

-- CORPO EXATO DE PRODUÇÃO. É o portão da política de RLS do monitor.
CREATE OR REPLACE FUNCTION public.usuario_e_gestao()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$function$;

-- O RLS real da trilha de monitoramento: UMA política, só SELECT, só gestão.
alter table public.fluxo_pagamentos_execucoes enable row level security;
drop policy if exists fluxo_exec_gestao on public.fluxo_pagamentos_execucoes;
create policy fluxo_exec_gestao on public.fluxo_pagamentos_execucoes
  for select to authenticated
  using (public.usuario_e_gestao());

-- O default do schema public, que é a CAUSA do defeito corrigido: toda tabela
-- e view nova herda arwdDxtm para authenticated. Sem isto a bancada não
-- reproduziria o problema e o teste passaria por vacuidade.
grant all on public.fluxo_pagamentos_execucoes to authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- DUBLÊ SUJO: escreve em TUDO o que pode, de propósito. Serve para provar que
-- a prévia desfaz, em vez de provar que o motor é educado.
-- ---------------------------------------------------------------------------
create table if not exists public._dub_sujo (ligado boolean);

create or replace function public.pagamento_conciliar_um(p_pagamento_id uuid, p_aplicar boolean)
returns jsonb language plpgsql volatile as $$
declare d record;
begin
  insert into public._dub_chamadas (pagamento_id, aplicar) values (p_pagamento_id, p_aplicar);
  select * into d from public._dub_motor where pagamento_id = p_pagamento_id;
  if d.dorme_ms is not null and d.dorme_ms > 0 then
    perform pg_sleep(d.dorme_ms / 1000.0);
  end if;
  if d.levanta is not null then
    raise exception '%', d.levanta;
  end if;

  -- MODO SUJO: ignora p_aplicar e escreve em seis tabelas, inclusive
  -- financeiras, e dispara o gatilho de `pagamentos`.
  if exists (select 1 from public._dub_sujo where ligado) then
    update public.pagamentos set status_conciliacao = 'SUJO_ESCREVEU',
                                 conciliacao_motivo = 'o dublê sujo passou por aqui'
     where id = p_pagamento_id;
    update public.parcelas set status = 'PAGO', pago_em = current_date;
    update public.acordos set status = 'QUITADO', saldo = 0;
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id)
      values ('dublê sujo','ESCRITA_INDEVIDA','pagamentos', p_pagamento_id::text);
    insert into public.baixas_pagamento (id, aluno_id, valor_pago, status_baixa, baixado_em, baixado_por_email)
      values (gen_random_uuid(), null, 1, 'BAIXADO', now(), 'dublê sujo')
      on conflict do nothing;
    insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo)
      values (p_pagamento_id, 'enfileirado pelo dublê sujo');
    update public.fila_pagamento_sem_vinculo
       set quantidade_tentativas = coalesce(quantidade_tentativas,0) + 1,
           ultima_tentativa_em = now()
     where pagamento_id = p_pagamento_id and decisao is null;
    return jsonb_build_object('status', coalesce(d.status,'AGUARDANDO_ACORDO'),
                              'baixou', coalesce(d.baixou,false));
  end if;

  if p_aplicar then
    update public.pagamentos
       set status_conciliacao = coalesce(d.status, 'AGUARDANDO_ACORDO'),
           conciliacao_em = now()
     where id = p_pagamento_id;
    update public.fila_pagamento_sem_vinculo
       set quantidade_tentativas = coalesce(quantidade_tentativas,0) + 1,
           ultima_tentativa_em = now()
     where pagamento_id = p_pagamento_id and decisao is null;
  end if;
  return jsonb_build_object('status', coalesce(d.status,'AGUARDANDO_ACORDO'),
                            'baixou', coalesce(d.baixou,false));
end; $$;
