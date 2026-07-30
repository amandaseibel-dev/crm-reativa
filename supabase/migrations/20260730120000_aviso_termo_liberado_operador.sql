-- P0 OPERACIONAL: avisar o operador responsável quando o termo for LIBERADO pela ADM.
--
-- Gatilho oficial: transição REAL do termo para o status 'TERMO_RECEBIDO_LIBERADO'.
-- A geração do aviso ocorre NO BACKEND (trigger), junto da confirmação da liberação,
-- e não depende do frontend. Cobre TODOS os caminhos de liberação (FilaAdmTermos,
-- PainelAdm e qualquer UPDATE direto), espelhando o padrão já existente em prod
-- (tg_notif_divergencia_cartao): SECURITY DEFINER + guarda de transição + à prova de exceção.
--
-- Idempotência (item 6): o aviso só é gerado quando OLD.status IS DISTINCT FROM NEW.status.
--   * Reexecutar o UPDATE com o mesmo status (status já liberado) -> sem transição -> sem aviso.
--   * Termo REJEITADO e depois LIBERADO de novo -> nova transição real -> novo aviso (permitido).
--
-- Esta migration é IDEMPOTENTE e segura como no-op em produção (tudo IF NOT EXISTS / OR REPLACE).
-- Em staging (clone parcial) ela também recria a estrutura ausente para permitir validação.
-- NÃO altera saldo, acordos, pagamentos, baixas, distribuição, fidelização nem filas.

begin;

-- ---------------------------------------------------------------------------
-- 0) Parity de schema (no-op em prod; cria/ajusta o que falta em staging)
-- ---------------------------------------------------------------------------

-- 0a) termos_acordo (staging não possui; prod já possui -> IF NOT EXISTS = no-op)
create table if not exists public.termos_acordo (
  id uuid primary key default gen_random_uuid(),
  aluno_id text not null,
  aluno_nome text,
  aluno_cpf text,
  operador_email text,
  operador_nome text,
  observacao_operador text,
  arquivo_nome text,
  arquivo_url text,
  status text not null default 'TERMO_ENVIADO_ADM',
  observacao_adm text,
  validado_por text,
  validado_em timestamptz,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now(),
  tipo_assinatura text,
  arquivo_rg_nome text,
  arquivo_rg_url text,
  arquivo_verso_nome text,
  arquivo_verso_url text
);

-- 0b) notificacoes: garantir colunas usadas pelo aviso/leitura (staging está defasado)
alter table public.notificacoes add column if not exists lida boolean not null default false;
alter table public.notificacoes add column if not exists lida_em timestamptz;
alter table public.notificacoes add column if not exists criado_em timestamptz default now();
-- vínculo com o termo (habilita deep-link e auditoria); nullable, não quebra inserts existentes
alter table public.notificacoes add column if not exists termo_id uuid;

-- ---------------------------------------------------------------------------
-- 1) Histórico auditável da liberação + aviso (item 7)
-- ---------------------------------------------------------------------------
create table if not exists public.termo_liberacao_avisos (
  id uuid primary key default gen_random_uuid(),
  termo_id uuid not null,
  aluno_id text,
  caso_id text,                        -- não há caso_id no fluxo atual; reservado
  operador_destino_email text,
  operador_destino_nome text,
  sem_responsavel boolean not null default false,
  liberado_por text,
  liberado_em timestamptz,
  aviso_criado_em timestamptz not null default now(),
  aviso_lido_em timestamptz,
  aviso_lido_por text,
  notificacao_id uuid,
  origem text
);

-- Uma linha por transição REAL de liberação (termo_id + instante de liberação).
create unique index if not exists uq_termo_liberacao_avisos_transicao
  on public.termo_liberacao_avisos (termo_id, liberado_em);

create index if not exists ix_termo_liberacao_avisos_operador
  on public.termo_liberacao_avisos (lower(operador_destino_email));

alter table public.termo_liberacao_avisos enable row level security;

-- Leitura: gestão vê tudo; operador vê apenas os seus. Escrita só via trigger (SECURITY DEFINER).
drop policy if exists tla_select on public.termo_liberacao_avisos;
create policy tla_select on public.termo_liberacao_avisos
  for select to authenticated
  using (
    public.usuario_e_gestao()
    or lower(coalesce(operador_destino_email,'')) = lower(coalesce(public.app_email(), ''))
  );

-- ---------------------------------------------------------------------------
-- 2) Função-trigger: gera o aviso na transição para TERMO_RECEBIDO_LIBERADO
-- ---------------------------------------------------------------------------
create or replace function public.tg_notif_termo_liberado()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  c_status_liberado constant text := 'TERMO_RECEBIDO_LIBERADO';
  -- fila administrativa para casos sem responsável (Amanda ADM + Fernanda)
  c_fila_admin constant text[] := array['cobranca07@aelbra.com.br','cobranca04@aelbra.com.br'];
  v_resp_email text;
  v_resp_nome  text;
  v_nome_aluno text;
  v_dest_email text;
  v_dest_nome  text;
  v_sem_resp   boolean := false;
  v_url        text;
  v_titulo     constant text := 'Termo liberado para continuidade';
  v_msg        text;
  v_liberado_por text;
  v_liberado_em  timestamptz;
  v_notif_id   uuid;
  v_admin text;
begin
  -- Só dispara na transição REAL de status para "liberado" (idempotência).
  if not (tg_op = 'UPDATE'
          and new.status = c_status_liberado
          and old.status is distinct from new.status) then
    return new;
  end if;

  v_liberado_por := coalesce(new.validado_por, public.app_email(), 'ADM');
  v_liberado_em  := coalesce(new.validado_em, now());

  -- Responsável ATUAL pelo aluno (fonte da verdade). Fallback: operador do termo.
  begin
    select a.responsavel_atual_email, a.responsavel_atual_nome, coalesce(a.nome_aluno, a.nome)
      into v_resp_email, v_resp_nome, v_nome_aluno
    from public.alunos a
    where a.id::text = new.aluno_id::text
    limit 1;
  exception when others then
    v_resp_email := null; v_resp_nome := null; v_nome_aluno := null;
  end;

  v_nome_aluno := coalesce(nullif(trim(v_nome_aluno), ''), nullif(trim(new.aluno_nome), ''), 'aluno');

  if coalesce(v_resp_email,'') <> '' then
    v_dest_email := lower(v_resp_email);
    v_dest_nome  := coalesce(v_resp_nome, v_resp_email);
  elsif coalesce(new.operador_email,'') <> '' then
    v_dest_email := lower(new.operador_email);
    v_dest_nome  := coalesce(new.operador_nome, new.operador_email);
  else
    v_sem_resp := true;
  end if;

  -- Deep-link direto para a ficha, posicionando na área de Termo (item 5).
  v_url := '/aluno?id=' || new.aluno_id || '&area=termo';

  -- Mensagem: SEM CPF completo, telefone ou dados financeiros (item 3).
  v_msg := 'O termo do aluno ' || v_nome_aluno
        || ' foi liberado e está pronto para o próximo passo. '
        || 'Ação necessária: liberar o acordo do aluno.';

  begin
    if v_sem_resp then
      -- Aluno sem responsável: NÃO distribui; envia pendência à fila administrativa.
      foreach v_admin in array c_fila_admin loop
        insert into public.notificacoes(
          usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
          aluno_id, termo_id, url_destino, lida, criado_em
        ) values (
          v_admin, v_admin, 'TERMO_LIBERADO_SEM_RESP',
          'Termo liberado sem operador responsável',
          'O termo do aluno ' || v_nome_aluno || ' foi liberado, mas o aluno está SEM responsável. '
            || 'Tratar via fila administrativa. Nenhuma fila foi redistribuída automaticamente.',
          new.aluno_id::text, new.id, v_url, false, now()
        );
      end loop;

      insert into public.termo_liberacao_avisos(
        termo_id, aluno_id, operador_destino_email, operador_destino_nome,
        sem_responsavel, liberado_por, liberado_em, origem
      ) values (
        new.id, new.aluno_id, null, null, true, v_liberado_por, v_liberado_em, 'trigger'
      )
      on conflict (termo_id, liberado_em) do nothing;

      insert into public.aluno_movimentacoes(
        aluno_id, tipo, descricao, status_anterior, status_novo,
        registrado_por_nome, registrado_por_email, registrado_em
      ) values (
        new.aluno_id::text, 'TERMO_LIBERADO',
        'Termo liberado sem operador responsável. Pendência enviada à fila administrativa. Nenhuma fila redistribuída.',
        old.status, new.status, v_liberado_por, v_liberado_por, now()
      );
    else
      -- Aviso SOMENTE ao responsável (item 2).
      insert into public.notificacoes(
        usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
        aluno_id, termo_id, url_destino, lida, criado_em
      ) values (
        v_dest_email, v_dest_nome, 'TERMO_LIBERADO', v_titulo, v_msg,
        new.aluno_id::text, new.id, v_url, false, now()
      )
      returning id into v_notif_id;

      insert into public.termo_liberacao_avisos(
        termo_id, aluno_id, operador_destino_email, operador_destino_nome,
        sem_responsavel, liberado_por, liberado_em, notificacao_id, origem
      ) values (
        new.id, new.aluno_id, v_dest_email, v_dest_nome, false,
        v_liberado_por, v_liberado_em, v_notif_id, 'trigger'
      )
      on conflict (termo_id, liberado_em) do nothing;

      insert into public.aluno_movimentacoes(
        aluno_id, tipo, descricao, status_anterior, status_novo,
        registrado_por_nome, registrado_por_email, registrado_em
      ) values (
        new.aluno_id::text, 'TERMO_LIBERADO',
        'Termo liberado para continuidade e operador notificado (' || v_dest_email || ').',
        old.status, new.status, v_liberado_por, v_liberado_por, now()
      );
    end if;
  exception when others then
    -- Nunca bloquear a liberação do termo por falha no aviso (padrão prod).
    raise notice 'tg_notif_termo_liberado ignorado: %', sqlerrm;
  end;

  return new;
end;
$function$;

drop trigger if exists trg_notif_termo_liberado on public.termos_acordo;
create trigger trg_notif_termo_liberado
  after update of status on public.termos_acordo
  for each row
  execute function public.tg_notif_termo_liberado();

-- ---------------------------------------------------------------------------
-- 4) RLS de notificacoes (item 9): garante isolamento por operador no BACKEND.
--    No-op em produção (RLS + policies já existem lá com esses nomes); em
--    staging (clone com RLS desligado) habilita e cria as políticas faltantes.
-- ---------------------------------------------------------------------------
alter table public.notificacoes enable row level security;

do $rls$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notificacoes' and policyname='notif_select_proprias') then
    create policy notif_select_proprias on public.notificacoes for select to authenticated
      using (lower(usuario_destino_email) = lower(coalesce(auth.email(),'')));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notificacoes' and policyname='notificacoes_select') then
    create policy notificacoes_select on public.notificacoes for select to authenticated
      using (public.usuario_e_gestao() or lower(usuario_destino_email) = lower(coalesce(auth.email(),'')));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notificacoes' and policyname='notif_update_proprias') then
    create policy notif_update_proprias on public.notificacoes for update to authenticated
      using (lower(usuario_destino_email) = lower(coalesce(auth.email(),'')))
      with check (lower(usuario_destino_email) = lower(coalesce(auth.email(),'')));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notificacoes' and policyname='notificacoes_insert') then
    create policy notificacoes_insert on public.notificacoes for insert to authenticated
      with check (public.app_usuario_ativo() and public.usuario_e_gestao());
  end if;
end
$rls$;

commit;
