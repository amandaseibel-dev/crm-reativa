-- Fila de Acordos: VÍNCULO EXPLÍCITO por acordo_id (substitui a inferência
-- por (aluno_id, qtd_parcelas, valor_total), que NÃO era vínculo seguro).
--
-- Esta migration é IDEMPOTENTE. Rollback em:
--   supabase/rollbacks/20260726160000_fila_acordos_vinculo_acordo_id_down.sql
--
-- Escopo: somente LINK (acordo_id) + consulta/exibição + auditoria + RPCs.
-- NÃO altera responsável do acordo/aluno, pagamentos, parcelas, valores,
-- carteira, distribuição, limite de 500, status da fila ou status do acordo.
-- NÃO faz backfill automático de acordo_id.

------------------------------------------------------------------------------
-- 1) BANCO: coluna de vínculo explícito + FK + índice
------------------------------------------------------------------------------
alter table public.fila_acordos_confirmar
  add column if not exists acordo_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fila_acordos_confirmar_acordo_id_fkey'
  ) then
    alter table public.fila_acordos_confirmar
      add constraint fila_acordos_confirmar_acordo_id_fkey
      foreign key (acordo_id) references public.acordos(id) on delete set null;
  end if;
end $$;

create index if not exists idx_fila_acordos_confirmar_acordo_id
  on public.fila_acordos_confirmar (acordo_id);

------------------------------------------------------------------------------
-- 2) AUDITORIA do vínculo (dados mínimos; SEM CPF/telefone/dados pessoais)
------------------------------------------------------------------------------
create table if not exists public.fila_acordos_vinculo_auditoria (
  id                 uuid primary key default gen_random_uuid(),
  fila_acordo_id     uuid        not null,
  acordo_id_anterior uuid,
  acordo_id_novo     uuid,
  alterado_por       text        not null,          -- e-mail do usuário (auth.email())
  alterado_em        timestamptz not null default now(),
  motivo             text        not null,
  constraint fila_acordos_vinculo_aud_motivo_nao_vazio check (btrim(motivo) <> '')
);

create index if not exists idx_fila_acordos_vinculo_aud_fila
  on public.fila_acordos_vinculo_auditoria (fila_acordo_id);

-- LGPD / privilégio mínimo: RLS liga e NENHUMA policy p/ anon/authenticated
-- (bloqueio total por RLS). Só é escrita pela RPC SECURITY DEFINER (owner
-- postgres, que faz bypass de RLS). service_role preservado (bypassa RLS).
alter table public.fila_acordos_vinculo_auditoria enable row level security;
revoke all on public.fila_acordos_vinculo_auditoria from anon, authenticated;

------------------------------------------------------------------------------
-- 3) Allowlist de quem pode vincular (Amanda gestora, Amanda ADM, Fernanda)
------------------------------------------------------------------------------
create or replace function public.fila_acordos_pode_vincular(p_email text)
  returns boolean
  language sql
  immutable
as $function$
  select lower(coalesce(p_email, '')) in (
    'amanda.seibel@aelbra.com.br',  -- Amanda (gestão de dados)
    'cobranca07@aelbra.com.br',     -- Amanda ADM
    'cobranca04@aelbra.com.br'      -- Fernanda (supervisão)
  );
$function$;

------------------------------------------------------------------------------
-- 4) GUARDA: acordo_id só muda via RPC autorizada (ou roles internas).
--    Bloqueia UPDATE direto de acordo_id por authenticated/anon SEM alterar
--    grants existentes. Não afeta updates de status_confirmacao/operador_email.
------------------------------------------------------------------------------
create or replace function public.fila_acordos_guard_acordo_id()
  returns trigger
  language plpgsql
as $function$
begin
  if NEW.acordo_id is distinct from OLD.acordo_id then
    if current_user not in ('postgres', 'service_role', 'supabase_admin')
       and coalesce(current_setting('app.fila_vinculo_ok', true), '') <> 'on' then
      raise exception
        'Alteração de acordo_id só é permitida via public.fila_vincular_acordo (perfil autorizado).'
        using errcode = '42501';
    end if;
  end if;
  return NEW;
end $function$;

drop trigger if exists trg_fila_acordos_guard_acordo_id on public.fila_acordos_confirmar;
create trigger trg_fila_acordos_guard_acordo_id
  before update on public.fila_acordos_confirmar
  for each row
  execute function public.fila_acordos_guard_acordo_id();

------------------------------------------------------------------------------
-- 5) RPC: vincular / trocar acordo_id (SECURITY DEFINER)
------------------------------------------------------------------------------
create or replace function public.fila_vincular_acordo(
    p_fila_id   uuid,
    p_acordo_id uuid,
    p_motivo    text
  )
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_email       text := lower(auth.email());
  v_motivo      text := btrim(coalesce(p_motivo, ''));
  v_old         uuid;
  v_nome        text;
  v_email_resp  text;
begin
  -- usuário ativo e autorizado
  if not public.fila_acordos_pode_vincular(v_email) then
    raise exception 'Usuário % não autorizado a vincular acordos.', coalesce(v_email, '(anônimo)')
      using errcode = '42501';
  end if;
  -- motivo obrigatório
  if v_motivo = '' then
    raise exception 'Motivo é obrigatório para vincular/trocar o acordo.'
      using errcode = '22023';
  end if;
  if p_acordo_id is null then
    raise exception 'acordo_id é obrigatório.' using errcode = '22023';
  end if;

  -- trava a linha da fila (impede duplo vínculo simultâneo) e valida existência
  select acordo_id into v_old
  from public.fila_acordos_confirmar
  where id = p_fila_id
  for update;
  if not found then
    raise exception 'Linha da fila % inexistente.', p_fila_id using errcode = 'P0002';
  end if;

  -- valida existência do acordo
  if not exists (select 1 from public.acordos where id = p_acordo_id) then
    raise exception 'Acordo % inexistente.', p_acordo_id using errcode = 'P0002';
  end if;

  -- habilita a alteração de acordo_id apenas nesta transação
  perform set_config('app.fila_vinculo_ok', 'on', true);
  update public.fila_acordos_confirmar
     set acordo_id = p_acordo_id
   where id = p_fila_id;                    -- exatamente 1 linha (PK)
  perform set_config('app.fila_vinculo_ok', 'off', true);

  -- auditoria na MESMA transação
  insert into public.fila_acordos_vinculo_auditoria
    (fila_acordo_id, acordo_id_anterior, acordo_id_novo, alterado_por, motivo)
  values
    (p_fila_id, v_old, p_acordo_id, v_email, v_motivo);

  -- estado final (responsável específico do acordo agora vinculado)
  select operador_responsavel_nome, operador_responsavel_email
    into v_nome, v_email_resp
  from public.acordos
  where id = p_acordo_id;

  return jsonb_build_object(
    'fila_id',                    p_fila_id,
    'acordo_id',                  p_acordo_id,
    'acordo_id_anterior',         v_old,
    'operador_responsavel_nome',  v_nome,
    'operador_responsavel_email', v_email_resp
  );
end $function$;

revoke all on function public.fila_vincular_acordo(uuid, uuid, text) from public, anon;
grant execute on function public.fila_vincular_acordo(uuid, uuid, text) to authenticated, service_role;

------------------------------------------------------------------------------
-- 6) RPC de LEITURA: responsável ESPECÍFICO via acordo_id (somente campos mínimos)
--    Usa SOMENTE fila.acordo_id -> acordos. Não infere por nome/CPF/valor/
--    parcelas/acordo_base. Distingue NÃO vinculado de SEM responsável
--    (não esconde erro como "Sem responsável").
------------------------------------------------------------------------------
create or replace function public.fila_acordos_responsavel()
  returns table (
    fila_id                     uuid,
    acordo_id                   uuid,
    vinculo                     text,   -- 'NAO_VINCULADO' | 'SEM_RESPONSAVEL' | 'OK'
    operador_responsavel_nome   text,
    operador_responsavel_email  text
  )
  language sql
  stable
  security invoker
  set search_path to 'public'
as $function$
  select
    f.id,
    f.acordo_id,
    case
      when f.acordo_id is null then 'NAO_VINCULADO'
      when coalesce(nullif(btrim(a.operador_responsavel_nome), ''),
                    nullif(btrim(a.operador_responsavel_email), '')) is null then 'SEM_RESPONSAVEL'
      else 'OK'
    end as vinculo,
    a.operador_responsavel_nome,
    a.operador_responsavel_email
  from public.fila_acordos_confirmar f
  left join public.acordos a on a.id = f.acordo_id;
$function$;

revoke all on function public.fila_acordos_responsavel() from public, anon;
grant execute on function public.fila_acordos_responsavel() to authenticated, service_role;

------------------------------------------------------------------------------
-- 7) RPC de BUSCA de acordo por identificador SEGURO (numero_acordo, único).
--    Só retorna resultado para perfis autorizados; campos mínimos, sem CPF.
------------------------------------------------------------------------------
create or replace function public.fila_buscar_acordo(p_numero bigint)
  returns table (
    acordo_id                   uuid,
    numero_acordo               bigint,
    qtd_parcelas                integer,
    valor_total                 numeric,
    operador_responsavel_nome   text,
    operador_responsavel_email  text
  )
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select a.id, a.numero_acordo, a.qtd_parcelas, a.valor_total,
         a.operador_responsavel_nome, a.operador_responsavel_email
  from public.acordos a
  where public.fila_acordos_pode_vincular(lower(auth.email()))
    and a.numero_acordo = p_numero
  limit 20;
$function$;

revoke all on function public.fila_buscar_acordo(bigint) from public, anon;
grant execute on function public.fila_buscar_acordo(bigint) to authenticated, service_role;
