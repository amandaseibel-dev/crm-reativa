-- BANCADA DO REMANEJAMENTO COM FIDELIZACAO -- producao lida em 17/11/2026.
--
-- GERADA por script a partir de pg_get_functiondef de producao (somente
-- leitura). As funcoes da secao "PRODUCAO" sao byte a byte as de producao e o
-- teste confere o md5(prosrc) de cada uma contra o .md5.json ao lado.
-- Tabelas sao o ESQUELETO do que essas funcoes tocam. Dubles estao marcados.
-- NENHUM DADO REAL: o teste semeia nomes, CPFs e valores ficticios.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists internal;
create schema if not exists auth;

-- DUBLE: auth.jwt() le um GUC para o teste "entrar" como cada pessoa.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('test.jwt', true), '')::jsonb
$$;

create table public.usuarios (
  id uuid primary key default gen_random_uuid(), nome text not null, email text not null unique,
  perfil text not null, ativo boolean default true, recebe_novos_casos boolean default true,
  pode_alterar_responsavel boolean not null default false
);
create table public.alunos (
  id uuid primary key default gen_random_uuid(), nome text, cpf text, matricula text,
  responsavel_atual_email text, responsavel_atual_nome text, responsavel_atual_em timestamptz,
  data_ultimo_acionamento timestamptz, status_acionamento text, proxima_acao text,
  data_retorno date, hora_retorno text, retorno_origem text, retorno_confirmado_em timestamptz
);
create table public.casos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid, caso_codigo int,
  nome text, nome_aluno text, cpf text, cpf_limpo text, matricula text, chave_unificacao text,
  operador_email text, operador_nome text, operador text,
  status_atual text, status_acionamento text, status_financeiro text, status_jornada text,
  nao_acionar boolean, valor_pago numeric, quitado_em date, valor_quitado numeric,
  data_ultimo_acionamento date, data_retorno date,
  encerrado_operacional boolean not null default false,
  caso_atualizado_por text, caso_atualizado_em timestamptz,
  giro_fidelizacao_ate date, total_em_aberto numeric,
  nivelamento_marcador text, nivelamento_em timestamptz, nivelamento_simulacao_id uuid
);
create table public.acordos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid, cpf text, status text, numero_acordo bigint,
  operador_responsavel_email text, operador_responsavel_nome text, valor_total numeric, atualizado_em timestamptz
);
create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid, valor numeric, vencimento date, status text);
create table public.acordos_titulos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid, cpf text, vencimento date,
  valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric, situacao text, status text, acordo_id uuid
);
create table public.acordo_titulo_vinculo (titulo_id uuid, ativo boolean default true);
create table public.operador_agenda (
  id uuid primary key default gen_random_uuid(), aluno_id text, aluno_nome text not null,
  operador_email text not null, operador_nome text, retorno_em timestamptz not null,
  status text not null default 'PENDENTE', atualizado_em timestamptz not null default now()
);
create table public.aluno_movimentacoes (
  id bigserial primary key, aluno_id text not null, tipo text not null, descricao text,
  operador_anterior_nome text, operador_anterior_email text, operador_novo_nome text, operador_novo_email text,
  registrado_por_nome text, registrado_por_email text, registrado_em timestamptz default now(),
  -- colunas de producao (information_schema, 17/11/2026) que a #936 le
  status_anterior text, status_novo text, data_retorno timestamptz, solicitacao_link_id uuid,
  baixa_pagamento_id uuid, link_pagamento text, motivo_devolucao text, valor_movimentacao numeric,
  lote_id uuid
);
create table public.auditoria (
  id uuid primary key default gen_random_uuid(), usuario text, acao text not null,
  tabela_afetada text, registro_id uuid, detalhes jsonb, created_at timestamp default now()
);
create table public.historico_operadores_alunos (
  id uuid primary key default gen_random_uuid(), chave_unificacao text, nome_aluno text, cpf_referencia text,
  acao text, operador_anterior_nome text, operador_anterior_email text, observacao text, criado_em timestamptz default now()
);
create table public.calibragem_parametros (chave text primary key, valor jsonb, descricao text, atualizado_em timestamptz, atualizado_por text);
create table public.calibragem_simulacoes (
  id uuid primary key default gen_random_uuid(), status text, resultado jsonb,
  aprovado_por_email text, aprovado_por_nome text, executado_em timestamptz
);
create table public.calibragem_auditoria (
  id uuid primary key default gen_random_uuid(), evento text, simulacao_id uuid, caso_id uuid, aluno_id uuid,
  cpf text, nome_aluno text, operador_anterior_email text, operador_anterior_nome text,
  operador_novo_email text, operador_novo_nome text, valor_caso numeric, motivo text, regra text,
  situacao_anterior jsonb, situacao_posterior jsonb, aprovado_por_email text, aprovado_por_nome text,
  registrado_por_email text, registrado_em timestamptz default now()
);
-- colunas de producao em 17/11/2026 (information_schema), ANTES da migration
create table public.carteira_geral_previas (
  id uuid primary key default gen_random_uuid(), criado_em timestamptz not null default now(),
  criado_por_email text not null, filtros jsonb not null, destino_tipo text not null, destino_email text,
  itens jsonb not null default '[]'::jsonb, total_alunos int not null default 0, total_acordos int not null default 0,
  total_valor numeric not null default 0, conflitos jsonb not null default '[]'::jsonb,
  executada_em timestamptz, executada_por_email text, expira_em timestamptz not null default (now() + interval '2 hours')
);
create table public.carteira_geral_auditoria (
  id uuid primary key default gen_random_uuid(), previa_id uuid, lote_id uuid not null,
  registrado_em timestamptz not null default now(), autor_email text not null, autor_nome text,
  motivo text not null, destino_tipo text not null, aluno_id uuid not null, caso_id uuid,
  nome_aluno text, cpf text, caso_de_email text, caso_para_email text, aluno_de_email text, aluno_para_email text,
  acordos_movidos int not null default 0, acordos_detalhe jsonb not null default '[]'::jsonb,
  valor_mensalidade numeric not null default 0, valor_acordo numeric not null default 0,
  desfeito_em timestamptz, desfeito_por_email text
);
create table public._teste_congelados (caso_id uuid primary key);

-- copia da view de producao (como na bancada da Carteira Geral)
create view public.calibragem_saldo_aluno as
with tit as (
  select t.aluno_id, t.cpf, sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) as saldo_mensalidade
    from public.acordos_titulos t
   where upper(coalesce(t.situacao,'')) = 'ABERTO' and lower(coalesce(t.status,'')) = 'em_aberto' and t.acordo_id is null
     and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true))
   group by t.aluno_id, t.cpf
), par as (
  select a.aluno_id, sum(coalesce(p.valor,0)) as saldo_acordo
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
     and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
   group by a.aluno_id
)
select coalesce(tit.aluno_id, par.aluno_id) as aluno_id, tit.cpf,
       coalesce(tit.saldo_mensalidade,0) as saldo_mensalidade, coalesce(par.saldo_acordo,0) as saldo_acordo,
       coalesce(tit.saldo_mensalidade,0) + coalesce(par.saldo_acordo,0) as saldo_total
  from tit full join par on par.aluno_id = tit.aluno_id;

-- ------------------------------------------------------------- DUBLES ----
-- Portao de gestao: mesma lista de producao.
create or replace function public.calibragem_e_gestao() returns boolean language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email','')) in
    ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br')
$$;
create or replace function public.usuario_e_gestao_fila() returns boolean language sql stable as $$ select public.calibragem_e_gestao() $$;
create or replace function internal.carteira_geral_email() returns text language sql immutable as $$ select 'carteira.geral@reativa.local'::text $$;
-- DUBLE de caso_protegido_redistribuicao: em producao sao 4 KB lendo link,
-- baixa, termo e confirmacao. Aqui: "nao acionar" ou tratativa em curso.
create or replace function public.caso_protegido_redistribuicao(
  p_cpf_limpo text, p_status_acionamento text, p_nao_acionar boolean, p_status_financeiro text,
  p_valor_pago numeric, p_quitado_em date, p_valor_quitado numeric) returns boolean language sql stable as $$
  select coalesce(p_nao_acionar,false)
      or upper(coalesce(p_status_acionamento,'')) in ('ALUNO_EM_NEGOCIACAO_24H','SOLICITADO_LINK','ACORDO_FECHADO')
$$;
-- DUBLE de caso_encerrado_operacional (5 argumentos).
create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
returns boolean language sql stable as $$
  select upper(coalesce(p_status_atual,'')) in ('QUITADO','JURIDICO','SUSPENSAO_COBRANCA')
$$;
create or replace function public.caso_encerramento_congelado(p_caso_id uuid) returns boolean language sql stable as $$
  select exists (select 1 from public._teste_congelados t where t.caso_id = p_caso_id)
$$;

-- ------------------- caminho de escrita oficial (copia da bancada CG) ----
create or replace function internal.set_resp_aluno(
  p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text,
  p_descricao text, p_autor_email text, p_autor_nome text
) returns void language plpgsql as $$
declare v_ant_email text; v_ant_nome text;
        v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select responsavel_atual_email, responsavel_atual_nome into v_ant_email, v_ant_nome
    from public.alunos where id = p_aluno_id;
  update public.alunos set
    responsavel_atual_email = v_email, responsavel_atual_nome = p_novo_nome,
    responsavel_atual_em = now(),
    data_ultimo_acionamento = case when v_ant_email is distinct from v_email then null else data_ultimo_acionamento end,
    status_acionamento = case when v_ant_email is distinct from v_email then null else status_acionamento end,
    proxima_acao = case when v_ant_email is distinct from v_email then null else proxima_acao end,
    data_retorno = case when v_ant_email is distinct from v_email then null else data_retorno end,
    hora_retorno = case when v_ant_email is distinct from v_email then null else hora_retorno end
  where id = p_aluno_id;
  insert into public.aluno_movimentacoes
    (aluno_id,tipo,descricao,operador_anterior_nome,operador_anterior_email,
     operador_novo_nome,operador_novo_email,registrado_por_nome,registrado_por_email,registrado_em)
  values (p_aluno_id::text, p_tipo, p_descricao, coalesce(v_ant_nome,'(sem)'), v_ant_email,
          p_novo_nome, v_email, coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end; $$;

create or replace function internal.set_resp_acordo(
  p_acordo_id uuid, p_novo_email text, p_novo_nome text, p_tipo text,
  p_descricao text, p_autor_email text, p_autor_nome text
) returns void language plpgsql as $$
declare v_ant text; v_aluno uuid;
        v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select operador_responsavel_email, aluno_id into v_ant, v_aluno from public.acordos where id = p_acordo_id;
  update public.acordos set operador_responsavel_email = v_email, atualizado_em = now() where id = p_acordo_id;
  insert into public.aluno_movimentacoes
    (aluno_id,tipo,descricao,operador_anterior_email,operador_novo_email,operador_novo_nome,
     registrado_por_nome,registrado_por_email,registrado_em)
  values (v_aluno::text, p_tipo, p_descricao, v_ant, v_email, p_novo_nome,
          coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end; $$;

-- Gatilhos de produção em volta do agendamento. Sem eles o teste de
-- preservação passaria por acaso: são eles que apagam retorno_origem e
-- retorno_confirmado_em, e que já protegem o acionamento.
create or replace function public._acionamento_nao_volta_para_nulo() returns trigger
language plpgsql as $$
begin
  if old.data_ultimo_acionamento is not null and new.data_ultimo_acionamento is null then
    new.data_ultimo_acionamento := old.data_ultimo_acionamento;
  end if;
  if old.status_acionamento is not null and nullif(btrim(old.status_acionamento),'') is not null
     and new.status_acionamento is null then
    new.status_acionamento := old.status_acionamento;
  end if;
  return new;
end; $$;
create trigger trg_acionamento_nao_volta_para_nulo
  before update of data_ultimo_acionamento, status_acionamento on public.alunos
  for each row execute function public._acionamento_nao_volta_para_nulo();

create or replace function public.limpar_retorno_origem() returns trigger
language plpgsql as $$
begin
  if new.data_retorno is null then new.retorno_origem := null; end if;
  return new;
end; $$;
create trigger trg_alunos_retorno_origem
  before insert or update of data_retorno, retorno_origem on public.alunos
  for each row execute function public.limpar_retorno_origem();

create or replace function public.tg_aluno_reset_retorno_confirmado() returns trigger
language plpgsql as $$
begin new.retorno_confirmado_em := null; return new; end $$;
create trigger trg_aluno_reset_retorno_confirmado
  before update of data_retorno on public.alunos
  for each row when (new.data_retorno is distinct from old.data_retorno)
  execute function public.tg_aluno_reset_retorno_confirmado();

-- Gatilho de produção: casos segue a ficha do aluno.
create or replace function public._sync_casos_resp_aluno() returns trigger
language plpgsql as $$
begin
  if new.responsavel_atual_email is distinct from old.responsavel_atual_email then
    update public.casos set operador_email = lower(new.responsavel_atual_email),
           operador_nome = new.responsavel_atual_nome, operador = new.responsavel_atual_nome,
           caso_atualizado_em = now()
     where aluno_id = new.id;
  end if;
  return new;
end; $$;
create trigger trg_sync_casos_resp_aluno after update of responsavel_atual_email on public.alunos
  for each row execute function public._sync_casos_resp_aluno();

-- utilitario de patch ancorado (migration 20260925181823)
create or replace function internal.patch_funcao_ancorada(
  p_schema text, p_funcao text, p_ancora text, p_novo text, p_ocorrencias int
) returns void
language plpgsql
as $fn$
declare v_src text; v_n int; v_ja int;
begin
  -- Patch ambiguo: se o texto novo e um PEDACO da ancora, ele ja aparece na
  -- funcao antes de qualquer troca e nao da para distinguir "ja aplicado" de
  -- "nunca aplicado". Recusa na entrada em vez de errar em silencio.
  if position(p_novo in p_ancora) > 0 and position(p_ancora in p_novo) = 0 then
    raise exception 'patch_funcao_ancorada: o texto novo e pedaco da ancora — patch ambiguo, reescreva a ancora.';
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_funcao
   limit 1;

  if v_src is null then
    raise exception 'patch_funcao_ancorada: %.% nao existe.', p_schema, p_funcao;
  end if;

  -- Idempotencia ANTES da contagem da ancora. Nos patches que so ACRESCENTAM
  -- (o texto novo contem a ancora), a ancora continua existindo depois de
  -- aplicado — entao contar ancora nao distingue nada. O que distingue e o
  -- texto NOVO ja estar la.
  v_ja := (length(v_src) - length(replace(v_src, p_novo, ''))) / length(p_novo);
  if v_ja >= p_ocorrencias then
    raise notice 'patch_funcao_ancorada: %.% ja estava aplicada.', p_schema, p_funcao;
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, p_ancora, ''))) / length(p_ancora);
  if v_n <> p_ocorrencias then
    raise exception 'patch_funcao_ancorada: %.% tem % ocorrencia(s) da ancora, esperado %. A funcao mudou; revise o patch.',
      p_schema, p_funcao, v_n, p_ocorrencias;
  end if;

  execute replace(v_src, p_ancora, p_novo);
end;
$fn$;

-- ----------------------------------------------------------- PRODUCAO ----
-- internal.matricula_em_fidelizacao(p_aluno_id uuid, p_matricula text) · md5(prosrc) 455a1ff88ec1cffa04f3a2343963fa3a
CREATE OR REPLACE FUNCTION internal.matricula_em_fidelizacao(p_aluno_id uuid, p_matricula text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH alvo AS (
    SELECT p_aluno_id AS aid WHERE p_aluno_id IS NOT NULL
    UNION ALL
    SELECT a.id FROM public.alunos a
    WHERE p_aluno_id IS NULL AND nullif(btrim(p_matricula),'') IS NOT NULL
      AND btrim(a.matricula) = btrim(p_matricula)
      AND (SELECT count(*) FROM public.alunos a2 WHERE btrim(a2.matricula) = btrim(p_matricula)) = 1
  )
  SELECT EXISTS (
    SELECT 1 FROM alvo JOIN public.alunos a ON a.id = alvo.aid
    WHERE a.responsavel_atual_email IS NOT NULL AND a.responsavel_atual_em IS NOT NULL
      AND a.responsavel_atual_em > now() - interval '10 days'
  );
$function$
;

-- internal.nome_operador_ativo(p_email text) · md5(prosrc) e87daef3d45fa8328c595c5ada95c6af
CREATE OR REPLACE FUNCTION internal.nome_operador_ativo(p_email text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select u.nome from public.usuarios u
  where lower(u.email)=lower(p_email) and u.ativo=true
    and (
      u.perfil='operador'
      or lower(u.email) in (
        'cobranca07@aelbra.com.br',   -- Amanda ADM (ja existente)
        'amanda.seibel@aelbra.com.br',-- Amanda gestora
        'cobranca04@aelbra.com.br'    -- Fernanda supervisora
      )
    )
  limit 1;
$function$
;

-- internal.operador_pode_receber_caso(p_email text) · md5(prosrc) 24ba1f0268290b3bc5cba4c5121973d2
CREATE OR REPLACE FUNCTION internal.operador_pode_receber_caso(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select internal.nome_operador_ativo(p_email) is not null
     and coalesce((select u.recebe_novos_casos
                     from public.usuarios u
                    where lower(u.email) = lower(btrim(coalesce(p_email,'')))
                    limit 1), false);
$function$
;

-- public.operador_pode_receber_caso(p_email text) · md5(prosrc) f12720f0ab00a1172a66f56c7442e3af
CREATE OR REPLACE FUNCTION public.operador_pode_receber_caso(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
  select internal.operador_pode_receber_caso(p_email);
$function$
;

-- public.calibragem_teto_operador(p_email text) · md5(prosrc) 5914afccc9b36b27d6aa5daf72807147
CREATE OR REPLACE FUNCTION public.calibragem_teto_operador(p_email text)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_teto int;
begin
  -- Teto individual, quando a gestao definiu um para este operador.
  begin
    select nullif(p.valor ->> lower(coalesce(p_email,'')), '')::int
      into v_teto
      from public.calibragem_parametros p
     where p.chave = 'limite_por_operador';
  exception when others then v_teto := null;
  end;

  -- Senao, o teto geral.
  if v_teto is null then
    begin
      -- `#>> '{}'` extrai o escalar tanto de 500 quanto de "500".
      select nullif(p.valor #>> '{}', '')::int
        into v_teto
        from public.calibragem_parametros p
       where p.chave = 'limite_carteira';
    exception when others then v_teto := null;
    end;
  end if;

  -- Piso de seguranca: teto zerado ou negativo esvaziaria as carteiras.
  if v_teto is null or v_teto < 1 then v_teto := 500; end if;
  return v_teto;
end;
$function$
;

-- public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date) · md5(prosrc) f519301f9f54fdc057565c54068f134c
CREATE OR REPLACE FUNCTION public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_data_ultimo_acionamento is not null
     and p_data_ultimo_acionamento + 10 >= current_date;
$function$
;

-- public.caso_em_giro_fidelizacao(p_ate date) · md5(prosrc) 6d4f0656272a9750b2f19c1a6241adb4
CREATE OR REPLACE FUNCTION public.caso_em_giro_fidelizacao(p_ate date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_ate is not null
     and p_ate >= (now() at time zone 'America/Sao_Paulo')::date;
$function$
;

-- public.giro_limpar_marca_ao_trocar_dono() · md5(prosrc) b2c32e05b6d3cfbb76a1a686f0688d2b
CREATE OR REPLACE FUNCTION public.giro_limpar_marca_ao_trocar_dono()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.operador_email is not null
     and NEW.operador_email is distinct from OLD.operador_email
     and OLD.giro_fidelizacao_ate is not null
     and NEW.giro_fidelizacao_ate is not distinct from OLD.giro_fidelizacao_ate then
    NEW.giro_fidelizacao_ate := null;
  end if;
  return NEW;
end;
$function$
;

-- public.trg_impor_teto_operador() · md5(prosrc) 3d01bbd194b76dc8455e9dd47d395cca
CREATE OR REPLACE FUNCTION public.trg_impor_teto_operador()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_meta int; v_email text := NEW.operador_email; v_qtd_ativa int; v_excedente int; caso_rec record;
BEGIN
  IF coalesce(current_setting('calibragem.bypass_teto', true), 'off') = 'on' THEN RETURN NEW; END IF;
  IF v_email IS NULL OR v_email IS NOT DISTINCT FROM OLD.operador_email THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.email = v_email AND u.perfil = 'operador' AND u.ativo = true) THEN RETURN NEW; END IF;
  IF public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) THEN RETURN NEW; END IF;

  -- Teto da gestao (geral ou individual). Cai em 500 se nao houver parametro.
  v_meta := public.calibragem_teto_operador(v_email);

  SELECT count(*) INTO v_qtd_ativa FROM public.casos c WHERE c.operador_email = v_email
    AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);
  v_excedente := v_qtd_ativa - v_meta;
  IF v_excedente <= 0 THEN RETURN NEW; END IF;
  FOR caso_rec IN SELECT id, chave_unificacao, nome, cpf FROM public.casos c WHERE c.operador_email = v_email AND c.id <> NEW.id
      AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
      AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
      AND NOT public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
     AND c.giro_fidelizacao_ate IS NULL
      AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
      ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_excedente LOOP
    UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL WHERE id = caso_rec.id;
    INSERT INTO public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em) VALUES (caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'LIBERACAO_AUTOMATICA_TETO_EXCEDIDO', NEW.operador_nome, v_email, 'Teto de ' || v_meta || ' casos excedido apos atribuicao manual -- liberado automaticamente (menor valor, fora dos 10 dias de fidelizacao)', now());
  END LOOP;
  RETURN NEW;
END; $function$
;

-- public.casos_elegiveis_liberacao_fidelizacao() · md5(prosrc) 0d5c511ab72252a94b1f750d4c92b598
CREATE OR REPLACE FUNCTION public.casos_elegiveis_liberacao_fidelizacao()
 RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, operador_nome text, data_ultimo_acionamento date, fidelizado_ate date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
  select c.id, c.aluno_id, c.operador_email, c.operador_nome,
    c.data_ultimo_acionamento,
    case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate
  from public.casos c
  left join public.alunos a on a.id = c.aluno_id
  where c.operador_email is not null and lower(c.operador_email) <> internal.carteira_geral_email()
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
    -- 26/10/2026: caso congelado nao e solto da carteira. Sem esta linha, a
    -- troca da regra soltaria 8 casos / R$ 7.584,60 na primeira passagem.
    and not public.caso_encerramento_congelado(c.id)
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
    and coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days') < now() - interval '1 day'
  order by c.data_ultimo_acionamento asc nulls first;
$function$
;

-- public.liberar_fidelizacao_caso(p_caso_id uuid, p_motivo text, p_autor text) · md5(prosrc) de8a3b43392c010c080adfcd9bd2560a
CREATE OR REPLACE FUNCTION public.liberar_fidelizacao_caso(p_caso_id uuid, p_motivo text DEFAULT 'FIDELIZACAO_EXPIRADA'::text, p_autor text DEFAULT 'sistema_fidelizacao'::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_c record;
begin
  select * into v_c from public.casos where id = p_caso_id for update;
  if not found or v_c.operador_email is null then return false; end if;
  -- Fidelizacao de 10 dias: dentro do prazo o caso nao e solto por caminho
  -- nenhum. Devolve false (nao levanta excecao) para o lote seguir em frente.
  if v_c.giro_fidelizacao_ate is not null then
    -- Caso de giro: nao volta ao pool por rotina automatica. Ate a data da
    -- fidelizacao por exclusividade; depois dela, para preservar o responsavel
    -- ate que outro operador assuma pelo fluxo normal.
    return false;
  end if;

  if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento) then return false; end if;
  update public.casos set operador_email=null, operador_nome=null, operador=null,
    caso_atualizado_por=p_autor, caso_atualizado_em=now()
  where id = p_caso_id;
  if v_c.aluno_id is not null then
    update public.alunos set responsavel_atual_email=null, responsavel_atual_nome=null
    where id = v_c.aluno_id;
  end if;
  insert into public.historico_operadores_alunos
    (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em)
  values (v_c.chave_unificacao, v_c.nome, v_c.cpf, p_motivo, v_c.operador_nome, v_c.operador_email,
    'Fidelizacao expirada (ultimo acionamento '||coalesce(v_c.data_ultimo_acionamento::text,'nunca')||' + 10d). Caso LIVRE, sem atribuicao automatica. Responsavel anterior preservado.', now());
  return true;
end;
$function$
;

-- public.liberar_casos_fidelizacao_vencida(p_limite integer) · md5(prosrc) 9177828bee57dbd931f5cce98acd174c
CREATE OR REPLACE FUNCTION public.liberar_casos_fidelizacao_vencida(p_limite integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare v_rec record; v_total int := 0;
begin
  if auth.jwt() is not null and not public.usuario_e_gestao_fila() then
    raise exception 'sem_permissao' using errcode='42501';
  end if;
  for v_rec in select * from public.casos_elegiveis_liberacao_fidelizacao() limit coalesce(p_limite, 100000)
  loop
    if public.liberar_fidelizacao_caso(v_rec.caso_id, 'FIDELIZACAO_EXPIRADA', 'fidelizacao_expirada_lote') then
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end;
$function$
;

-- internal.carteira_geral_trocar_dono(p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text) · md5(prosrc) dd78054e8e4d2542eb58eb61edd6cbb7
CREATE OR REPLACE FUNCTION internal.carteira_geral_trocar_dono(p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare
  v_data  date;
  v_hora  text;
  v_origem text;
  v_prox  text;
  v_conf  timestamptz;
  v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select data_retorno, hora_retorno, retorno_origem, proxima_acao, retorno_confirmado_em
    into v_data, v_hora, v_origem, v_prox, v_conf
    from public.alunos where id = p_aluno_id;

  perform internal.set_resp_aluno(p_aluno_id, p_novo_email, p_novo_nome,
                                  p_tipo, p_descricao, p_autor_email, p_autor_nome);

  -- Devolve o compromisso exatamente como estava. `limpar_retorno_origem` so
  -- apaga a origem quando a data e nula — com a data de volta, a origem fica.
  if v_data is not null then
    update public.alunos
       set data_retorno = v_data,
           hora_retorno = v_hora,
           retorno_origem = v_origem,
           proxima_acao = coalesce(v_prox, proxima_acao)
     where id = p_aluno_id;

    -- Em UPDATE separado, e de proposito. `tg_aluno_reset_retorno_confirmado`
    -- e BEFORE UPDATE OF data_retorno e zera retorno_confirmado_em sempre que a
    -- data muda — entao devolver os dois na mesma linha perderia a confirmacao.
    -- Mexendo so nesta coluna, aquele gatilho nao dispara.
    if v_conf is not null then
      update public.alunos set retorno_confirmado_em = v_conf where id = p_aluno_id;
    end if;
  end if;

  -- O caso tambem carrega a data; o UPDATE de titularidade nao a toca, mas a
  -- garantia fica explicita para quem ler depois.
  update public.casos
     set data_retorno = coalesce(data_retorno, v_data)
   where aluno_id = p_aluno_id;

  -- A agenda e do operador, nao do aluno: sem reapontar, o compromisso
  -- continuaria na lista de quem perdeu o caso. Data e hora (`retorno_em`)
  -- ficam intactas; so o dono muda.
  --
  -- Destino FILA LIVRE nao tem dono: manter a linha na agenda de quem perdeu o
  -- caso seria pior do que apaga-la. Ela e encerrada com o mesmo marcador que
  -- `assumir_caso_livre_aluno` ja usa ao liberar por troca. O compromisso em si
  -- NAO se perde: data, hora e origem ficam no aluno, e quem assumir o herda.
  if v_email is null then
    update public.operador_agenda
       set status = 'CANCELADO_LIBERACAO', atualizado_em = now()
     where aluno_id = p_aluno_id::text
       and coalesce(status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_LIBERACAO');
  else
    update public.operador_agenda
       set operador_email = v_email,
           operador_nome = p_novo_nome,
           atualizado_em = now()
     where aluno_id = p_aluno_id::text
       and coalesce(status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_LIBERACAO');
  end if;
end;
$function$
;

-- public.carteira_geral_previa(p_aluno_ids uuid[], p_destino_tipo text, p_destino_email text, p_mover_acordos boolean, p_filtros jsonb, p_acordo_ids uuid[]) · md5(prosrc) 774a8b340beb389706c66febc14db485
CREATE OR REPLACE FUNCTION public.carteira_geral_previa(p_aluno_ids uuid[], p_destino_tipo text, p_destino_email text DEFAULT NULL::text, p_mover_acordos boolean DEFAULT true, p_filtros jsonb DEFAULT '{}'::jsonb, p_acordo_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_destino_email text;
  v_destino_nome  text;
  v_previa_id uuid;
  v_itens jsonb;
  v_conflitos jsonb;
  v_res jsonb;
  v_sel uuid[] := coalesce(p_acordo_ids, '{}'::uuid[]);
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para remanejar carteira.' using errcode = '42501';
  end if;
  if p_destino_tipo not in ('CARTEIRA_GERAL','OPERADOR','FILA_LIVRE') then
    raise exception 'Destino invalido: %', p_destino_tipo;
  end if;
  if p_aluno_ids is null or array_length(p_aluno_ids,1) is null then
    raise exception 'Nenhum aluno selecionado.';
  end if;

  if p_destino_tipo = 'CARTEIRA_GERAL' then
    v_destino_email := internal.carteira_geral_email();
    v_destino_nome  := 'CARTEIRA GERAL';
  elsif p_destino_tipo = 'FILA_LIVRE' then
    v_destino_email := null;
    v_destino_nome  := null;
  else
    v_destino_email := lower(btrim(coalesce(p_destino_email,'')));
    select u.nome into v_destino_nome from public.usuarios u
      where lower(u.email) = v_destino_email and u.ativo and u.perfil = 'operador';
    if v_destino_nome is null then
      raise exception 'Operador de destino invalido ou inativo: %', p_destino_email;
    end if;
  end if;

  -- Fotografia por aluno. Le a titularidade nas TRES fontes, porque elas podem
  -- divergir: `casos.operador_email`, `alunos.responsavel_atual_email` e
  -- `acordos.operador_responsavel_email`.
  --
  -- O agendamento (data, hora e origem do retorno) tambem e congelado: ele
  -- SEGUE o aluno para o novo responsavel, e a execucao confere depois que
  -- continua igual ao que esta aqui.
  select coalesce(jsonb_agg(to_jsonb(t) order by t.saldo_total desc), '[]'::jsonb)
    into v_itens
    from (
      select c.aluno_id,
             c.id as caso_id,
             coalesce(c.nome, c.nome_aluno, al.nome) as nome,
             coalesce(c.cpf_limpo, c.cpf) as cpf,
             lower(nullif(btrim(coalesce(c.operador_email,'')),''))           as caso_de_email,
             lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),'')) as aluno_de_email,
             round(coalesce(s.saldo_mensalidade,0),2) as saldo_mensalidade,
             round(coalesce(s.saldo_acordo,0),2)      as saldo_acordo,
             round(coalesce(s.saldo_total,0),2)       as saldo_total,
             al.data_retorno   as retorno_data,
             al.hora_retorno   as retorno_hora,
             al.retorno_origem as retorno_origem,
             c.status_acionamento,
             c.encerrado_operacional as encerrado,
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'acordo_id', a.id,
                        'numero', a.numero_acordo,
                        'status', upper(coalesce(a.status,'')),
                        'de_email', lower(coalesce(a.operador_responsavel_email,'')),
                        'valor', round(coalesce(a.valor_total,0),2),
                        'de_terceiro', (lower(coalesce(a.operador_responsavel_email,''))
                                        is distinct from lower(coalesce(c.operador_email,''))),
                        -- A decisao, congelada. A execucao le daqui e nao recalcula.
                        'mover', case
                          when lower(coalesce(a.operador_responsavel_email,''))
                               is distinct from lower(coalesce(c.operador_email,''))
                            then a.id = any(v_sel)          -- terceiro: so por escolha explicita
                          else coalesce(p_mover_acordos, true)  -- do proprio dono
                        end)
                      order by a.numero_acordo), '[]'::jsonb)
                from public.acordos a
               where a.aluno_id = c.aluno_id
                 and lower(coalesce(a.status,'')) not in ('cancelado','cancelada')) as acordos
        from public.casos c
        join public.alunos al on al.id = c.aluno_id
        left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
       where c.aluno_id = any(p_aluno_ids)
    ) t;

  -- Conflitos e avisos. Acordo de terceiro aparece UM A UM, com tudo que a
  -- gestao precisa para decidir; os demais sao agregados na tela.
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_conflitos from (
    select jsonb_build_object(
             'tipo', 'TITULARIDADE_DIVERGENTE',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'detalhe', 'O caso e de '||coalesce(nullif(it->>'caso_de_email',''),'ninguem')||
                        ' e a ficha do aluno e de '||coalesce(nullif(it->>'aluno_de_email',''),'ninguem')||'.') as x
      from jsonb_array_elements(v_itens) it
     where coalesce(it->>'caso_de_email','') is distinct from coalesce(it->>'aluno_de_email','')

    union all
    -- Um conflito POR ACORDO DE TERCEIRO. Nunca agregado: e a decisao que a
    -- gestao tem de tomar item a item.
    select jsonb_build_object(
             'tipo', case when (ac->>'mover')::boolean
                          then 'ACORDO_DE_TERCEIRO_SELECIONADO'
                          else 'ACORDO_DE_TERCEIRO_FICA' end,
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'acordo_id', ac->>'acordo_id',
             'numero', ac->>'numero',
             'status', ac->>'status',
             'valor', ac->>'valor',
             'de_email', ac->>'de_email',
             'detalhe', 'Acordo '||coalesce(nullif(ac->>'numero',''),'sem numero')||
                        ' ('||coalesce(nullif(ac->>'status',''),'sem status')||', R$ '||coalesce(ac->>'valor','0')||')'||
                        ' e de '||coalesce(nullif(ac->>'de_email',''),'ninguem')||
                        case when (ac->>'mover')::boolean
                             then ' e VAI JUNTO porque foi selecionado.'
                             else ' e FICA com essa pessoa. Selecione o acordo se quiser leva-lo.' end)
      from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos') ac
     where (ac->>'de_terceiro')::boolean

    union all
    -- Acordo do proprio dono que NAO vai junto: aviso de consequencia.
    select jsonb_build_object(
             'tipo', 'ACORDO_DO_DONO_FICA',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'acordo_id', ac->>'acordo_id',
             'detalhe', 'Acordo '||coalesce(nullif(ac->>'numero',''),'sem numero')||
                        ' fica com o dono atual. Sem mensalidade em aberto, o gatilho'||
                        ' _aluno_segue_dono_do_acordo devolve o aluno para ele.')
      from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos') ac
     where not (ac->>'de_terceiro')::boolean and not (ac->>'mover')::boolean

    union all
    -- Nao e mais perda: o agendamento viaja com o aluno. Fica como aviso
    -- positivo para a gestao saber quantos compromissos mudam de mao.
    select jsonb_build_object(
             'tipo', 'RETORNO_AGENDADO_SEGUE',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'detalhe', 'Retorno de '||(it->>'retorno_data')||
                        coalesce(' as '||nullif(it->>'retorno_hora',''), '')||
                        ' e preservado e passa a responder ao novo responsavel.')
      from jsonb_array_elements(v_itens) it
     where nullif(it->>'retorno_data','') is not null

    union all
    select jsonb_build_object(
             'tipo', 'CASO_ENCERRADO',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'detalhe', 'Caso encerrado operacionalmente — mover nao o reabre.')
      from jsonb_array_elements(v_itens) it
     where (it->>'encerrado')::boolean
  ) c;

  -- Teto do operador de destino. Nao e conflito por item: e do lote inteiro.
  -- O gatilho trigger_impor_teto_operador libera o excedente sozinho (manda de
  -- volta para a fila livre, do menor valor para cima). Melhor a gestao saber
  -- ANTES de confirmar do que descobrir depois que 200 casos sumiram.
  if p_destino_tipo = 'OPERADOR' then
    declare v_teto int; v_carga int; v_depois int;
    begin
      v_teto := public.calibragem_teto_operador(v_destino_email);
      select count(*) into v_carga from public.casos c
       where lower(c.operador_email) = v_destino_email
         and not c.encerrado_operacional;
      v_depois := v_carga + jsonb_array_length(v_itens);
      if v_depois > v_teto then
        v_conflitos := v_conflitos || jsonb_build_object(
          'tipo', 'TETO_DO_OPERADOR',
          'aluno_id', null,
          'nome', v_destino_nome,
          'detalhe', v_destino_nome||' tem '||v_carga||' casos e ficaria com '||v_depois||
                     ', acima do teto de '||v_teto||'. O gatilho de teto vai soltar '||
                     (v_depois - v_teto)||' caso(s) para a fila livre, do menor valor para cima.');
      end if;
    end;
  end if;

  insert into public.carteira_geral_previas
    (criado_por_email, filtros, destino_tipo, destino_email, itens,
     total_alunos, total_acordos, total_valor, conflitos)
  values
    (v_autor, coalesce(p_filtros,'{}'::jsonb), p_destino_tipo, v_destino_email, v_itens,
     (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it),
     (select count(*)::int from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos') ac
       where (ac->>'mover')::boolean),
     (select coalesce(sum(s),0) from (
        select max((it->>'saldo_total')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
     v_conflitos)
  returning id into v_previa_id;

  select jsonb_build_object(
    'previa_id', v_previa_id,
    'destino_tipo', p_destino_tipo,
    'destino_email', v_destino_email,
    'destino_nome', coalesce(v_destino_nome, 'Fila livre'),
    'mover_acordos', coalesce(p_mover_acordos, true),
    -- ALUNOS distintos. A previa expande por aluno, entao um aluno com duas
    -- fichas aparece em dois itens: sao 2 casos, 1 aluno.
    'total_alunos', (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it),
    -- CASOS que serao movidos, e quantos deles estao encerrados. Encerrado nao
    -- aparece na lista da tela (incluir_encerrados e false por padrao), entao a
    -- gestao precisa ver aqui que ele vai junto.
    'total_casos', jsonb_array_length(v_itens),
    'total_casos_encerrados', (select count(*)::int from jsonb_array_elements(v_itens) it
                                where coalesce((it->>'encerrado')::boolean, false)),
    -- acordos que REALMENTE vao
    'total_acordos', (select count(*)::int from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos') ac
                       where (ac->>'mover')::boolean),
    'acordos_de_terceiros', (select count(*)::int from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos') ac
                              where (ac->>'de_terceiro')::boolean),
    'acordos_de_terceiros_selecionados', (select count(*)::int from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos') ac
                              where (ac->>'de_terceiro')::boolean and (ac->>'mover')::boolean),
    'retornos_preservados', (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it
                              where nullif(it->>'retorno_data','') is not null),
    'total_valor', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_total')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
    'total_mensalidade', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_mensalidade')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
    'total_acordo_valor', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_acordo')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
    'itens', v_itens,
    'conflitos', v_conflitos
  ) into v_res;

  return v_res;
end;
$function$
;

-- public.carteira_geral_mover(p_previa_id uuid, p_motivo text) · md5(prosrc) a2223d068d8154258e5f1a8450911bea
CREATE OR REPLACE FUNCTION public.carteira_geral_mover(p_previa_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
 SET statement_timeout TO '300s'
AS $function$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_autor_nome text;
  v_motivo text := nullif(btrim(coalesce(p_motivo,'')),'');
  v_previa public.carteira_geral_previas;
  v_lote uuid := gen_random_uuid();
  v_destino_email text;
  v_destino_nome  text;
  r_al          record;
  it            jsonb;
  ac            jsonb;
  v_caso_agora  text;
  v_aluno_agora text;
  v_ac_email    text;
  v_ac_status   text;
  v_movidos     int := 0;
  v_casos_mov   int := 0;
  v_recusados   jsonb := '[]'::jsonb;
  v_acordos_mov int := 0;
  v_rec_por_acordo int := 0;
  v_falha       text;
  v_ac_falha    text;
  v_ac_detalhe  jsonb;
  v_ac_n        int;
  v_retornos    int := 0;
  v_acordos     jsonb;
  v_casos_previa uuid[];
  v_casos_hoje   uuid[];
  v_primeira     boolean;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para remanejar carteira.' using errcode = '42501';
  end if;
  if v_motivo is null then
    raise exception 'Informe o motivo do remanejamento.' using errcode = '22023';
  end if;

  select * into v_previa from public.carteira_geral_previas where id = p_previa_id for update;
  if not found then raise exception 'Previa nao encontrada.'; end if;
  if v_previa.executada_em is not null then
    raise exception 'Esta previa ja foi executada em %.', v_previa.executada_em;
  end if;
  if now() > v_previa.expira_em then
    raise exception 'Previa expirada (gerada em %). Gere uma nova.', v_previa.criado_em;
  end if;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_autor limit 1;

  v_destino_email := v_previa.destino_email;
  if v_destino_email is not null then
    select coalesce(u.nome, v_destino_email) into v_destino_nome
      from public.usuarios u where lower(u.email) = lower(v_destino_email);
  end if;

  -- Laco por ALUNO, nao por item: a escrita sempre foi por aluno, e percorrer
  -- item fazia o executor recusar a si mesmo na segunda ficha do mesmo aluno.
  for r_al in
    select (i.value->>'aluno_id')::uuid                      as aluno_id,
           min(i.value->>'nome')                             as nome,
           min(i.value->>'cpf')                              as cpf,
           min(nullif(i.value->>'aluno_de_email',''))        as aluno_de_email,
           min(nullif(i.value->>'caso_de_email',''))         as caso_de_email,
           max(coalesce((i.value->>'saldo_mensalidade')::numeric,0)) as saldo_mensalidade,
           max(coalesce((i.value->>'saldo_acordo')::numeric,0))      as saldo_acordo,
           max(nullif(i.value->>'retorno_data',''))          as retorno_data
      from jsonb_array_elements(v_previa.itens) i
     group by 1
     order by max(coalesce((i.value->>'saldo_total')::numeric,0)) desc
  loop
    v_falha := null;

    -- ---------------- revalidacao: TODOS os casos, um por um ----------------
    select array_agg((i.value->>'caso_id')::uuid)
      into v_casos_previa
      from jsonb_array_elements(v_previa.itens) i
     where (i.value->>'aluno_id')::uuid = r_al.aluno_id
       and nullif(i.value->>'caso_id','') is not null;

    for it in
      select i.value from jsonb_array_elements(v_previa.itens) i
       where (i.value->>'aluno_id')::uuid = r_al.aluno_id
    loop
      select lower(nullif(btrim(coalesce(c.operador_email,'')),''))
        into v_caso_agora
        from public.casos c where c.id = (it->>'caso_id')::uuid;

      if not found then
        v_falha := 'o caso '||coalesce(it->>'caso_id','?')||' nao existe mais';
      elsif coalesce(v_caso_agora,'') is distinct from coalesce(it->>'caso_de_email','') then
        v_falha := 'o dono de um dos casos mudou depois da previa (previa: '||
                   coalesce(nullif(it->>'caso_de_email',''),'ninguem')||', agora: '||
                   coalesce(v_caso_agora,'ninguem')||')';
      end if;
      exit when v_falha is not null;
    end loop;

    -- caso NOVO depois da previa: a escrita e `where aluno_id`, entao ela
    -- alcancaria um caso que a previa nunca mostrou. Melhor recusar.
    if v_falha is null then
      select array_agg(c.id) into v_casos_hoje
        from public.casos c where c.aluno_id = r_al.aluno_id;
      if exists (select 1 from unnest(coalesce(v_casos_hoje,'{}'::uuid[])) x
                  where not (x = any(coalesce(v_casos_previa,'{}'::uuid[])))) then
        v_falha := 'o aluno ganhou um caso novo depois da previa -- gere uma previa nova';
      end if;
    end if;

    -- a ficha, uma vez por aluno
    if v_falha is null then
      select lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),''))
        into v_aluno_agora
        from public.alunos al where al.id = r_al.aluno_id;
      if coalesce(v_aluno_agora,'') is distinct from coalesce(r_al.aluno_de_email,'') then
        v_falha := 'a ficha do aluno mudou de responsavel depois da previa (previa: '||
                   coalesce(r_al.aluno_de_email,'ninguem')||', agora: '||
                   coalesce(v_aluno_agora,'ninguem')||')';
      end if;
    end if;

    if v_falha is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'nivel', 'ALUNO',
        'aluno_id', r_al.aluno_id, 'nome', r_al.nome,
        'motivo', 'NADA deste aluno foi movido: '||v_falha||'.');
      continue;
    end if;

    -- ---------------- acordos do aluno, sem repetir ------------------------
    -- A previa repete o mesmo array de acordos em cada ficha do aluno; aqui ele
    -- e deduplicado por acordo_id, senao o mesmo acordo seria validado e movido
    -- uma vez por ficha.
    select coalesce(jsonb_agg(z.x), '[]'::jsonb) into v_acordos
      from (select distinct on (a.value->>'acordo_id') a.value as x
              from jsonb_array_elements(v_previa.itens) i,
                   jsonb_array_elements(i.value->'acordos') a
             where (i.value->>'aluno_id')::uuid = r_al.aluno_id
             order by a.value->>'acordo_id') z;

    -- PASSO 1: revalida TODOS os acordos selecionados, SEM ESCREVER.
    v_ac_falha := null;
    for ac in select a.value from jsonb_array_elements(v_acordos) a loop
      if not coalesce((ac->>'mover')::boolean, false) then
        continue;
      end if;

      select lower(coalesce(a.operador_responsavel_email,'')), upper(coalesce(a.status,''))
        into v_ac_email, v_ac_status
        from public.acordos a where a.id = (ac->>'acordo_id')::uuid;

      if not found then
        v_ac_falha := 'o acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' nao existe mais';
      elsif v_ac_email is distinct from coalesce(ac->>'de_email','') then
        v_ac_falha := 'o responsavel do acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' mudou depois da previa (previa: '||
                      coalesce(nullif(ac->>'de_email',''),'ninguem')||', agora: '||
                      coalesce(nullif(v_ac_email,''),'ninguem')||')';
      elsif v_ac_status is distinct from coalesce(ac->>'status','') then
        v_ac_falha := 'o status do acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' mudou depois da previa ('||coalesce(ac->>'status','-')||
                      ' -> '||coalesce(v_ac_status,'-')||')';
      end if;

      exit when v_ac_falha is not null;
    end loop;

    if v_ac_falha is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'nivel', 'ALUNO',
        'aluno_id', r_al.aluno_id, 'nome', r_al.nome,
        'motivo', 'NADA deste aluno foi movido -- caso, ficha, acordos e agenda '||
                  'ficaram como estavam: '||v_ac_falha||'.');
      v_rec_por_acordo := v_rec_por_acordo + 1;
      continue;
    end if;

    -- ---------------- PASSO 2: dai sim, escreve ---------------------------
    v_ac_n := 0;
    v_ac_detalhe := '[]'::jsonb;

    for ac in select a.value from jsonb_array_elements(v_acordos) a loop
      if not coalesce((ac->>'mover')::boolean, false) then
        continue;
      end if;

      perform internal.set_resp_acordo(
        (ac->>'acordo_id')::uuid, v_destino_email, v_destino_nome,
        'CARTEIRA_GERAL_REMANEJAMENTO',
        'Acordo segue o aluno no remanejamento -> '||coalesce(v_destino_nome,'fila livre')||
        '. Motivo: '||v_motivo||'. Lote: '||v_lote::text||'. (autoria do acordo NAO muda)',
        v_autor, coalesce(v_autor_nome, v_autor));

      v_ac_n := v_ac_n + 1;
      v_ac_detalhe := v_ac_detalhe || jsonb_build_object(
        'acordo_id', ac->>'acordo_id',
        'numero', ac->>'numero',
        'de_email', ac->>'de_email',
        'status_no_lote', ac->>'status',
        'de_terceiro', coalesce((ac->>'de_terceiro')::boolean, false),
        'para_email', v_destino_email);
    end loop;

    v_acordos_mov := v_acordos_mov + v_ac_n;

    perform internal.carteira_geral_trocar_dono(
      r_al.aluno_id, v_destino_email, v_destino_nome,
      'CARTEIRA_GERAL_REMANEJAMENTO',
      'Remanejamento em lote -> '||coalesce(v_destino_nome,'fila livre')||'. Motivo: '||v_motivo||
      '. Lote: '||v_lote::text||'. Agendamento de retorno preservado.',
      v_autor, coalesce(v_autor_nome, v_autor));

    update public.casos
       set operador_email = lower(v_destino_email),
           operador_nome  = v_destino_nome,
           operador       = upper(coalesce(v_destino_nome,'')),
           caso_atualizado_por = v_autor,
           caso_atualizado_em  = now()
     where aluno_id = r_al.aluno_id;

    if r_al.retorno_data is not null then
      v_retornos := v_retornos + 1;   -- uma vez por ALUNO: o retorno mora na ficha
    end if;

    -- ---------------- UMA LINHA POR CASO ----------------------------------
    -- O detalhe dos acordos vai so na PRIMEIRA linha do aluno: acordo pertence
    -- ao aluno, e repeti-lo faria o desfazer devolver o mesmo acordo N vezes.
    v_primeira := true;
    for it in
      select i.value from jsonb_array_elements(v_previa.itens) i
       where (i.value->>'aluno_id')::uuid = r_al.aluno_id
       order by i.value->>'caso_id'
    loop
      insert into public.carteira_geral_auditoria
        (previa_id, lote_id, autor_email, autor_nome, motivo, destino_tipo,
         aluno_id, caso_id, nome_aluno, cpf,
         caso_de_email, caso_para_email, aluno_de_email, aluno_para_email,
         acordos_movidos, acordos_detalhe, valor_mensalidade, valor_acordo)
      values
        (p_previa_id, v_lote, v_autor, v_autor_nome, v_motivo, v_previa.destino_tipo,
         r_al.aluno_id, nullif(it->>'caso_id','')::uuid, it->>'nome', it->>'cpf',
         nullif(it->>'caso_de_email',''), v_destino_email,
         nullif(it->>'aluno_de_email',''), v_destino_email,
         case when v_primeira then v_ac_n else 0 end,
         case when v_primeira then v_ac_detalhe else '[]'::jsonb end,
         case when v_primeira then coalesce((it->>'saldo_mensalidade')::numeric,0) else 0 end,
         case when v_primeira then coalesce((it->>'saldo_acordo')::numeric,0) else 0 end);

      v_casos_mov := v_casos_mov + 1;
      v_primeira := false;
    end loop;

    v_movidos := v_movidos + 1;
  end loop;

  update public.carteira_geral_previas
     set executada_em = now(), executada_por_email = v_autor
   where id = p_previa_id;

  return jsonb_build_object(
    'ok', true,
    'lote_id', v_lote,
    'previa_id', p_previa_id,
    'destino_tipo', v_previa.destino_tipo,
    'destino_email', v_destino_email,
    'destino_nome', coalesce(v_destino_nome, 'Fila livre'),
    'alunos_movidos', v_movidos,
    'casos_movidos', v_casos_mov,
    'acordos_movidos', v_acordos_mov,
    'alunos_recusados_por_acordo', v_rec_por_acordo,
    'retornos_preservados', v_retornos,
    'recusados', v_recusados,
    'total_recusados', jsonb_array_length(v_recusados));
end;
$function$
;

-- public.carteira_geral_desfazer_lote(p_lote_id uuid, p_motivo text) · md5(prosrc) 1e77a2b1e9998f056bca60a05792ffe0
CREATE OR REPLACE FUNCTION public.carteira_geral_desfazer_lote(p_lote_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
 SET statement_timeout TO '300s'
AS $function$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_autor_nome text;
  v_motivo text := coalesce(nullif(btrim(coalesce(p_motivo,'')),''), 'Desfazer remanejamento');
  r_al record; ac jsonb;
  v_nome_de text;
  v_caso_agora text; v_aluno_agora text;
  v_ac_email text; v_ac_status text;
  v_bloqueio text;
  v_n int := 0; v_casos int := 0; v_ac int := 0;
  v_recusados jsonb := '[]'::jsonb;
  v_casos_lote uuid[];
  v_acordos jsonb;
  v_caso_id uuid;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para desfazer remanejamento.' using errcode = '42501';
  end if;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_autor limit 1;

  -- Laco por ALUNO: a partir desta versao o lote tem uma linha POR CASO, e
  -- percorrer linha devolveria o mesmo aluno varias vezes.
  for r_al in
    select a.aluno_id,
           min(a.previa_id::text)::uuid as previa_id,
           min(a.nome_aluno)            as nome_aluno,
           min(a.caso_de_email)         as caso_de_email,
           min(a.caso_para_email)       as caso_para_email,
           min(a.aluno_de_email)        as aluno_de_email,
           min(a.aluno_para_email)      as aluno_para_email
      from public.carteira_geral_auditoria a
     where a.lote_id = p_lote_id and a.desfeito_em is null
     group by a.aluno_id
     order by min(a.registrado_em)
  loop
    v_bloqueio := null;

    -- TODOS os casos que o lote moveu para este aluno. A UNIAO com a previa e o
    -- que torna verificavel um lote gravado ANTES desta migration: o 559b20bb
    -- tem 6 linhas de auditoria para 8 casos, e os 2 que faltam estao na previa.
    -- O historico do lote nao e reescrito -- ele e apenas lido por inteiro.
    select array_agg(distinct z.cid) into v_casos_lote
      from (
        select a.caso_id as cid
          from public.carteira_geral_auditoria a
         where a.lote_id = p_lote_id and a.aluno_id = r_al.aluno_id
           and a.caso_id is not null
        union
        select (i.value->>'caso_id')::uuid
          from public.carteira_geral_previas p,
               jsonb_array_elements(p.itens) i
         where p.id = r_al.previa_id
           and (i.value->>'aluno_id')::uuid = r_al.aluno_id
           and nullif(i.value->>'caso_id','') is not null
      ) z;

    -- Confere CADA caso, sem LIMIT 1. Dois casos em que so um mudou tem de
    -- recusar o aluno inteiro -- era isso que o LIMIT 1 deixava passar,
    -- dependendo de qual linha o banco devolvia.
    foreach v_caso_id in array coalesce(v_casos_lote, '{}'::uuid[]) loop
      select lower(nullif(btrim(coalesce(c.operador_email,'')),''))
        into v_caso_agora
        from public.casos c where c.id = v_caso_id;

      if not found then
        v_bloqueio := 'O caso '||v_caso_id::text||' nao existe mais.';
      elsif v_caso_agora is distinct from lower(nullif(r_al.caso_para_email,'')) then
        v_bloqueio := 'O caso '||v_caso_id::text||' saiu de '||
                      coalesce(nullif(r_al.caso_para_email,''),'fila livre')||
                      ' depois do lote (agora: '||coalesce(v_caso_agora,'fila livre')||
                      '). Foi assumido ou movido de novo -- desfazer apagaria esse trabalho.';
      end if;
      exit when v_bloqueio is not null;
    end loop;

    if v_bloqueio is null then
      select lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),''))
        into v_aluno_agora
        from public.alunos al where al.id = r_al.aluno_id;
      if v_aluno_agora is distinct from lower(nullif(r_al.aluno_para_email,'')) then
        v_bloqueio := 'A ficha do aluno saiu de '||coalesce(nullif(r_al.aluno_para_email,''),'fila livre')||
                      ' depois do lote (agora: '||coalesce(v_aluno_agora,'fila livre')||').';
      end if;
    end if;

    -- acordos do aluno no lote, uniao das linhas dele
    select coalesce(jsonb_agg(distinct e.x), '[]'::jsonb) into v_acordos
      from public.carteira_geral_auditoria a,
           jsonb_array_elements(a.acordos_detalhe) e(x)
     where a.lote_id = p_lote_id and a.aluno_id = r_al.aluno_id
       and a.desfeito_em is null;

    if v_bloqueio is null then
      for ac in select a.value from jsonb_array_elements(v_acordos) a loop
        select lower(coalesce(a.operador_responsavel_email,'')), upper(coalesce(a.status,''))
          into v_ac_email, v_ac_status
          from public.acordos a where a.id = (ac->>'acordo_id')::uuid;

        if v_ac_email is null then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||' nao existe mais.';
          exit;
        end if;
        if v_ac_email is distinct from lower(coalesce(ac->>'para_email','')) then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||
                        ' mudou de responsavel depois do lote (agora: '||
                        coalesce(nullif(v_ac_email,''),'ninguem')||').';
          exit;
        end if;
        if v_ac_status is distinct from upper(coalesce(ac->>'status_no_lote','')) then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||
                        ' mudou de status depois do lote ('||coalesce(ac->>'status_no_lote','-')||
                        ' -> '||coalesce(v_ac_status,'-')||').';
          exit;
        end if;
      end loop;
    end if;

    if v_bloqueio is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'aluno_id', r_al.aluno_id, 'nome', r_al.nome_aluno, 'motivo', v_bloqueio);
      continue;   -- nenhuma linha deste aluno e marcada como desfeita
    end if;

    select coalesce(u.nome, r_al.aluno_de_email) into v_nome_de
      from public.usuarios u where lower(u.email) = lower(r_al.aluno_de_email);

    for ac in select a.value from jsonb_array_elements(v_acordos) a loop
      perform internal.set_resp_acordo(
        (ac->>'acordo_id')::uuid, nullif(ac->>'de_email',''),
        (select coalesce(u.nome, ac->>'de_email') from public.usuarios u
          where lower(u.email) = lower(ac->>'de_email')),
        'CARTEIRA_GERAL_DESFAZER',
        'Desfeito o lote '||p_lote_id::text||'. Motivo: '||v_motivo||'.',
        v_autor, coalesce(v_autor_nome, v_autor));
      v_ac := v_ac + 1;
    end loop;

    perform internal.carteira_geral_trocar_dono(
      r_al.aluno_id, r_al.aluno_de_email, v_nome_de,
      'CARTEIRA_GERAL_DESFAZER',
      'Desfeito o lote '||p_lote_id::text||'. Motivo: '||v_motivo||'. Agendamento preservado.',
      v_autor, coalesce(v_autor_nome, v_autor));

    update public.casos
       set operador_email = lower(r_al.caso_de_email),
           operador_nome  = v_nome_de,
           operador       = upper(coalesce(v_nome_de,'')),
           caso_atualizado_por = v_autor,
           caso_atualizado_em  = now()
     where aluno_id = r_al.aluno_id;

    v_casos := v_casos + coalesce(array_length(v_casos_lote,1),0);

    update public.carteira_geral_auditoria
       set desfeito_em = now(), desfeito_por_email = v_autor
     where lote_id = p_lote_id and aluno_id = r_al.aluno_id and desfeito_em is null;

    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'lote_id', p_lote_id,
                            'alunos_devolvidos', v_n,
                            'casos_devolvidos', v_casos,
                            'acordos_devolvidos', v_ac,
                            'recusados', v_recusados,
                            'total_recusados', jsonb_array_length(v_recusados));
end;
$function$
;

-- public.carteira_geral_definir_recebimento(p_operador_email text, p_recebe boolean, p_motivo text) · md5(prosrc) c9405d87d20e4970a3a0757efe115e1f
CREATE OR REPLACE FUNCTION public.carteira_geral_definir_recebimento(p_operador_email text, p_recebe boolean, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_autor text := lower(coalesce(auth.jwt()->>'email','')); v_nome text;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao.' using errcode = '42501';
  end if;

  update public.usuarios
     set recebe_novos_casos = coalesce(p_recebe, true)
   where lower(email) = lower(btrim(coalesce(p_operador_email,'')))
     and perfil = 'operador'
  returning nome into v_nome;

  if v_nome is null then
    raise exception 'Operador nao encontrado: %', p_operador_email;
  end if;

  -- `aluno_movimentacoes` exige aluno_id (NOT NULL) e isto nao e sobre um
  -- aluno: e sobre um operador. Vai na auditoria generica.
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values (v_autor, 'CARTEIRA_GERAL_RECEBIMENTO', 'usuarios',
          jsonb_build_object(
            'operador', v_nome,
            'operador_email', lower(btrim(p_operador_email)),
            'recebe_novos_casos', coalesce(p_recebe, true),
            'motivo', coalesce(nullif(btrim(coalesce(p_motivo,'')),''),'nao informado')));

  return jsonb_build_object('ok', true, 'operador', v_nome, 'recebe', coalesce(p_recebe, true));
end;
$function$
;

-- public.calibragem_executar_simulacao(p_id uuid) · md5(prosrc) 9f5ff16f64b5efbd4b0ae58b32c8bac6
CREATE OR REPLACE FUNCTION public.calibragem_executar_simulacao(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_executados int := 0; v_pulados int := 0; r record; v_aluno uuid;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar a Calibragem.'; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status <> 'APROVADA' then raise exception 'Simulação precisa estar APROVADA (atual: %).', v_sim.status; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_simulacao'));
  create temp table _exec on commit drop as
  select (m->>'caso_id')::uuid caso_id, m->>'de_email' de_email, m->>'de_nome' de_nome,
         m->>'para_email' para_email, m->>'para_nome' para_nome, (m->>'valor')::numeric valor,
         m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome, false as valido
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;
  update _exec e set valido = true from public.casos c
  where c.id = e.caso_id and c.operador_email = e.de_email
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    -- Acionado depois da simulacao? Voltou a ter dono pelos 10 dias: nao move.
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento);
  select count(*) filter (where not valido) into v_pulados from _exec;
  update public.casos c set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador='Retirado por nivelamento', nivelamento_em=now(), nivelamento_simulacao_id=p_id
    from _exec e where e.valido and c.id = e.caso_id;
  update public.casos c set operador_email=e.para_email, operador_nome=e.para_nome, operador=upper(coalesce(e.para_nome,''))
    from _exec e where e.valido and c.id = e.caso_id;
  for r in select * from _exec where valido loop
    select c.aluno_id into v_aluno from public.casos c where c.id = r.caso_id;
    insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
      operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
      valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
    values ('MOVIMENTACAO_NIVELAMENTO', p_id, r.caso_id, v_aluno, r.cpf, r.nome, r.de_email, r.de_nome, r.para_email, r.para_nome,
      r.valor, r.motivo, upper(coalesce(v_sim.resultado->>'metrica','SALDO')),
      jsonb_build_object('operador_email', r.de_email, 'operador_nome', r.de_nome),
      jsonb_build_object('operador_email', r.para_email, 'operador_nome', r.para_nome, 'marcador','Retirado por nivelamento'),
      v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email);
    v_executados := v_executados + 1;
  end loop;
  update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'EXECUTADA', 'executados', v_executados, 'pulados', v_pulados);
end; $function$
;

-- gatilhos de producao em public.casos que decidem aqui
CREATE TRIGGER trg_giro_limpar_marca BEFORE UPDATE ON public.casos FOR EACH ROW WHEN ((new.operador_email IS DISTINCT FROM old.operador_email)) EXECUTE FUNCTION giro_limpar_marca_ao_trocar_dono();
CREATE TRIGGER trigger_impor_teto_operador AFTER UPDATE ON public.casos FOR EACH ROW WHEN (((new.operador_email IS NOT NULL) AND (new.operador_email IS DISTINCT FROM old.operador_email))) EXECUTE FUNCTION trg_impor_teto_operador();

-- ============================================================================
-- ADENDO: funcoes de producao que a #936 exige no estado anterior (precheck
-- "esperava as 7 funcoes"). Definicoes por pg_get_functiondef em 17/11/2026,
-- md5(prosrc) conferido abaixo. Sem edicao manual.
do $$ begin if not exists (select 1 from pg_roles where rolname = 'reativa_responsavel_executor') then create role reativa_responsavel_executor nologin; end if; end $$;

-- public.assumir_caso_livre · md5(prosrc) 607a8b4fb8a0aba2f0ecda830b1c6e2c · owner postgres · acl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.assumir_caso_livre(p_caso_id uuid)
 RETURNS TABLE(sucesso boolean, mensagem text, caso_liberado uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare
  v_email text; v_nome text; v_upper text; v_new record; v_new_saldo numeric; v_count int;
  v_rel record; v_liberado uuid := null;
  -- v_teto: teto oficial da gestao. v_pool: qual das tres carteiras de livre
  -- assuncao cedeu o caso (nulo quando veio da fila livre ou de um caso de giro).
  v_teto int; v_pool text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  if v_email = '' then return query select false,'Usuario nao identificado. Faca login novamente.',null::uuid; return; end if;
  v_nome := public.nome_operador_por_email(v_email);
  if v_nome is null then return query select false,'Operador nao ativo ou nao identificado.',null::uuid; return; end if;
  if not internal.operador_pode_receber_caso(v_email) then return query select false,'Sua carteira esta fechada para casos novos. Fale com a gestao.',null::uuid; return; end if;
  v_upper := upper(v_nome);
  select c.*, public.saldo_titulos_aberto(c.cpf_limpo) AS _saldo into v_new
    from public.casos c where c.id = p_caso_id for update;
  if not found then return query select false,'Caso nao encontrado.',null::uuid; return; end if;
  if coalesce(v_new.operador_email,'') <> '' then
    -- Artigo 2: Carteira Geral, carteira da gestao e antiga carteira da Olga
    -- sao de LIVRE ASSUNCAO -- qualquer operador assume na hora, sem esperar os
    -- 10 dias. O criterio e estrutural: o dono atual nao e operador ativo.
    select case
             when lower(v_new.operador_email) = internal.carteira_geral_email()
               then 'Carteira Geral'
             when not exists (select 1 from public.usuarios u
                               where lower(u.email) = lower(v_new.operador_email)
                                 and u.ativo and u.perfil = 'operador')
               then 'carteira de ' || coalesce((select u.nome from public.usuarios u
                                                 where lower(u.email) = lower(v_new.operador_email)
                                                 limit 1), v_new.operador_email)
           end into v_pool;

    if public.caso_em_giro_fidelizacao(v_new.giro_fidelizacao_ate) then
      return query select false,'Este caso está fidelizado pelo giro de carteira até 26/10/2026.',null::uuid; return;
    end if;
    if v_pool is null and v_new.giro_fidelizacao_ate is null then
      return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
    end if;
    -- Caso de giro com a fidelizacao ja vencida: segue adiante e troca o dono.
  end if;
  if public.caso_protegido_redistribuicao(v_new.cpf_limpo,v_new.status_acionamento,v_new.nao_acionar,v_new.status_financeiro,v_new.valor_pago,v_new.quitado_em,v_new.valor_quitado)
     or public.caso_encerrado_operacional(v_new.cpf_limpo,v_new.status_atual,v_new.status_acionamento,v_new.status_financeiro,v_new.status_jornada)
     or coalesce(v_new._saldo,0) <= 0 then
    return query select false,'Caso nao elegivel (protegido, encerrado ou sem saldo).',null::uuid; return;
  end if;
  v_new_saldo := v_new._saldo;
  -- Teto oficial da gestao, nao numero literal.
  v_teto := public.calibragem_teto_operador(v_email);
  -- MESMA base que `trg_impor_teto_operador` cobra: nao protegido e nao
  -- encerrado. A base antiga (carteira inteira menos confirmacao financeira)
  -- dava ~1.000 por operador e por isso recusava toda assuncao.
  v_count := (select count(*) from public.casos c where c.operador_email = v_email
                 and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
                 and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada));
  if v_count >= v_teto then
    select c.id into v_rel from public.casos c
    where c.operador_email = v_email and c.ultima_tabulacao_em is null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc, c.caso_atualizado_em desc nulls last
    limit 1 for update skip locked;
    if v_rel.id is null then
      return query select false,'Carteira cheia ('||v_teto||' casos) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;
    end if;
    v_liberado := v_rel.id;
    update public.casos set operador_email=null, operador_nome=null, operador=null where id = v_liberado;
    insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_anterior_nome,operador_anterior_email,observacao,criado_em)
    select chave_unificacao,nome,cpf,'LIBERACAO_TROCA_ASSUMIR',v_nome,v_email,'Liberado por troca ao assumir caso '||p_caso_id::text||'.',now()
    from public.casos where id = v_liberado;
  end if;
  update public.casos set operador_email=v_email, operador_nome=v_nome, operador=v_upper,
    caso_atualizado_por=v_email, caso_atualizado_em=now()
  where id = p_caso_id;
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_nome,operador_email,observacao,criado_em)
  select chave_unificacao,nome,cpf,'ASSUMIR_ATENDIMENTO',v_nome,v_email,
    'Assumido de '||coalesce(v_pool,'fila livre')||'. assumido_por='||v_email||' assumido_em='||now()::text||'. Fidelizacao inicia apenas apos acionamento valido.', now()
  from public.casos where id = p_caso_id;
  if (select count(*) from public.casos c where c.operador_email = v_email
                 and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
                 and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)) > v_teto then
    raise exception 'ROLLBACK: operador ficaria com mais de % casos (teto vigente).', v_teto;
  end if;
  return query select true, 'Atendimento assumido. Acione dentro do prazo operacional para iniciar a fidelizacao de 10 dias.', v_liberado;
end;
$function$;

-- public.casos_risco_perder · md5(prosrc) 702279a5830bdbe566bc7140563bc3ed · owner postgres · acl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.casos_risco_perder(p_email text DEFAULT NULL::text)
 RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, data_ultimo_acionamento date, dias_parado integer, nunca_acionado boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_jwt text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_alvo text := nullif(lower(coalesce(p_email,'')),'');
begin
  -- Operador so enxerga a propria carteira; gestao/diretoria enxerga todas.
  if v_jwt <> '' and not (public.usuario_e_gestao() or public.usuario_tem_visao_geral()) then
    v_alvo := v_jwt;
  end if;

  return query
  select c.id, c.aluno_id, c.operador_email, c.data_ultimo_acionamento,
         case when c.data_ultimo_acionamento is null then null
              else (current_date - c.data_ultimo_acionamento)::int end,
         (c.data_ultimo_acionamento is null)
  from public.casos c
  where c.operador_email is not null
    -- Sem aluno nao ha o que acionar: o caso nao entra no card nem na lista.
    and c.aluno_id is not null
    and (v_alvo is null or lower(c.operador_email) = v_alvo)
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
  order by (c.data_ultimo_acionamento is null) desc, c.data_ultimo_acionamento asc nulls first;
end;
$function$;

-- public.usuario_e_gestao · md5(prosrc) 889cfa4a82e9046b4322e8c85ee07b7d · owner postgres · acl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,reativa_responsavel_executor=X/postgres}
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
