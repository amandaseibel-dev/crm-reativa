-- AMBIENTE ISOLADO — CONTINUIDADE v2 (20261109120000)
--
-- Roda num Postgres descartável do CI (serviço do GitHub Actions).
-- NÃO fala com produção, NÃO usa segredo.
--
-- Diferenças em relação ao ambiente da v1:
--   * whatsapp_conversas ganha arquivada_em / arquivada_por (a v2 lê)
--   * status ganha o CHECK real de produção, com ENCERRADO
--   * whatsapp_config já nasce com os parâmetros da v2 ausentes de propósito:
--     é a migration que os cria, e 02_antes_v2.sql mede o comportamento ANTES.
--
-- ORDEM DE EXECUÇÃO:
--   01_ambiente.sql  -> 02_antes_v2.sql -> <migration v2> -> 03_casos_v2.sql

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. PAPÉIS
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')           then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')  then create role authenticated;  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')   then create role service_role;   end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. STUBS auth
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('email', coalesce(current_setting('teste.email', true), ''));
$$;

-- ---------------------------------------------------------------------------
-- 3. SCHEMA MÍNIMO
-- ---------------------------------------------------------------------------
create table public.alunos (
  id   uuid primary key default gen_random_uuid(),
  nome text,
  cpf  text
);

create table public.whatsapp_canais (
  id                         uuid        primary key default gen_random_uuid(),
  sessao_chave               text        not null,
  display_phone_number       text        not null,
  apelido                    text        not null,
  ativo                      boolean     not null default true,
  conexao_status             text        not null default 'DESCONECTADO',
  conectado_em               timestamptz,
  modo                       text        not null default 'SOMENTE_RESPOSTAS',
  limite_abordagens_operador integer,
  limite_abordagens_canal    integer,
  janela_inicio              time,
  janela_fim                 time,
  criado_em                  timestamptz not null default now(),
  constraint ck_whatsapp_canal_modo
    check (modo in ('ATIVO_CONTROLADO','SOMENTE_RESPOSTAS','PAUSADO'))
);
create unique index ux_whatsapp_canais_sessao_chave on public.whatsapp_canais (sessao_chave);

-- arquivada_em e status são EIXOS INDEPENDENTES, como em produção:
-- whatsapp_arquivar_conversa não toca status; whatsapp_reabrir_conversa não
-- toca arquivada_em. A v2 precisa checar os dois.
create table public.whatsapp_conversas (
  id             uuid        primary key default gen_random_uuid(),
  canal_id       uuid        not null references public.whatsapp_canais(id),
  telefone_e164  text        not null,
  status         text        not null default 'NOVO',
  aluno_id       uuid        references public.alunos(id),
  arquivada_em   timestamptz,
  arquivada_por  text,
  criado_em      timestamptz not null default now(),
  constraint uq_whatsapp_conversa unique (canal_id, telefone_e164),
  constraint ck_whatsapp_conversa_status
    check (status in ('NOVO','EM_ATENDIMENTO','RESPONDIDO','ENCERRADO'))
);

create table public.whatsapp_mensagens (
  id                uuid        primary key default gen_random_uuid(),
  conversa_id       uuid        not null references public.whatsapp_conversas(id) on delete cascade,
  wamid             text        unique,
  direcao           text        not null,
  tipo              text        not null default 'text',
  texto             text,
  status            text        not null default 'ENVIADO',
  enviado_por_email text,
  sessao_chave      text,
  telefone_e164     text,
  origem            text        not null default 'TEMPO_REAL',
  timestamp_wa      timestamptz not null,
  criado_em         timestamptz not null default now()
);

create table public.whatsapp_abordagens (
  id             uuid        primary key default gen_random_uuid(),
  canal_id       uuid        not null references public.whatsapp_canais(id)    on delete cascade,
  conversa_id    uuid        not null references public.whatsapp_conversas(id) on delete cascade,
  operador_email text        not null,
  dia            date        not null,
  criado_em      timestamptz not null default now(),
  constraint uq_whatsapp_abordagem unique (canal_id, conversa_id, dia)
);

create table public.whatsapp_cadencia_bloqueios (
  id             uuid        primary key default gen_random_uuid(),
  canal_id       uuid        not null references public.whatsapp_canais(id) on delete cascade,
  conversa_id    uuid,
  operador_email text        not null,
  motivo         text        not null,
  criado_em      timestamptz not null default now(),
  constraint ck_whatsapp_bloqueio_motivo check (motivo in (
    'MODO_PAUSADO','MODO_SOMENTE_RESPOSTAS','FORA_DA_JANELA',
    'LIMITE_OPERADOR','LIMITE_CANAL'))
);

create table public.whatsapp_cadencia_liberacoes (
  id             uuid        primary key default gen_random_uuid(),
  canal_id       uuid        not null references public.whatsapp_canais(id) on delete cascade,
  operador_email text        not null,
  dia            date        not null,
  extra          integer     not null check (extra > 0),
  concedido_por  text,
  motivo         text,
  constraint uq_whatsapp_cadencia_liberacao unique (canal_id, operador_email, dia)
);

-- SEM as colunas de continuidade: é a migration que as cria.
create table public.whatsapp_config (
  id                          boolean     primary key default true,
  teto_abordagens_operador    integer     not null default 3,
  intervalo_minimo_envio_seg  integer     not null default 60,
  resposta_janela_horas       integer     not null default 24,
  atualizado_em               timestamptz,
  constraint ck_whatsapp_config_linha_unica check (id)
);

-- Estado real de produção em 09/11/2026: teto=3, intervalo=60, resposta=24
insert into public.whatsapp_config (id, teto_abordagens_operador, intervalo_minimo_envio_seg, resposta_janela_horas)
values (true, 3, 60, 24);

-- ---------------------------------------------------------------------------
-- 4. FUNÇÃO ATUAL (pré-v2), corpo lido de produção em 09/11/2026.
--    Serve para 02_antes_v2.sql medir o comportamento ANTES da migration.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_cadencia_checar(
  p_canal_id    uuid,
  p_conversa_id uuid,
  p_operador    text)
returns text
language plpgsql security definer set search_path to 'public'
as $function$
DECLARE
  v_canal   public.whatsapp_canais%ROWTYPE;
  v_agora   timestamptz := now();
  v_hoje    date := (v_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  v_hora    time := (v_agora AT TIME ZONE 'America/Sao_Paulo')::time;
  v_resposta boolean;
  v_op      integer;
  v_ch      integer;
  v_extra   integer := 0;
  v_limite_op integer;
  v_intervalo integer;
  v_janela_h  integer;
  v_ultimo    timestamptz;
  v_faltam    integer;
BEGIN
  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = p_canal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canal inexistente'; END IF;

  IF v_canal.modo = 'PAUSADO' THEN
    RAISE EXCEPTION 'o numero % esta pausado: nenhuma mensagem sai por ele', v_canal.apelido
      USING ERRCODE = '42501', DETAIL = 'MODO_PAUSADO';
  END IF;

  SELECT COALESCE(intervalo_minimo_envio_seg, 60), COALESCE(resposta_janela_horas, 24)
    INTO v_intervalo, v_janela_h
    FROM public.whatsapp_config LIMIT 1;
  v_intervalo := COALESCE(v_intervalo, 60);
  v_janela_h  := COALESCE(v_janela_h, 24);

  IF v_intervalo > 0 THEN
    SELECT max(m.criado_em) INTO v_ultimo
      FROM public.whatsapp_mensagens m
      JOIN public.whatsapp_conversas cv ON cv.id = m.conversa_id
     WHERE m.direcao = 'SAIDA'
       AND lower(m.enviado_por_email) = lower(p_operador)
       AND cv.canal_id = p_canal_id
       AND m.conversa_id IS DISTINCT FROM p_conversa_id
       AND m.criado_em > v_agora - make_interval(secs => v_intervalo);

    IF v_ultimo IS NOT NULL THEN
      v_faltam := ceil(extract(epoch from (v_ultimo + make_interval(secs => v_intervalo) - v_agora)));
      RAISE EXCEPTION 'espere % segundos antes de falar com outro aluno neste numero', GREATEST(v_faltam, 1)
        USING ERRCODE = '42501', DETAIL = 'INTERVALO_MINIMO';
    END IF;
  END IF;

  v_resposta := p_conversa_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.whatsapp_mensagens m
    WHERE m.conversa_id = p_conversa_id
      AND m.direcao = 'ENTRADA'
      AND m.timestamp_wa >= v_agora - make_interval(hours => v_janela_h)
  );
  IF v_resposta THEN RETURN 'RESPOSTA'; END IF;

  IF v_canal.modo = 'SOMENTE_RESPOSTAS' THEN
    RAISE EXCEPTION 'o numero % so responde quem escreveu nas ultimas %h', v_canal.apelido, v_janela_h
      USING ERRCODE = '42501', DETAIL = 'MODO_SOMENTE_RESPOSTAS';
  END IF;

  IF v_canal.janela_inicio IS NOT NULL AND v_canal.janela_fim IS NOT NULL
     AND (v_hora < v_canal.janela_inicio OR v_hora >= v_canal.janela_fim) THEN
    RAISE EXCEPTION 'novas conversas so entre % e %, horario de Brasilia',
      to_char(v_canal.janela_inicio, 'HH24:MI'), to_char(v_canal.janela_fim, 'HH24:MI')
      USING ERRCODE = '42501', DETAIL = 'FORA_DA_JANELA';
  END IF;

  INSERT INTO public.whatsapp_abordagens (canal_id, conversa_id, operador_email, dia)
  VALUES (p_canal_id, p_conversa_id, lower(p_operador), v_hoje)
  ON CONFLICT (canal_id, conversa_id, dia) DO NOTHING;

  SELECT count(*) INTO v_op FROM public.whatsapp_abordagens
   WHERE canal_id = p_canal_id AND operador_email = lower(p_operador) AND dia = v_hoje;
  SELECT count(*) INTO v_ch FROM public.whatsapp_abordagens
   WHERE canal_id = p_canal_id AND dia = v_hoje;

  SELECT COALESCE(l.extra, 0) INTO v_extra FROM public.whatsapp_cadencia_liberacoes l
   WHERE l.canal_id = p_canal_id AND l.operador_email = lower(p_operador) AND l.dia = v_hoje;
  v_extra := COALESCE(v_extra, 0);
  v_limite_op := v_canal.limite_abordagens_operador + v_extra;

  IF v_canal.limite_abordagens_operador IS NOT NULL AND v_op > v_limite_op THEN
    RAISE EXCEPTION 'voce ja iniciou % conversas novas hoje neste numero. Responder quem escreveu nas ultimas %h continua liberado',
      v_limite_op, v_janela_h
      USING ERRCODE = '42501', DETAIL = 'LIMITE_OPERADOR';
  END IF;

  IF v_canal.limite_abordagens_canal IS NOT NULL AND v_ch > v_canal.limite_abordagens_canal THEN
    RAISE EXCEPTION 'o numero % ja iniciou % conversas novas hoje. Nenhum operador inicia novas ate amanha',
      v_canal.apelido, v_canal.limite_abordagens_canal
      USING ERRCODE = '42501', DETAIL = 'LIMITE_CANAL';
  END IF;

  RETURN 'NOVA_ABORDAGEM';
END;
$function$;

grant execute on function public.whatsapp_cadencia_checar(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. HELPERS DE CENÁRIO
-- ---------------------------------------------------------------------------

-- Canal de teste: janela 00:00-23:59 para não depender do horário de execução
-- do CI (ver memória: teste com horário renderizado quebra no CI).
create or replace function public._t_canal(p_chave text, p_modo text default 'ATIVO_CONTROLADO',
                                           p_lim_op integer default 5, p_lim_canal integer default null,
                                           p_ini time default '00:00', p_fim time default '23:59')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo,
                                      conexao_status, modo, janela_inicio, janela_fim,
                                      limite_abordagens_operador, limite_abordagens_canal)
  values (p_chave, '+55 51 90000-0000', 'Teste '||p_chave, true, 'CONECTADO', p_modo,
          p_ini, p_fim, p_lim_op, p_lim_canal)
  returning id into v;
  return v;
end $$;

create or replace function public._t_conversa(p_canal uuid, p_tel text,
                                              p_status text default 'EM_ATENDIMENTO',
                                              p_arquivada timestamptz default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status, arquivada_em, arquivada_por)
  values (p_canal, p_tel, p_status, p_arquivada,
          case when p_arquivada is null then null else 'teste@local' end)
  returning id into v;
  return v;
end $$;

-- Mensagem com idade controlada em horas (positivo = no passado)
create or replace function public._t_msg(p_conversa uuid, p_direcao text,
                                         p_horas_atras numeric, p_operador text default null)
returns void language plpgsql as $$
begin
  insert into public.whatsapp_mensagens (conversa_id, direcao, texto, enviado_por_email,
                                         timestamp_wa, criado_em)
  values (p_conversa, p_direcao, 'teste', p_operador,
          now() - make_interval(secs => (p_horas_atras * 3600)::int),
          now() - make_interval(secs => (p_horas_atras * 3600)::int));
end $$;

-- Executa a cadência e devolve o veredito ou o DETAIL da exceção
create or replace function public._t_checar(p_canal uuid, p_conversa uuid, p_op text)
returns text language plpgsql as $$
declare v text; v_detail text;
begin
  begin
    v := public.whatsapp_cadencia_checar(p_canal, p_conversa, p_op);
    return v;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return coalesce(nullif(v_detail, ''), 'ERRO:'||sqlstate);
  end;
end $$;

-- Tabela de resultados, compartilhada por 02 e 03
drop table if exists _cont_v2_resultado;
create table _cont_v2_resultado (
  fase      text,
  n         integer,
  caso      text,
  esperado  text,
  obtido    text,
  ok        boolean,
  detalhe   text
);

select 'ambiente v2 pronto' as status;
