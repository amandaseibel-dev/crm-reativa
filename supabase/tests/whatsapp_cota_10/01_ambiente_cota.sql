-- AMBIENTE COMPLEMENTAR — COTA 10 POR OPERADOR (20261111150000)
--
-- Roda num Postgres descartável do CI. NÃO fala com produção, NÃO usa
-- segredo.
--
-- ORDEM DE EXECUÇÃO (ver job no ci.yml):
--   whatsapp_continuidade_v2/01_ambiente.sql
--   -> migration v2 (20261109120000)          a cota 10 exige a v2
--   -> ESTE arquivo
--   -> migration cota 10 (duas vezes: idempotência)
--   -> 03_casos_cota.sql -> 04 corrida real -> rollback -> 05_rollback.sql
--
-- O que este arquivo acrescenta ao ambiente da v2, tudo com a forma de
-- produção lida em 11/11/2026:
--   * whatsapp_conversas.responsavel_* (o ciclo de responsabilidade)
--   * public.usuarios (email, nome, perfil, ativo)
--   * stubs de app_email / app_usuario_ativo / usuario_e_gestao lendo o
--     e-mail de teste.email, como auth.jwt() já faz no ambiente da v2
--   * whatsapp_cadencia_consumo e whatsapp_canal_cadencia_salvar com o
--     corpo e os grants de produção
--   * a fila do receptivo como em produção: fila_receptivo,
--     receptivo_atendimentos_log + uq_receptivo_log_operador_ciclo,
--     fila_receptivo_marcar_atendido, usuario_e_gestao_fila, auth.email()
--   * o gatilho real trg_whatsapp_aguardando (aguardando_resposta), porque
--     o trigger novo precisa disparar ANTES dele
--   * os três canais reais, com os mesmos ids e limites (a migration tem
--     pré-condição sobre eles e o rollback restaura por id)

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Schema que a cota usa
-- ---------------------------------------------------------------------------
alter table public.whatsapp_conversas
  add column if not exists responsavel_email text,
  add column if not exists responsavel_nome  text,
  add column if not exists responsavel_desde timestamptz,
  add column if not exists aguardando_resposta boolean not null default false,
  add column if not exists aguardando_desde timestamptz,
  add column if not exists aguardando_origem text,
  add column if not exists atualizado_em timestamptz;

create table if not exists public.usuarios (
  email  text primary key,
  nome   text,
  perfil text,
  ativo  boolean not null default true
);

-- ---------------------------------------------------------------------------
-- 2. Stubs de identidade (mesma semântica de produção)
-- ---------------------------------------------------------------------------
create or replace function public.app_email() returns text
language sql stable set search_path to 'public' as $$
  select lower(coalesce((auth.jwt() ->> 'email'), ''));
$$;

create or replace function public.app_usuario_ativo() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.usuarios u
                  where lower(u.email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
                    and u.ativo is true);
$$;

-- Produção: allowlist fixa de 3 e-mails. Aqui, os 3 e-mails de gestão do teste.
create or replace function public.usuario_e_gestao() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'ger_cota@test.local', 'sup_cota@test.local', 'adm_cota@test.local');
$$;

grant execute on function public.app_email() to authenticated;
grant execute on function public.app_usuario_ativo() to authenticated;
grant execute on function public.usuario_e_gestao() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Funções de produção que a migration substitui (corpo de 11/11/2026)
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_cadencia_consumo()
returns table(canal_id uuid, canal_apelido text, modo text, limite_operador integer,
              usadas_operador integer, limite_canal integer, usadas_canal integer,
              janela_inicio time without time zone, janela_fim time without time zone,
              dentro_da_janela boolean)
language sql stable security definer set search_path to 'public'
as $function$
  WITH agora AS (
    SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje,
           (now() AT TIME ZONE 'America/Sao_Paulo')::time AS hora
  )
  SELECT k.id, k.apelido, k.modo,
         CASE WHEN k.limite_abordagens_operador IS NULL THEN NULL
              ELSE k.limite_abordagens_operador + COALESCE((
                SELECT l.extra FROM public.whatsapp_cadencia_liberacoes l, agora g
                 WHERE l.canal_id = k.id AND l.dia = g.hoje
                   AND l.operador_email = lower(public.app_email())), 0)
         END,
         (SELECT count(*)::integer FROM public.whatsapp_abordagens a, agora g
           WHERE a.canal_id = k.id AND a.dia = g.hoje
             AND a.operador_email = public.app_email()),
         k.limite_abordagens_canal,
         (SELECT count(*)::integer FROM public.whatsapp_abordagens a, agora g
           WHERE a.canal_id = k.id AND a.dia = g.hoje),
         k.janela_inicio, k.janela_fim,
         (SELECT k.janela_inicio IS NULL OR k.janela_fim IS NULL
                 OR (g.hora >= k.janela_inicio AND g.hora < k.janela_fim) FROM agora g)
  FROM public.whatsapp_canais k
  WHERE public.app_usuario_ativo() AND k.ativo
  ORDER BY k.apelido;
$function$;
revoke all on function public.whatsapp_cadencia_consumo() from public, anon;
grant execute on function public.whatsapp_cadencia_consumo() to authenticated, service_role;

-- A tela de cadência grava por esta RPC; a migration NÃO a reescreve. Está
-- aqui para provar que, com teto 10, a tela consegue gravar 10 e não 11.
create or replace function public.whatsapp_canal_cadencia_salvar(
  p_canal_id uuid, p_modo text, p_limite_operador integer default null,
  p_limite_canal integer default null, p_janela_inicio time default null,
  p_janela_fim time default null)
returns void language plpgsql security definer set search_path to 'public'
as $function$
DECLARE
  v_teto integer;
BEGIN
  IF NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'somente gestao' USING ERRCODE = '42501';
  END IF;
  IF p_modo NOT IN ('ATIVO_CONTROLADO','SOMENTE_RESPOSTAS','PAUSADO') THEN
    RAISE EXCEPTION 'modo invalido: %', p_modo;
  END IF;
  IF coalesce(p_limite_operador, 0) < 0 OR coalesce(p_limite_canal, 0) < 0 THEN
    RAISE EXCEPTION 'limite nao pode ser negativo';
  END IF;
  SELECT teto_abordagens_operador INTO v_teto FROM public.whatsapp_config LIMIT 1;
  v_teto := COALESCE(v_teto, 3);
  IF p_limite_operador IS NOT NULL AND p_limite_operador > v_teto THEN
    RAISE EXCEPTION
      'o maximo por operador nesta fase e % conversas novas por dia (pedido: %)',
      v_teto, p_limite_operador
      USING ERRCODE = '42501', DETAIL = 'TETO_ABORDAGENS_OPERADOR';
  END IF;
  IF p_janela_inicio IS NOT NULL AND p_janela_fim IS NOT NULL
     AND p_janela_inicio >= p_janela_fim THEN
    RAISE EXCEPTION 'janela invalida: inicio precisa ser antes do fim';
  END IF;
  UPDATE public.whatsapp_canais
  SET modo = p_modo, limite_abordagens_operador = p_limite_operador,
      limite_abordagens_canal = p_limite_canal,
      janela_inicio = p_janela_inicio, janela_fim = p_janela_fim
  WHERE id = p_canal_id;
END;
$function$;
revoke all on function public.whatsapp_canal_cadencia_salvar(uuid, text, integer, integer, time, time) from public, anon;
grant execute on function public.whatsapp_canal_cadencia_salvar(uuid, text, integer, integer, time, time) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3b. Fila do receptivo e aguardando_resposta (forma de produção, 11/11/2026)
-- ---------------------------------------------------------------------------
create or replace function auth.email() returns text language sql stable as $$
  select nullif(current_setting('teste.email', true), '');
$$;

create table public.fila_receptivo (
  email              text primary key,
  nome               text,
  atendimentos_hoje  integer default 0,
  data_referencia    date default current_date,
  ultimo_atendimento timestamptz,
  online_em          timestamptz default now(),
  em_pausa           boolean default false
);

create table public.receptivo_atendimentos_log (
  id                uuid        primary key default gen_random_uuid(),
  operador_email    text        not null,
  operador_nome     text,
  atendido_em       timestamptz not null default now(),
  responsavel_desde timestamptz,
  fonte             text        not null default 'MANUAL',
  constraint receptivo_atendimentos_log_fonte_check check (fonte in ('MANUAL', 'WHATSAPP'))
);
create unique index uq_receptivo_log_operador_ciclo
  on public.receptivo_atendimentos_log (operador_email, responsavel_desde)
  where responsavel_desde is not null;

create or replace function public.usuario_e_gestao_fila() returns boolean
language sql stable security definer set search_path to 'public' as $function$
  SELECT public.usuario_e_gestao()
  OR EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE lower(u.email) = lower(coalesce(auth.jwt()->>'email',''))
      AND u.perfil IN ('gerencia','supervisor','administrativo')
  );
$function$;

-- Corpo de produção ANTES da migration (a migration o separa em trava + registro)
create or replace function public.fila_receptivo_marcar_atendido(
  p_email text, p_conversa_id uuid default null::uuid, p_canal text default null::text)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_hoje           date := (now() at time zone 'America/Sao_Paulo')::date;
  v_nome           text;
  v_resp_desde     timestamptz;
  v_rows           integer;
begin
  if lower(p_email) <> lower(coalesce(auth.email(), '')) then
    if not coalesce(public.usuario_e_gestao_fila(), false) then
      raise exception 'não autorizado: somente gestão ou supervisão pode registrar atendimento para outro operador'
        using errcode = '42501';
    end if;
  end if;
  if p_conversa_id is not null then
    select responsavel_desde into v_resp_desde
      from public.whatsapp_conversas
     where id = p_conversa_id
       and lower(responsavel_email) = lower(p_email);
    if not found or v_resp_desde is null then
      return;
    end if;
  end if;
  select nome into v_nome from public.fila_receptivo where email = p_email;
  if not found then return; end if;
  insert into public.receptivo_atendimentos_log
    (operador_email, operador_nome, atendido_em, responsavel_desde, fonte)
  values (p_email, v_nome, now(), v_resp_desde,
          case when p_conversa_id is not null then 'WHATSAPP' else 'MANUAL' end)
  on conflict (operador_email, responsavel_desde)
  where responsavel_desde is not null
  do nothing;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    update public.fila_receptivo
       set atendimentos_hoje = case when data_referencia = v_hoje then atendimentos_hoje + 1 else 1 end,
           data_referencia   = v_hoje,
           ultimo_atendimento = now(),
           online_em          = now()
     where email = p_email;
  end if;
end;
$function$;
revoke all on function public.fila_receptivo_marcar_atendido(text, uuid, text) from public, anon;
grant execute on function public.fila_receptivo_marcar_atendido(text, uuid, text) to authenticated, service_role;

-- Gatilho real que deriva aguardando_resposta (corpo de produção)
create or replace function public._trg_whatsapp_aguardando() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
DECLARE
  v_ultima timestamptz;
BEGIN
  SELECT max(m.timestamp_wa) INTO v_ultima
  FROM public.whatsapp_mensagens m
  WHERE m.conversa_id = new.conversa_id;

  IF v_ultima IS NOT NULL AND new.timestamp_wa < v_ultima THEN
    IF new.direcao = 'ENTRADA' THEN
      UPDATE public.whatsapp_conversas
      SET aguardando_desde = least(coalesce(aguardando_desde, new.timestamp_wa), new.timestamp_wa)
      WHERE id = new.conversa_id AND aguardando_resposta;
    END IF;
    RETURN new;
  END IF;

  IF new.direcao = 'ENTRADA' THEN
    UPDATE public.whatsapp_conversas
    SET aguardando_resposta = true,
        aguardando_desde    = CASE
          WHEN coalesce(aguardando_origem, 'TEMPO_REAL') =  'SYNC_INICIAL'
           AND coalesce(new.origem,        'TEMPO_REAL') <> 'SYNC_INICIAL'
          THEN new.timestamp_wa
          ELSE coalesce(aguardando_desde, new.timestamp_wa)
        END,
        aguardando_origem   = coalesce(new.origem, 'TEMPO_REAL'),
        atualizado_em       = now()
    WHERE id = new.conversa_id;
  ELSIF new.direcao = 'SAIDA' THEN
    IF coalesce(new.status, '') <> 'FALHOU' THEN
      UPDATE public.whatsapp_conversas
      SET aguardando_resposta = false,
          aguardando_desde    = NULL,
          aguardando_origem   = NULL,
          atualizado_em       = now()
      WHERE id = new.conversa_id;
    END IF;
  END IF;
  RETURN new;
END;
$function$;
create trigger trg_whatsapp_aguardando after insert on public.whatsapp_mensagens
  for each row execute function public._trg_whatsapp_aguardando();

-- ---------------------------------------------------------------------------
-- 4. Os três canais reais (ids, limites e tetos de 11/11/2026)
-- ---------------------------------------------------------------------------
insert into public.whatsapp_canais (id, sessao_chave, display_phone_number, apelido, ativo,
                                    conexao_status, modo, janela_inicio, janela_fim,
                                    limite_abordagens_operador, limite_abordagens_canal)
values ('b8f00c75-aee3-4d22-83b7-f0041be0ef71', 'comercial', '+55 55 999154925', 'Comercial',
        true,  'CONECTADO',     'ATIVO_CONTROLADO', '00:00', '23:59', 2,  60),
       ('9f5fc202-3a22-4b24-8794-65fd92858e31', 'cobranca',  '5551999417659',    'Cobrança',
        false, 'AGUARDANDO_QR', 'ATIVO_CONTROLADO', '08:00', '20:00', 15, 40),
       ('3628d3fd-ab44-4c47-bf42-3d344c1e9336', 'piloto',    '+55 51 99631-6324', 'Piloto',
        false, 'DESCONECTADO',  'ATIVO_CONTROLADO', '09:00', '20:00', 3,  100);

-- ---------------------------------------------------------------------------
-- 5. Usuários de teste — um por perfil que a regra distingue
-- ---------------------------------------------------------------------------
insert into public.usuarios (email, nome, perfil, ativo) values
  ('op_a@test.local',       'Op A',          'operador',       true),
  ('op_b@test.local',       'Op B',          'operador',       true),
  ('op_c@test.local',       'Op C',          'operador',       true),
  ('op_d@test.local',       'Op D',          'operador',       true),
  ('op_e@test.local',       'Op E',          'operador',       true),
  ('op_f@test.local',       'Op F',          'operador',       true),
  ('op_g@test.local',       'Op G',          'operador',       true),
  ('ger_cota@test.local',   'Gerencia',      'gerencia',       true),
  ('sup_cota@test.local',   'Supervisao',    'supervisor',     true),
  ('adm_cota@test.local',   'Administrativo','administrativo', true),
  ('dir_cota@test.local',   'Diretoria',     'diretoria',      true),
  ('ger_inativo@test.local','Ger. inativo',  'gerencia',       false);

-- ---------------------------------------------------------------------------
-- 6. HELPERS. Cada passo do cenário roda em STATEMENT PRÓPRIO (autocommit),
--    como em produção: now() muda entre assumir, enviar e registrar.
--    Dentro de um único DO block, now() seria o mesmo instante e o ciclo
--    de responsabilidade não poderia ser distinguido.
-- ---------------------------------------------------------------------------

-- Assumir / transferir: o mesmo UPDATE de whatsapp_assumir_conversa e de
-- whatsapp_transferir_conversa (responsavel_desde = now()).
-- p_seg_atras recua o instante, para o cenário não esbarrar no INTERVALO_MINIMO.
create or replace function public._t_assumir(p_conversa uuid, p_email text, p_seg_atras integer default 0)
returns void language sql as $$
  update public.whatsapp_conversas
     set responsavel_email = lower(p_email),
         responsavel_nome  = p_email,
         responsavel_desde = now() - make_interval(secs => p_seg_atras),
         status            = 'EM_ATENDIMENTO'
   where id = p_conversa;
$$;

-- whatsapp_retirar_responsavel
create or replace function public._t_retirar(p_conversa uuid)
returns void language sql as $$
  update public.whatsapp_conversas
     set responsavel_email = null, responsavel_nome = null, responsavel_desde = null
   where id = p_conversa;
$$;

-- O trecho de whatsapp_preparar_envio que importa: cadência ANTES; se a
-- conversa está livre, quem envia vira responsável no MESMO instante.
create or replace function public._t_preparar(p_canal uuid, p_conversa uuid, p_email text)
returns text language plpgsql as $$
declare v text;
begin
  v := public._t_checar(p_canal, p_conversa, p_email);
  if v in ('RESPOSTA', 'CONTINUIDADE', 'NOVA_ABORDAGEM') then
    update public.whatsapp_conversas
       set responsavel_email = lower(p_email), responsavel_nome = p_email,
           responsavel_desde = now(), status = 'EM_ATENDIMENTO'
     where id = p_conversa and responsavel_email is null;
  end if;
  return v;
end $$;

-- O INSERT de whatsapp_registrar_mensagem, com a MESMA idempotência:
-- ON CONFLICT (wamid) DO NOTHING. É o que a Edge whatsapp-send chama
-- depois do gateway: status ENVIADO no sucesso, FALHOU na falha.
create or replace function public._t_registrar(p_conversa uuid, p_email text, p_status text,
                                               p_wamid text, p_seg_atras integer default 0,
                                               p_origem text default 'TEMPO_REAL')
returns void language sql as $$
  insert into public.whatsapp_mensagens (conversa_id, wamid, direcao, texto, status,
                                         enviado_por_email, origem, timestamp_wa, criado_em)
  values (p_conversa, p_wamid, 'SAIDA', 'teste', p_status, p_email, p_origem,
          now() - make_interval(secs => p_seg_atras),
          now() - make_interval(secs => p_seg_atras))
  on conflict (wamid) do nothing;
$$;

-- Fila do receptivo: atendimentos do operador hoje e linhas WHATSAPP no log
create or replace function public._t_fila(p_email text)
returns integer language sql as $$
  select coalesce((select atendimentos_hoje from public.fila_receptivo where email = p_email), -1);
$$;
create or replace function public._t_log(p_email text)
returns integer language sql as $$
  select count(*)::integer from public.receptivo_atendimentos_log
   where operador_email = p_email and fonte = 'WHATSAPP';
$$;

-- Cota usada hoje pelo operador no canal (a mesma conta de checar)
create or replace function public._t_cota(p_canal uuid, p_email text)
returns integer language sql as $$
  select count(distinct conversa_id)::integer from public.whatsapp_abordagens
   where canal_id = p_canal and operador_email = lower(p_email)
     and dia = (now() at time zone 'America/Sao_Paulo')::date;
$$;

drop table if exists _cota_r;
create table _cota_r (n text, caso text, esperado text, obtido text);

select 'ambiente cota 10 pronto' as status;
