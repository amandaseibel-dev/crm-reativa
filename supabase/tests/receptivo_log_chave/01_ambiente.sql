-- AMBIENTE de teste: reproduz SO o que a chave do log usa (tabelas, indice e
-- a RPC antes da migration). Nao carrega dados pessoais: e-mails e telefones sao ficticios.
\set ON_ERROR_STOP on

do $roles$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $roles$;
grant usage on schema public to anon, authenticated, service_role;

create table public.whatsapp_conversas (
  id                uuid primary key default gen_random_uuid(),
  telefone_e164     text not null,
  responsavel_email text,
  responsavel_desde timestamptz,
  aguardando_resposta boolean not null default false
);

create table public.fila_receptivo (
  email             text primary key,
  nome              text,
  atendimentos_hoje integer not null default 0,
  data_referencia   date,
  ultimo_atendimento timestamptz,
  online_em         timestamptz
);

-- log como esta em producao (195 linhas; sem conversa_id)
create table public.receptivo_atendimentos_log (
  id                uuid        primary key default gen_random_uuid(),
  operador_email    text        not null,
  operador_nome     text,
  atendido_em       timestamptz not null default now(),
  responsavel_desde timestamptz,
  fonte             text        not null default 'MANUAL',
  constraint receptivo_atendimentos_log_fonte_check check (fonte in ('MANUAL', 'WHATSAPP'))
);
create index idx_receptivo_log_atendido_em on public.receptivo_atendimentos_log (atendido_em);
create index idx_receptivo_log_operador    on public.receptivo_atendimentos_log (operador_email);
create unique index uq_receptivo_log_operador_ciclo
  on public.receptivo_atendimentos_log (operador_email, responsavel_desde)
  where responsavel_desde is not null;

-- RPC antes da migration (alvo de ON CONFLICT na chave antiga), como na cota 10
create or replace function public.fila_receptivo_registrar_atendimento(
  p_email text, p_conversa_id uuid default null::uuid)
returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_nome text; v_resp_desde timestamptz; v_rows integer;
begin
  if p_conversa_id is not null then
    select responsavel_desde into v_resp_desde from public.whatsapp_conversas
     where id = p_conversa_id and lower(responsavel_email) = lower(p_email);
    if not found or v_resp_desde is null then return false; end if;
  end if;
  select nome into v_nome from public.fila_receptivo where email = p_email;
  if not found then return false; end if;
  insert into public.receptivo_atendimentos_log
    (operador_email, operador_nome, atendido_em, responsavel_desde, fonte)
  values (p_email, v_nome, now(), v_resp_desde,
          case when p_conversa_id is not null then 'WHATSAPP' else 'MANUAL' end)
  on conflict (operador_email, responsavel_desde) where responsavel_desde is not null
  do nothing;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    update public.fila_receptivo
       set atendimentos_hoje = case when data_referencia = v_hoje then atendimentos_hoje + 1 else 1 end,
           data_referencia = v_hoje, ultimo_atendimento = now(), online_em = now()
     where email = p_email;
  end if;
  return v_rows > 0;
end;
$function$;
revoke all on function public.fila_receptivo_registrar_atendimento(text, uuid) from public, anon, authenticated;
grant execute on function public.fila_receptivo_registrar_atendimento(text, uuid) to service_role;

-- operadores ficticios
insert into public.fila_receptivo (email, nome, atendimentos_hoje, data_referencia) values
  ('op_a@test.local','Operador A',0,null),
  ('op_b@test.local','Operador B',0,null);

-- HISTORICO antes da migration (linhas que nao podem ser alteradas)
--   h1: WHATSAPP de um ciclo que casa com UMA conversa atual  -> recebe conversa_id
--   h2: WHATSAPP de um ciclo que casa com DUAS conversas atuais -> fica NULL (ambiguo)
--   h3: WHATSAPP sem conversa atual compativel -> fica NULL
--   h4: MANUAL -> fica NULL
insert into public.whatsapp_conversas (id, telefone_e164, responsavel_email, responsavel_desde)
values ('00000000-0000-0000-0000-00000000c001','5551900000001','op_a@test.local', timestamptz '2026-11-01 10:00:00-03'),
       ('00000000-0000-0000-0000-00000000c002','5551900000002','op_b@test.local', timestamptz '2026-11-02 10:00:00-03'),
       ('00000000-0000-0000-0000-00000000c003','5551900000003','op_b@test.local', timestamptz '2026-11-03 10:00:00-03'),
       ('00000000-0000-0000-0000-00000000c004','5551900000004','op_b@test.local', timestamptz '2026-11-03 10:00:00-03');
insert into public.receptivo_atendimentos_log (operador_email, operador_nome, atendido_em, responsavel_desde, fonte) values
  ('op_a@test.local','Operador A', timestamptz '2026-11-01 11:00:00-03', timestamptz '2026-11-01 10:00:00-03', 'WHATSAPP'), -- h1
  ('op_b@test.local','Operador B', timestamptz '2026-11-03 11:00:00-03', timestamptz '2026-11-03 10:00:00-03', 'WHATSAPP'), -- h2 (c003 e c004 casam)
  ('op_b@test.local','Operador B', timestamptz '2026-10-01 11:00:00-03', timestamptz '2026-10-01 09:00:00-03', 'WHATSAPP'), -- h3
  ('op_b@test.local','Operador B', timestamptz '2026-10-02 11:00:00-03', null,                                  'MANUAL');   -- h4

-- MARCADOR da pre-condicao: a cota 10 (20261111150000) define esta funcao.
-- Aqui o ambiente so a declara; a cota completa e testada na suite dela.
create or replace function public.whatsapp_cadencia_sem_limite_individual(p_email text)
returns boolean language sql stable as $$ select false $$;
