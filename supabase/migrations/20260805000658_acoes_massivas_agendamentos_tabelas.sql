-- ============================================================================
-- Agendamento automático das Ações Massivas — tabelas
-- Nasce com RLS ligada, sem PUBLIC/anon, gestão-only, índices e idempotência.
-- Escrita só via RPCs SECURITY DEFINER (postgres); authenticated só SELECT (gestão).
-- ============================================================================

create table if not exists public.acoes_massivas_agendamentos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  finalidade text not null,
  canal text not null check (canal in ('WHATSAPP','EMAIL')),
  mensagem text,
  filtros jsonb not null default '{}'::jsonb,
  programado_para timestamptz not null,
  status text not null default 'AGENDADO'
    check (status in ('RASCUNHO','AGENDADO','PROCESSANDO','CONCLUIDO','CONCLUIDO_COM_ERROS','CANCELADO','FALHOU')),
  criado_por text,
  criado_em timestamptz not null default now(),
  autorizado_por text,
  autorizado_em timestamptz,
  cancelado_por text,
  cancelado_em timestamptz,
  motivo_cancelamento text,
  executado_por text,               -- 'SISTEMA'
  executor_tecnico text,            -- service_role / postgres / role técnica
  iniciado_em timestamptz,
  finalizado_em timestamptz,
  quantidade_previa int,
  quantidade_elegivel_execucao int,
  quantidade_excluida_revalidacao int,
  quantidade_enviada int,
  quantidade_erros int,
  erro_execucao text,
  chave_idempotencia text not null unique,
  tentativa int not null default 0,
  proxima_tentativa_em timestamptz,
  historico jsonb not null default '[]'::jsonb,   -- reagendamentos/status (auditoria)
  atualizado_em timestamptz not null default now()
);

create index if not exists ix_amag_status on public.acoes_massivas_agendamentos(status);
create index if not exists ix_amag_programado on public.acoes_massivas_agendamentos(programado_para);
create index if not exists ix_amag_due on public.acoes_massivas_agendamentos(status, programado_para)
  where status = 'AGENDADO';

-- Destinatários (log por aluno). Idempotência campanha+aluno+canal+finalidade.
create table if not exists public.acoes_massivas_destinatarios (
  id uuid primary key default gen_random_uuid(),
  campanha_id uuid not null references public.acoes_massivas_agendamentos(id) on delete cascade,
  aluno_id text not null,
  canal text not null,
  finalidade text not null,
  status text not null check (status in ('ENVIADO','EXCLUIDO','ERRO')),
  motivo_exclusao text,
  enviado_em timestamptz,
  erro text,
  chave_idempotencia text not null,
  criado_em timestamptz not null default now(),
  unique (campanha_id, aluno_id, canal, finalidade)
);
create index if not exists ix_amdest_campanha on public.acoes_massivas_destinatarios(campanha_id);

-- Auditoria de alterações (append em historico) no agendamento.
create or replace function public.trg_acoes_massivas_agendamentos_audit()
 returns trigger language plpgsql set search_path to 'public' as $$
begin
  new.atualizado_em := now();
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.historico := coalesce(old.historico,'[]'::jsonb) || jsonb_build_object(
      'em', now(), 'de', old.status, 'para', new.status,
      'por', coalesce(auth.jwt() ->> 'email', session_user));
  end if;
  return new;
end $$;

drop trigger if exists trg_amag_audit on public.acoes_massivas_agendamentos;
create trigger trg_amag_audit before update on public.acoes_massivas_agendamentos
  for each row execute function public.trg_acoes_massivas_agendamentos_audit();

-- RLS: gestão-only para SELECT; escrita só via RPC SECURITY DEFINER (postgres).
alter table public.acoes_massivas_agendamentos enable row level security;
alter table public.acoes_massivas_destinatarios enable row level security;

create policy amag_select_gestao on public.acoes_massivas_agendamentos
  for select to authenticated using (app_usuario_ativo() and usuario_e_gestao());
create policy amdest_select_gestao on public.acoes_massivas_destinatarios
  for select to authenticated using (app_usuario_ativo() and usuario_e_gestao());

-- Grants: sem anon; authenticated só SELECT (gestão via RLS). service_role/postgres: acesso técnico.
revoke all on public.acoes_massivas_agendamentos  from public, anon;
revoke all on public.acoes_massivas_destinatarios from public, anon;
revoke insert, update, delete, truncate on public.acoes_massivas_agendamentos  from authenticated;
revoke insert, update, delete, truncate on public.acoes_massivas_destinatarios from authenticated;
grant select on public.acoes_massivas_agendamentos  to authenticated;
grant select on public.acoes_massivas_destinatarios to authenticated;
grant all on public.acoes_massivas_agendamentos  to service_role;
grant all on public.acoes_massivas_destinatarios to service_role;
