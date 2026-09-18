-- PRODUCAO DE 18/09/2026, SO ESTRUTURA -- NENHUM DADO. Tabelas com as colunas
-- reais; links_pagamento, baixas_pagamento e usuarios reduzidas as colunas que
-- estas funcoes leem.
-- Gerado para supabase/tests/grupo_a_confirmacao_prime.test.js. As funcoes
-- abaixo sao o texto exato de pg_get_functiondef; o md5 de cada corpo esta em
-- grupo_a_prod_20260918.md5.json e o teste o confere antes de usar.

create extension if not exists unaccent;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

-- auth do Supabase: as mesmas leituras de request.jwt.claims
create schema if not exists auth;
create schema if not exists internal;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;

create table public.alunos (
  id uuid default gen_random_uuid() not null primary key,
  cpf text, cpf_mascarado text, matricula text, nome text not null, email text, telefone text,
  curso text, unidade text, semestre text, situacao_academica text,
  status_jornada text default 'Em cobrança'::text, origem text, aluno_novo boolean default false,
  sem_telefone boolean default false, sem_email boolean default false,
  created_at timestamp without time zone default now(), updated_at timestamp without time zone default now(),
  nome_normalizado text, operador text, status_atual text, ultimo_contato date, data_retorno date,
  valor_em_aberto numeric(12,2) default 0, hora_retorno text, atualizado_em timestamp with time zone default now(),
  operador_nome text, operador_email text, observacao text, tipo_base text, nome_aluno text,
  nome_referencia text, cpf_corrigido text, cpf_status_correcao text, registro_unico uuid default gen_random_uuid(),
  chave_unificacao text, unificacao_status text, registrado_por_nome text, registrado_por_email text,
  registrado_em timestamp with time zone, responsavel_atual_nome text, responsavel_atual_email text,
  responsavel_atual_em timestamp with time zone, status_acionamento text, proxima_acao text,
  data_ultimo_acionamento timestamp with time zone, status_link_pagamento text, status_baixa_pagamento text,
  fila_destino text, ultimo_link_pagamento_id uuid, ultima_baixa_pagamento_id uuid, nivel_criticidade text,
  processo_numero text, processo_prazo_tipo text, processo_prazo_data date, nome_resp1 text, telefone_resp1 text,
  nome_resp2 text, telefone_resp2 text, situacao_operacional text, saldo_vencido numeric, saldo_total numeric,
  curso_real text, academico_codigo text, academico_fonte text, academico_atualizado_em timestamp with time zone,
  retorno_confirmado_em timestamp with time zone, retorno_origem text, semestre_divida text,
  semestre_divida_em timestamp with time zone
);
create index idx_alunos_cpf_normalizado on public.alunos (lpad(regexp_replace(coalesce(cpf, ''::text), '\D'::text, ''::text, 'g'::text), 11, '0'::text));

create table public.casos (
  id uuid default gen_random_uuid() not null primary key,
  caso_codigo integer, cpf_original text, cpf_limpo text, cpf_mascarado text, matricula text, nome text,
  nome_normalizado text, operador_base text, operador_mensalidade text, operador_acordo text,
  operador_acordo_planilha text, status_atual text, data_ultimo_acionamento date, status_acionamento text,
  criticidade text, proxima_acao_automatica text, total_em_aberto numeric, data_retorno date, dias_atraso integer,
  nivel_carteira text, sla_operacional text, urgencia text, observacoes text, mensalidades_em_aberto numeric,
  acordo_em_aberto numeric, parcela_a_vencer numeric, parcelas_vencidas numeric, proximo_vencimento date,
  valor_pago numeric, honorario numeric, data_pagamento date, status_financeiro text, observacao_financeira text,
  created_at timestamp without time zone default now(), data_retorno_nova date,
  ultima_tabulacao_em timestamp without time zone, fila_responsavel text, hora_retorno time without time zone,
  observacao_operacional text, status_termo text default 'Sem termo'::text, termo_status_validacao text,
  termo_url text, termo_nome_arquivo text, termo_observacao text, termo_motivo_rejeicao text,
  termo_enviado_por text, termo_validado_por text, termo_validado_em timestamp with time zone, nome_aluno text,
  cpf text, status_jornada text, operador text, observacao text, aluno text, nome_completo text, email text,
  telefone text, curso text, unidade text, semestre text, ultimo_acionamento date, valor_em_aberto numeric,
  valor_aberto numeric, valor_total numeric, valor_divida numeric, saldo_devedor numeric, valor numeric,
  origem text, operador_nome text, operador_email text, nome_referencia text, cpf_corrigido text,
  cpf_status_correcao text, registro_unico uuid default gen_random_uuid(), chave_unificacao text,
  unificacao_status text, origem_quitacao text, quitado_em date, valor_quitado numeric default 0,
  baixa_importada_id uuid, valor_cobranca_ajustado numeric, motivo_ajuste_valor text, valor_ajustado_por text,
  valor_ajustado_em timestamp with time zone, cadastro_caso_observacao text, caso_atualizado_por text,
  caso_atualizado_em timestamp with time zone, nao_acionar boolean default false not null, aluno_id uuid,
  nivelamento_marcador text, nivelamento_em timestamp with time zone, nivelamento_simulacao_id uuid,
  situacao_operacional text, saldo_vencido numeric, saldo_total numeric,
  encerrado_operacional boolean default false not null, operador_mensalidade_email text,
  operador_mensalidade_nome text, mensalidade_girada_em timestamp with time zone
);
create unique index ux_casos_uma_ficha_aberta_por_aluno on public.casos (aluno_id)
  where aluno_id is not null and not coalesce(encerrado_operacional, false);

create table public.acordos (
  id uuid default gen_random_uuid() not null primary key,
  aluno_id uuid, cpf text, tipo text default 'ACORDO'::text not null,
  forma_pagamento text default 'PARCELADO'::text not null, valor_total numeric,
  qtd_parcelas integer default 1 not null, valor_entrada numeric, entrada_paga boolean default false not null,
  data_entrada date, status text default 'ATIVO'::text not null, observacao text, criado_por_nome text,
  criado_por_email text, confirmado_por_email text, confirmado_em timestamp with time zone,
  criado_em timestamp with time zone default now() not null, atualizado_em timestamp with time zone default now() not null,
  numero_acordo bigint generated by default as identity not null, operador_responsavel_email text, unidade text,
  entrada_percentual numeric, honorarios_percentual numeric, honorarios_valor numeric, saldo numeric,
  motivo_ajuste text, operador_responsavel_nome text, duplicado_de uuid,
  duplicado_marcado_em timestamp with time zone, numero_ulbra text
);

create table public.acordos_titulos (
  id uuid default gen_random_uuid() not null primary key,
  aluno_id uuid, cpf text, documento text unique, vencimento date, valor_original numeric(14,2),
  saldo_corrigido numeric(14,2), situacao text, tipo_boleto text, dados jsonb, importacao_id uuid,
  created_at timestamp without time zone default now(), status text default 'em_aberto'::text not null,
  valor_em_aberto numeric, competencia text, motivo_ajuste text,
  atualizado_em timestamp with time zone default now(), acordo_id uuid, vinculado_em timestamp with time zone,
  vinculado_por text, valor_cobranca_ajustado numeric, motivo_ajuste_valor text, valor_ajustado_por text,
  valor_ajustado_em timestamp with time zone, origem_liquidacao text, origem_liquidacao_ref text,
  origem_liquidacao_em timestamp with time zone
);

create table public.acordo_titulo_vinculo (
  id uuid default gen_random_uuid() not null primary key,
  acordo_id uuid not null, titulo_id uuid not null, ativo boolean default true not null,
  vinculado_por text, motivo_desvinculo text, criado_em timestamp with time zone default now() not null,
  origem text
);
create unique index ux_titulo_vinculo_ativo on public.acordo_titulo_vinculo (titulo_id) where ativo;

create table public.parcelas (
  id uuid default gen_random_uuid() not null primary key,
  acordo_id uuid not null, numero integer default 1 not null, valor numeric, vencimento date,
  status text default 'A_VENCER'::text not null, pago_em timestamp with time zone, confirmado_por_email text,
  observacao text, solicitacao_confirmacao_id uuid, criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null, honorarios numeric, forma_pagamento text,
  is_entrada boolean default false, boleto text, titulos_origem text, boleto_confiavel boolean default false not null,
  renegociada_em timestamp with time zone, renegociada_no_acordo_id uuid, origem_baixa text,
  origem_baixa_ref text, origem_baixa_em timestamp with time zone
);

create table public.solicitacoes_confirmacao_pagamento (
  id uuid default gen_random_uuid() not null primary key,
  aluno_id text, aluno_nome text, aluno_cpf text, operador_email text, operador_nome text,
  valor_informado numeric, motivo text, status text default 'AGUARDANDO_CONFIRMACAO'::text not null,
  observacao_adm text, confirmado_por text, confirmado_em timestamp with time zone,
  criado_em timestamp with time zone default now() not null, atualizado_em timestamp with time zone default now() not null,
  acordo_id uuid, parcela_id uuid, forma_pagamento text, qtd_parcelas integer, valor_entrada numeric,
  entrada_paga boolean, titulo_id uuid, data_pagamento date, tipo_pagamento text, comprovante_link_id uuid,
  dados_vinculados_em timestamp with time zone, dados_vinculados_por_email text, principal_referencia numeric,
  juros numeric, multa numeric, honorarios numeric, total_negociado numeric,
  composicao_validada_em timestamp with time zone, composicao_validada_por_email text, pagamento_id uuid,
  origem_divida text
);
create unique index ux_conf_saldo_zerado_aberta on public.solicitacoes_confirmacao_pagamento (aluno_id)
  where motivo = 'SALDO_ZERADO_IDENTIFICADO' and status = 'AGUARDANDO_CONFIRMACAO';

create table public.auditoria (
  id uuid default gen_random_uuid() not null primary key,
  usuario text, acao text not null, tabela_afetada text, registro_id uuid, detalhes jsonb,
  created_at timestamp without time zone default now()
);

create table public.aluno_movimentacoes (
  id bigint generated by default as identity not null primary key,
  aluno_id text not null, tipo text not null, descricao text, status_anterior text, status_novo text,
  registrado_por_nome text, registrado_por_email text, registrado_em timestamp with time zone default now() not null,
  operador_anterior_nome text, operador_anterior_email text, operador_novo_nome text, operador_novo_email text,
  data_retorno timestamp with time zone, solicitacao_link_id uuid, baixa_pagamento_id uuid, link_pagamento text,
  motivo_devolucao text, valor_movimentacao numeric, elogio_print_path text, elogio_print_nome text,
  elogio_aprovado_tv boolean default false, elogio_aprovado_por text, elogio_aprovado_em timestamp with time zone,
  elogio_rejeitado_tv boolean default false, elogio_rejeitado_por text, elogio_rejeitado_em timestamp with time zone
);

create table public.historico_operadores_alunos (
  id uuid default gen_random_uuid() not null primary key,
  aluno_id uuid, chave_unificacao text, nome_aluno text, cpf_referencia text, acao text not null,
  operador_nome text, operador_email text, operador_anterior_nome text, operador_anterior_email text,
  status_jornada_anterior text, status_jornada_novo text, data_retorno_anterior date, data_retorno_nova date,
  observacao text, criado_em timestamp with time zone default now()
);

create table public.calibragem_parametros (
  chave text not null primary key, valor jsonb not null, descricao text,
  atualizado_em timestamp with time zone default now() not null, atualizado_por text
);

create table public.prime_extrato (
  matricula text not null, boleto text not null, cpf text, vencimento date, liquidado_em date,
  valor_liquido numeric, valor_pago numeric, honorario numeric, de_acordo boolean, portador integer,
  portador_nome text, coletado_em timestamp with time zone default now() not null, valor_bruto numeric,
  desconto numeric, multa numeric, juros numeric,
  primary key (matricula, boleto)
);

create table public.prime_titulo_semestre (
  boleto text not null primary key, cpf text not null, semestre text, serie text, parcela numeric(6,2),
  vencimento date, liquidado_em date, coletado_em timestamp with time zone default now() not null,
  carrier_id integer
);

create table public.pagamentos (
  id uuid default gen_random_uuid() not null primary key,
  aluno_id uuid, cpf text, data_pagamento date, valor_pago numeric(14,2), tipo_pagamento text,
  entrada_paga boolean default false, dados jsonb, importacao_id uuid,
  created_at timestamp without time zone default now(), operador_email text, operador_nome text,
  valor_honorario numeric default 0, aluno_nome text, retroativo boolean default false not null,
  titulo_numero text, operador_ajustado_manualmente boolean default false not null,
  numero_parcela_completo text, matricula text, origem_vinculo text, origem_vinculo_ref text,
  origem_vinculo_em timestamp with time zone, status_conciliacao text, conciliacao_motivo text,
  conciliacao_em timestamp with time zone
);

create table public.links_pagamento (
  id uuid default gen_random_uuid() not null primary key,
  aluno_id text, aluno_nome text, aluno_cpf text, status text default 'SOLICITADO'::text not null,
  criado_em timestamp with time zone default now(), enviado_em timestamp with time zone,
  enviado_ao_aluno_em timestamp with time zone
);

create table public.baixas_pagamento (
  id uuid default gen_random_uuid() not null primary key,
  aluno_id text not null, aluno_nome text, aluno_cpf text, valor_pago numeric,
  status_baixa text default 'AGUARDANDO_BAIXA'::text not null,
  recebido_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null
);

create table public.usuarios (
  id uuid default gen_random_uuid() not null primary key,
  nome text not null, email text not null, perfil text not null, ativo boolean default true,
  created_at timestamp without time zone default now(), operador_nome text, operador text
);

create table public.retorno_acordo_auto (
  id uuid default gen_random_uuid() not null primary key,
  aluno_id uuid not null, proximo_vencimento date not null, data_retorno date, valor numeric, lote text,
  gerado_em timestamp with time zone default now() not null,
  unique (aluno_id, proximo_vencimento)
);

create table public.log_quitacao_bloqueada (
  id bigint generated by default as identity not null primary key,
  aluno_id uuid, origem text, saldo_pendente numeric, detalhe jsonb,
  criado_em timestamp with time zone default now() not null
);

create table public.prime_conferencia_decisao (
  titulo_id uuid not null primary key references public.acordos_titulos(id) on delete cascade,
  decisao text not null, motivo text, decidido_por text,
  decidido_em timestamp with time zone default now() not null,
  constraint prime_conferencia_decisao_decisao_check check (decisao = any (array['CONFIRMADO'::text, 'REJEITADO'::text]))
);

-- public.normalizar_status_acionamento
CREATE OR REPLACE FUNCTION public.normalizar_status_acionamento(p_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT trim(regexp_replace(
    upper(unaccent(coalesce(p_status, ''))),
    '[_\-]+', ' ', 'g'
  ));
$function$;

-- public.criticidade_rank
CREATE OR REPLACE FUNCTION public.criticidade_rank(p_nivel text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case upper(coalesce(p_nivel,''))
           when 'PERDENDO' then 4
           when 'CRITICO'  then 3
           when 'URGENTE'  then 2
           when 'ATENCAO'  then 1
           else 0
         end;
$function$;

-- public.fmt_brl
CREATE OR REPLACE FUNCTION public.fmt_brl(p numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select 'R$ ' || translate(to_char(round(coalesce(p,0),2),'FM999G999G999G990D00'), '.,', ',.');
$function$;

-- public.dia_util_anterior_ou_igual
CREATE OR REPLACE FUNCTION public.dia_util_anterior_ou_igual(p_dia date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case extract(isodow from p_dia)::int when 6 then p_dia - 1 when 7 then p_dia - 2 else p_dia end;
$function$;

-- public.titulo_superado_por_acordo
CREATE OR REPLACE FUNCTION public.titulo_superado_por_acordo(p_aluno_id uuid, p_vencimento date)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Aposentada em 26/08/2026. A mensalidade so sai da conta quando VINCULADA
  -- a um acordo (acordo_titulo_vinculo). Nao existe deducao por data.
  select false;
$function$;

-- public.nome_operador_por_email
CREATE OR REPLACE FUNCTION public.nome_operador_por_email(p_email text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  e text;
begin
  e := lower(coalesce(p_email, ''));

  return case e
    when 'amanda.seibel@aelbra.com.br' then 'AMANDA GESTORA'
    when 'cobranca04@aelbra.com.br' then 'FERNANDA'
    when 'cobranca05@aelbra.com.br' then 'LUANA'
    when 'cobranca12@aelbra.com.br' then 'DIEGO'
    when 'cobranca13@aelbra.com.br' then 'RAFAELLA'
    when 'cobranca07@aelbra.com.br' then 'AMANDA ADM'
    when 'cobranca11@aelbra.com.br' then 'ALLAN'
    when 'cobranca06@aelbra.com.br' then 'MAURICIO'
    when 'cobranca03@aelbra.com.br' then 'OLGA'
    when 'cobranca10@aelbra.com.br' then 'JOAO'
    when 'cobranca08@aelbra.com.br' then 'NATALY'
    else upper(split_part(e, '@', 1))
  end;
end;
$function$;

-- public.caso_dentro_prazo_fidelizacao
CREATE OR REPLACE FUNCTION public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_data_ultimo_acionamento is not null
     and p_data_ultimo_acionamento + 10 >= current_date;
$function$;

-- public.usuario_e_gestao
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

-- public.crm_usuario_pode_quitar_baixar
CREATE OR REPLACE FUNCTION public.crm_usuario_pode_quitar_baixar()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  email_logado text;
begin
  -- Negação primeiro: o executor de responsável nunca quita nem baixa.
  if current_user = 'reativa_responsavel_executor' then
    return false;
  end if;

  -- Sem JWT = chamada de backend (cron, pg_net, service_role). Só aqui o papel
  -- do banco decide, porque não há pessoa para consultar.
  if auth.jwt() is null then
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;

  -- Com JWT, quem decide é a pessoa -- inclusive dentro de SECURITY DEFINER,
  -- que era onde a regra vazava.
  email_logado := lower(coalesce(auth.jwt() ->> 'email', ''));
  return email_logado in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
end;
$function$;

-- public.acordo_avista_porta_interna
CREATE OR REPLACE FUNCTION public.acordo_avista_porta_interna()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ctx text;
begin
  if coalesce(current_setting('reativa.recuperacao_avista', true), 'off') <> 'on' then
    return false;
  end if;
  get diagnostics v_ctx = pg_context;
  return position('function acordo_avista_recuperar_um(uuid,boolean)' in v_ctx) > 0;
end;
$function$;

-- public.saldo_titulos_aberto
CREATE OR REPLACE FUNCTION public.saldo_titulos_aberto(p_cpf text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(t.saldo_corrigido),0)
  from public.acordos_titulos t
  where t.cpf = lpad(regexp_replace(coalesce(p_cpf,''),'\D','','g'),11,'0')
    and coalesce(upper(t.situacao),'') = 'ABERTO'
    and coalesce(lower(t.status),'') <> 'quitada'
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);
$function$;

-- public.caso_encerrado_operacional
CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- status_acionamento fala do ACIONAMENTO. 'CANCELADO' aqui e acordo
  -- cancelado, nao cobranca cancelada -- e nao tira ninguem da fila.
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- public.casos_set_encerrado_operacional
CREATE OR REPLACE FUNCTION public.casos_set_encerrado_operacional()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.cpf_limpo         IS NOT DISTINCT FROM OLD.cpf_limpo
     AND NEW.status_atual      IS NOT DISTINCT FROM OLD.status_atual
     AND NEW.status_acionamento IS NOT DISTINCT FROM OLD.status_acionamento
     AND NEW.status_financeiro IS NOT DISTINCT FROM OLD.status_financeiro
     AND NEW.status_jornada    IS NOT DISTINCT FROM OLD.status_jornada THEN
    -- nada relevante mudou: preserva valor atual
    RETURN NEW;
  END IF;

  NEW.encerrado_operacional := public.caso_encerrado_operacional(
    NEW.cpf_limpo, NEW.status_atual, NEW.status_acionamento,
    NEW.status_financeiro, NEW.status_jornada);
  RETURN NEW;
END;
$function$;

-- internal.resolver_aluno_por_matricula
CREATE OR REPLACE FUNCTION internal.resolver_aluno_por_matricula(p_aluno_id uuid, p_matricula text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    p_aluno_id,
    (SELECT a.id FROM public.alunos a
      WHERE p_aluno_id IS NULL
        AND nullif(btrim(p_matricula),'') IS NOT NULL
        AND btrim(a.matricula) = btrim(p_matricula)
        AND (SELECT count(*) FROM public.alunos a2 WHERE btrim(a2.matricula) = btrim(p_matricula)) = 1)
  );
$function$;

-- internal.matricula_em_fidelizacao
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
$function$;

-- public.aluno_saldo_pendente_detalhe
CREATE OR REPLACE FUNCTION public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar_confirmacao_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_titulos_abertos numeric := 0;
  v_titulos_orfaos  numeric := 0;
  v_parcelas_valor  numeric := 0;
  v_parcelas_qtd    int := 0;
  v_conf_pendentes  int := 0;
  v_total           numeric := 0;
  v_req_claims text := current_setting('request.jwt.claims', true);
  v_role       text := lower(coalesce(auth.jwt() ->> 'role', ''));
  v_uid        uuid := auth.uid();
  v_interno    boolean;
begin
  v_interno := (v_req_claims is null) or (v_role = 'service_role');
  if not v_interno then
    if v_uid is null or v_role = 'anon' then
      raise exception 'Acesso negado.' using errcode = '42501';
    end if;
  end if;

  -- Mensalidade sai da conta SO quando vinculada a um acordo nao cancelado.
  -- Nada de deducao por data.
  select
    coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'ABERTO'), 0),
    coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'), 0)
    into v_titulos_abertos, v_titulos_orfaos
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

  select count(*), coalesce(sum(coalesce(p.valor,0)),0)
    into v_parcelas_qtd, v_parcelas_valor
    from public.parcelas p
    join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = p_aluno_id
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select count(*)
    into v_conf_pendentes
    from public.solicitacoes_confirmacao_pagamento s
   where s.aluno_id = p_aluno_id::text
     and s.status = 'AGUARDANDO_CONFIRMACAO'
     and (p_ignorar_confirmacao_id is null or s.id <> p_ignorar_confirmacao_id);

  v_total := v_titulos_abertos + v_titulos_orfaos + v_parcelas_valor;

  return jsonb_build_object(
    'aluno_id', p_aluno_id,
    'titulos_abertos', round(v_titulos_abertos, 2),
    'titulos_negociados_orfaos', round(v_titulos_orfaos, 2),
    -- Mantidos por compatibilidade; a deducao por data nao existe mais.
    'titulos_superados_valor', 0,
    'titulos_superados_qtd', 0,
    'parcelas_abertas_qtd', v_parcelas_qtd,
    'parcelas_abertas_valor', round(v_parcelas_valor, 2),
    'confirmacoes_pendentes', v_conf_pendentes,
    'confirmacao_ignorada', p_ignorar_confirmacao_id,
    'total', round(v_total, 2),
    'tem_pendencia', (v_total > 0.005 or v_conf_pendentes > 0)
  );
end;
$function$;

-- public.caso_saldo_operacional
CREATE OR REPLACE FUNCTION public.caso_saldo_operacional(p_aluno_id uuid, p_matricula text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aid uuid;
  v_det jsonb;
  v_baixas_pendentes int := 0;
begin
  v_aid := internal.resolver_aluno_por_matricula(p_aluno_id, p_matricula);
  if v_aid is null then
    return jsonb_build_object('classificacao','REVISAO_SEM_VINCULO','tem_saldo', true);
  end if;

  v_det := public.aluno_saldo_pendente_detalhe(v_aid, null);

  select count(*) into v_baixas_pendentes
  from public.baixas_pagamento b
  where b.aluno_id = v_aid::text
    and upper(coalesce(b.status_baixa,'')) in ('AGUARDANDO_BAIXA','PENDENTE');

  return jsonb_build_object(
    'aluno_id', v_aid,
    'mensalidades_abertas', (v_det->>'titulos_abertos')::numeric,
    'titulos_negociados_orfaos', (v_det->>'titulos_negociados_orfaos')::numeric,
    'parcelas_abertas_qtd', (v_det->>'parcelas_abertas_qtd')::int,
    'parcelas_abertas_valor', (v_det->>'parcelas_abertas_valor')::numeric,
    'confirmacoes_pendentes', (v_det->>'confirmacoes_pendentes')::int,
    'baixas_pendentes', v_baixas_pendentes,
    'total', (v_det->>'total')::numeric,
    'tem_saldo', ((v_det->>'tem_pendencia')::boolean OR v_baixas_pendentes > 0),
    'classificacao', CASE
      WHEN ((v_det->>'tem_pendencia')::boolean OR v_baixas_pendentes > 0) THEN 'COM_SALDO'
      ELSE 'ZERADO_REAL'
    END
  );
end;
$function$;

-- public.caso_saldo_zerado_real
CREATE OR REPLACE FUNCTION public.caso_saldo_zerado_real(p_aluno_id uuid, p_matricula text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (public.caso_saldo_operacional(p_aluno_id, p_matricula) ->> 'classificacao') = 'ZERADO_REAL';
$function$;

-- internal.encaminhar_saldo_zerado_confirmacao
CREATE OR REPLACE FUNCTION internal.encaminhar_saldo_zerado_confirmacao(p_aluno_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_alu   record;
  v_caso  record;
  v_saldo numeric;
  v_id    uuid;
begin
  if p_aluno_id is null then return null; end if;
  select id, nome, cpf, responsavel_atual_email into v_alu from public.alunos where id = p_aluno_id;
  if not found then return null; end if;
  select id into v_id from public.solicitacoes_confirmacao_pagamento
   where aluno_id = p_aluno_id::text and status = 'AGUARDANDO_CONFIRMACAO'
   order by criado_em asc limit 1;
  if v_id is not null then return v_id; end if;
  select operador_email, operador_nome into v_caso from public.casos
   where aluno_id = p_aluno_id and operador_email is not null
   order by caso_atualizado_em desc nulls last limit 1;
  v_saldo := coalesce((public.aluno_saldo_pendente_detalhe(p_aluno_id, null) ->> 'total')::numeric, 0);
  begin
    insert into public.solicitacoes_confirmacao_pagamento
      (aluno_id, aluno_nome, aluno_cpf, operador_email, operador_nome,
       valor_informado, motivo, status, criado_em, atualizado_em)
    values
      (p_aluno_id::text, v_alu.nome, v_alu.cpf,
       coalesce(v_caso.operador_email, v_alu.responsavel_atual_email), v_caso.operador_nome,
       v_saldo, 'SALDO_ZERADO_IDENTIFICADO', 'AGUARDANDO_CONFIRMACAO', now(), now())
    on conflict (aluno_id) where (motivo = 'SALDO_ZERADO_IDENTIFICADO' AND status = 'AGUARDANDO_CONFIRMACAO')
    do nothing
    returning id into v_id;
  exception when unique_violation then
    v_id := null;
  end;
  if v_id is null then
    select id into v_id from public.solicitacoes_confirmacao_pagamento
     where aluno_id = p_aluno_id::text and status = 'AGUARDANDO_CONFIRMACAO'
     order by criado_em asc limit 1;
  end if;
  return v_id;
end;
$function$;

-- public.retirar_zerados_reais_sem_saldo
CREATE OR REPLACE FUNCTION public.retirar_zerados_reais_sem_saldo(p_aluno_id uuid DEFAULT NULL::uuid, p_limite integer DEFAULT NULL::integer)
 RETURNS TABLE(caso_id uuid, aluno_id uuid, matricula text, status_anterior text, status_novo text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare r record; v_novo text := 'SEM_SALDO_EM_ABERTO'; v_n int := 0;
begin
  for r in
    select c.id, c.aluno_id, c.matricula, c.status_acionamento AS st_ant,
           internal.resolver_aluno_por_matricula(c.aluno_id, c.matricula) AS aid
    from public.casos c
    where c.operador_email is not null
      and c.quitado_em is null
      and (p_aluno_id is null or c.aluno_id = p_aluno_id)
      and coalesce(c.status_acionamento,'') not ilike '%CANCEL%'
      and coalesce(c.status_acionamento,'') not ilike '%JURIDIC%'
      and public.normalizar_status_acionamento(c.status_acionamento) <> 'SEM SALDO EM ABERTO'
      and public.caso_saldo_zerado_real(c.aluno_id, c.matricula)
  loop
    exit when p_limite is not null and v_n >= p_limite;
    update public.casos set status_acionamento = v_novo, caso_atualizado_por = 'sistema_zerado_real', caso_atualizado_em = now() where id = r.id;
    if r.aid is not null then
      update public.alunos set status_jornada = v_novo, status_atual = v_novo, status_acionamento = v_novo, registrado_por_email = 'sistema_zerado_real', registrado_em = now() where id = r.aid;
    end if;
    insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values (coalesce(r.aid, r.aluno_id)::text, 'ZERADO_REAL_SEM_SALDO', 'Sem saldo em aberto (fonte unica): retirado da fila ativa. Matricula '||coalesce(r.matricula,'-')||'. Sem baixa/quitacao.', coalesce(r.st_ant,'(sem)'), v_novo, 'Sistema', 'sistema_zerado_real', now());
    insert into public.historico_operadores_alunos (aluno_id, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
    select r.aid, c.nome, c.cpf, 'ZERADO_REAL_SEM_SALDO', c.operador_nome, c.operador_email, 'Retirado da fila por saldo zero real. Responsavel preservado.', now() from public.casos c where c.id = r.id;
    perform internal.encaminhar_saldo_zerado_confirmacao(coalesce(r.aid, r.aluno_id));
    caso_id := r.id; aluno_id := r.aid; matricula := r.matricula; status_anterior := coalesce(r.st_ant,'(sem)'); status_novo := v_novo;
    v_n := v_n + 1;
    return next;
  end loop;
end;
$function$;

-- public.casos_reavaliar_encerramento
CREATE OR REPLACE FUNCTION public.casos_reavaliar_encerramento(p_limite integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare v_n integer;
begin
  with alvo as (
    select c.id
      from public.casos c
      join public.alunos al on al.id = c.aluno_id
     where not coalesce(c.encerrado_operacional, false)
       and c.aluno_id is not null
       -- trava que nao muda: so fecha quem NAO deve nada
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric <= 0.005
       and (
         -- a regra que ja existia diz encerrado
         public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada)
         -- ou o ALUNO esta marcado como quitado e o caso ficou para tras
         or upper(coalesce(al.status_atual,'')) ~ 'QUIT|BAIXA|SALDO_ZERO|SEM_SALDO'
         -- ou o proprio caso JA FOI CALCULADO como quitado.
         --
         -- Em 02/09/2026, 11 casos estavam com `situacao_operacional = QUITADO`,
         -- saldo zero, e ainda ABERTOS -- um deles ha seis semanas na carteira do
         -- cobranca03 (caso 9624, quitado em 21/07). Nove deles tinham o aluno com
         -- `status_atual = ACORDO_FECHADO`, palavra que nao esta no padrao acima.
         --
         -- A correcao NAO foi acrescentar ACORDO_FECHADO ao padrao, e de proposito:
         -- "acordo fechado" quer dizer acordo FIRMADO, nao pago. Sao 593 alunos com
         -- esse status e 577 deles ainda devem, R$ 2.486.988,04 no total. Colocar a
         -- palavra num padrao chamado de quitacao daria a entender o contrario para
         -- quem lesse depois.
         --
         -- `situacao_operacional` e melhor porque nao e string herdada: e o que
         -- `recalcular_situacao_aluno` calculou a partir do saldo real.
         or upper(coalesce(c.situacao_operacional,'')) = 'QUITADO'
       )
     limit coalesce(p_limite, 100000)
  )
  update public.casos c
     set encerrado_operacional = true,
         caso_atualizado_por = 'sistema_reavaliar_encerramento',
         caso_atualizado_em = now()
    from alvo a
   where c.id = a.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- public.casos_encerrar_zerados_sem_debito
CREATE OR REPLACE FUNCTION public.casos_encerrar_zerados_sem_debito(p_limite integer DEFAULT NULL::integer, p_origem text DEFAULT 'cron'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare
  v_snapshot_casos int := 0;
  v_snapshot_alunos int := 0;
  v_casos int := 0;
  v_alunos int := 0;
  v_quem text := coalesce(nullif(p_origem,''), 'cron');
begin
  if auth.jwt() is not null and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Apenas gestão pode rodar o encerramento de zerados.' using errcode = '42501';
  end if;

  drop table if exists tmp_zer;
  create temporary table tmp_zer on commit drop as
  with mens as (
    select t.aluno_id, sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) v
      from public.acordos_titulos t
     where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and coalesce(lower(t.status),'') <> 'quitada'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
     group by t.aluno_id
  ), parc as (
    select a.aluno_id, sum(coalesce(p.valor,0)) v
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
     group by a.aluno_id
  ), conf as (
    select aluno_id from public.solicitacoes_confirmacao_pagamento
     where status = 'AGUARDANDO_CONFIRMACAO' group by aluno_id
  ), baixa as (
    select aluno_id from public.baixas_pagamento
     where upper(coalesce(status_baixa,'')) in ('AGUARDANDO_BAIXA','PENDENTE') group by aluno_id
  )
  select c.id as caso_id, c.aluno_id, c.matricula, c.nome, c.cpf,
         c.operador_email, c.operador_nome, c.chave_unificacao,
         coalesce(c.total_em_aberto,0) as total_em_aberto,
         coalesce(c.encerrado_operacional,false) as encerrado_operacional,
         c.status_acionamento, c.status_financeiro, c.quitado_em,
         a.status_atual as a_status_atual, a.status_jornada as a_status_jornada,
         a.cpf as a_cpf, coalesce(a.valor_em_aberto,0) as a_valor_em_aberto,
         public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada) as aluno_encerrado,
         ((upper(coalesce(a.status_atual,''))||' '||upper(coalesce(a.status_jornada,''))||' '
           ||upper(coalesce(c.status_acionamento,''))||' '||upper(coalesce(c.status_financeiro,''))||' '
           ||upper(coalesce(c.status_atual,''))) ~ 'JURIDIC|CANCEL|SUSPENS') as bloqueado,
         exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                  where s.aluno_id = c.aluno_id::text) as ja_passou_confirmacao
    from public.casos c
    join public.alunos a on a.id = c.aluno_id
    left join mens m  on m.aluno_id  = c.aluno_id
    left join parc pc on pc.aluno_id = c.aluno_id
    left join conf cf on cf.aluno_id = c.aluno_id::text
    left join baixa bx on bx.aluno_id = c.aluno_id::text
   where c.aluno_id is not null
     and (coalesce(m.v,0) + coalesce(pc.v,0)) <= 0.005
     and cf.aluno_id is null
     and bx.aluno_id is null;

  update public.casos c
     set total_em_aberto = 0,
         caso_atualizado_por = 'sistema_zerado_sem_debito',
         caso_atualizado_em = now()
    from tmp_zer z
   where c.id = z.caso_id
     and z.total_em_aberto <> 0;
  get diagnostics v_snapshot_casos = row_count;

  update public.alunos a
     set valor_em_aberto = 0
   where a.id in (select aluno_id from tmp_zer where a_valor_em_aberto <> 0);
  get diagnostics v_snapshot_alunos = row_count;

  drop table if exists tmp_alvo;
  create temporary table tmp_alvo on commit drop as
  select z.*
    from tmp_zer z
   where not z.bloqueado
     and (not z.aluno_encerrado or not z.encerrado_operacional)
     and not (z.operador_email is not null and z.quitado_em is null
              and public.normalizar_status_acionamento(z.status_acionamento) <> 'SEM SALDO EM ABERTO'
              and not z.ja_passou_confirmacao)
   order by z.caso_id
   limit coalesce(p_limite, 1000000);

  update public.casos c
     set status_acionamento = case
           when public.normalizar_status_acionamento(c.status_acionamento) in
                ('PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                 'SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO')
             then c.status_acionamento
           else 'SEM_SALDO_EM_ABERTO' end,
         status_financeiro = case
           when c.status_financeiro is null or upper(c.status_financeiro) = 'EM_ABERTO'
             then 'SEM_SALDO_EM_ABERTO'
           else c.status_financeiro end,
         encerrado_operacional = true,
         caso_atualizado_por = 'sistema_zerado_sem_debito',
         caso_atualizado_em = now()
    from tmp_alvo z
   where c.id = z.caso_id;
  get diagnostics v_casos = row_count;

  with alvo_aluno as (
    select z.aluno_id, z.a_cpf,
           bool_or(z.quitado_em is not null) as quitado,
           min(z.a_status_atual) as st_ant, min(z.matricula) as matricula
      from tmp_alvo z
     where not z.aluno_encerrado
     group by z.aluno_id, z.a_cpf
  ), novo as (
    select aa.*,
           case when aa.quitado and public.saldo_titulos_aberto(aa.a_cpf) = 0
                then 'QUITADO' else 'SEM_SALDO_EM_ABERTO' end as st_novo
      from alvo_aluno aa
  ), upd as (
    update public.alunos a
       set status_atual = n.st_novo,
           status_jornada = n.st_novo,
           status_acionamento = n.st_novo,
           valor_em_aberto = 0,
           proxima_acao = null,
           data_retorno = null,
           hora_retorno = null,
           registrado_por_email = 'sistema_zerado_sem_debito',
           registrado_em = now()
      from novo n
     where a.id = n.aluno_id
     returning a.id, n.st_ant, n.st_novo, n.matricula
  )
  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em)
  select u.id::text, 'ZERADO_REAL_SEM_SALDO',
         'Sem débito (saldo real zero, sem confirmação ou baixa pendente): aluno encerrado automaticamente. Matrícula '
           || coalesce(u.matricula,'-') || '. Origem: ' || v_quem || '.',
         coalesce(u.st_ant,'(sem)'), u.st_novo, 'Sistema', 'sistema_zerado_sem_debito', now()
    from upd u;
  get diagnostics v_alunos = row_count;

  insert into public.historico_operadores_alunos
    (aluno_id, chave_unificacao, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
  select z.aluno_id, z.chave_unificacao, z.nome, z.cpf, 'ZERADO_REAL_SEM_SALDO',
         z.operador_nome, z.operador_email,
         'Encerrado por saldo zero sem débito. Responsável preservado.', now()
    from tmp_alvo z
   where z.operador_email is not null and not z.aluno_encerrado;

  return jsonb_build_object(
    'snapshot_casos_zerados', v_snapshot_casos,
    'snapshot_alunos_zerados', v_snapshot_alunos,
    'casos_encerrados', v_casos,
    'alunos_encerrados', v_alunos,
    'origem', v_quem,
    'executado_em', now());
end;
$function$;

-- public.calibragem_nivel_criticidade
CREATE OR REPLACE FUNCTION public.calibragem_nivel_criticidade(p_dias_venc integer, p_dias_sem_ac integer, p_valor numeric, p_termo_pendente boolean, p_fim_mes boolean, p_regras jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  s numeric := 0;
  p jsonb := p_regras->'pesos';
  n jsonb := p_regras->'niveis';
  e jsonb := p_regras->'escada_dias';
  v_score  text;
  v_escada text := null;
  d int := coalesce(p_dias_sem_ac, 0);
begin
  if coalesce(p_dias_venc,0)   >= coalesce((p->'dias_vencido'->>'min')::int, 2147483647)        then s := s + coalesce((p->'dias_vencido'->>'peso')::numeric,0); end if;
  if coalesce(p_dias_sem_ac,0) >= coalesce((p->'dias_sem_acionamento'->>'min')::int, 2147483647) then s := s + coalesce((p->'dias_sem_acionamento'->>'peso')::numeric,0); end if;
  if coalesce(p_valor,0)       >= coalesce((p->'valor'->>'min')::numeric, 1e18)                   then s := s + coalesce((p->'valor'->>'peso')::numeric,0); end if;
  if coalesce(p_termo_pendente,false) then s := s + coalesce((p->'termo_pendente'->>'peso')::numeric,0); end if;
  if coalesce(p_fim_mes,false)        then s := s + coalesce((p->'fim_mes'->>'peso')::numeric,0); end if;

  -- ACIONAMENTO RECENTE: peso negativo. Sem a chave nas regras o `max` cai para
  -- -1 e isto nunca dispara -- a funcao segue identica a de antes.
  if coalesce(p_dias_sem_ac, 9999) <= coalesce((p->'acionado_recente'->>'max')::int, -1)
    then s := s + coalesce((p->'acionado_recente'->>'peso')::numeric,0); end if;

  if    s >= coalesce((n->>'critico')::numeric,5) then v_score := 'CRITICO';
  elsif s >= coalesce((n->>'urgente')::numeric,3) then v_score := 'URGENTE';
  elsif s >= coalesce((n->>'atencao')::numeric,1) then v_score := 'ATENCAO';
  else  v_score := 'NORMAL'; end if;

  -- ESCADA POR DIAS SEM ACIONAMENTO (Amanda, 02/09): "8 urgente, 9 critico,
  -- 10 perdendo caso". E PISO, nunca teto: o score ainda pode subir o nivel,
  -- nunca baixar. Sem a chave `escada_dias` nas regras, nada disto dispara e a
  -- funcao se comporta como antes.
  --
  -- O dia 10 fecha com a fidelizacao: `caso_dentro_prazo_fidelizacao` protege
  -- ate dua+10, e no 11o o caso pode ser retirado. "PERDENDO" e o aviso do
  -- ultimo dia em que ainda da para segurar.
  --
  -- Nunca acionado chega aqui como 9999 e cai em PERDENDO de proposito: a
  -- fidelizacao so comeca no 1o acionamento, entao esse caso nao esta protegido.
  if e is not null then
    if    d >= coalesce((e->>'perdendo')::int, 2147483647) then v_escada := 'PERDENDO';
    elsif d >= coalesce((e->>'critico')::int,  2147483647) then v_escada := 'CRITICO';
    elsif d >= coalesce((e->>'urgente')::int,  2147483647) then v_escada := 'URGENTE';
    end if;
  end if;

  if v_escada is null then return v_score; end if;
  return case when public.criticidade_rank(v_escada) > public.criticidade_rank(v_score)
              then v_escada else v_score end;
end;
$function$;

-- public.recalcular_situacao_aluno
CREATE OR REPLACE FUNCTION public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  hoje date := current_date;
  v_regras jsonb := coalesce((select valor from public.calibragem_parametros where chave='criticidade_regras'),'{}'::jsonb);
  v_ant int := coalesce((select (valor->>'dias')::int from public.calibragem_parametros where chave='retorno_antecedencia_dias'),2);
  v_fim_mes_dias int := coalesce((v_regras->'pesos'->'fim_mes'->>'dias')::int,5);
  v_fim_mes boolean := (date_trunc('month',now())+interval '1 month - 1 day')::date - hoje <= v_fim_mes_dias;
  v_parc_venc_val numeric := 0; v_parc_fut_val numeric := 0;
  v_venc_qtd int := 0; v_fut_qtd int := 0;
  v_parc_antiga_venc date;
  v_prox_venc date; v_prox_val numeric;
  v_entrada_pend boolean := false;
  v_tit_val numeric := 0; v_tit_venc_val numeric := 0;
  v_conf_pend int := 0;
  v_termo_pend boolean := false;
  v_baixa_pend boolean := false;
  v_tem_acordo boolean := false;
  v_saldo_vencido numeric; v_saldo_total numeric;
  v_dias_venc int := 0; v_dias_sem_ac int;
  v_status_acion text; v_ult_acion date; v_acao_massiva boolean := false;
  v_ret_atual date; v_orig_atual text;
  v_lembrete date;
  v_nivel text; v_situacao text; v_proxima text; v_retorno date; v_origem text;
  v_preservar_tabulacao boolean := false; v_proxima_auto text;
begin
  if p_aluno_id is null then return jsonb_build_object('erro','sem_aluno'); end if;

  select
    coalesce(sum(p.valor) filter (where p.vencimento <  hoje),0),
    coalesce(sum(p.valor) filter (where p.vencimento >= hoje),0),
    count(*) filter (where p.vencimento <  hoje),
    count(*) filter (where p.vencimento >= hoje),
    min(p.vencimento) filter (where p.vencimento < hoje),
    bool_or(p.is_entrada),
    count(*) > 0
  into v_parc_venc_val, v_parc_fut_val, v_venc_qtd, v_fut_qtd, v_parc_antiga_venc, v_entrada_pend, v_tem_acordo
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select p.vencimento, p.valor into v_prox_venc, v_prox_val
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
    and p.vencimento >= hoje
  order by p.vencimento asc, p.numero asc
  limit 1;

  select
    coalesce(sum(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0),
    coalesce(sum(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento < hoje),0)
  into v_tit_val, v_tit_venc_val
  from public.acordos_titulos t
  where t.aluno_id=p_aluno_id
    and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
    and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
    and not exists (
      select 1 from public.acordo_titulo_vinculo v
      join public.acordos a on a.id=v.acordo_id
      where v.titulo_id=t.id and coalesce(v.ativo,true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO'))
    and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

  select count(*) into v_conf_pend
  from public.solicitacoes_confirmacao_pagamento
  where aluno_id=p_aluno_id::text and status='AGUARDANDO_CONFIRMACAO';

  select coalesce((c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')), false)
  into v_termo_pend from public.casos c where c.aluno_id=p_aluno_id limit 1;
  v_termo_pend := coalesce(v_termo_pend,false);

  select coalesce((al.status_baixa_pagamento is not null and al.status_baixa_pagamento <> 'BAIXA_REALIZADA'), false)
  into v_baixa_pend from public.alunos al where al.id=p_aluno_id;
  v_baixa_pend := coalesce(v_baixa_pend,false);

  v_saldo_vencido := round(v_parc_venc_val + v_tit_venc_val, 2);
  v_saldo_total   := round(v_parc_venc_val + v_parc_fut_val + v_tit_val, 2);

  v_dias_venc := case
    when v_parc_antiga_venc is not null then (hoje - v_parc_antiga_venc)
    else coalesce((select hoje - min(t.vencimento) from public.acordos_titulos t
                   where t.aluno_id=p_aluno_id and t.vencimento < hoje
                     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                     and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
                     and not exists (
                       select 1 from public.acordo_titulo_vinculo v
                       join public.acordos a on a.id=v.acordo_id
                       where v.titulo_id=t.id and coalesce(v.ativo,true)
                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO'))
                     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)),0)
  end;
  if v_dias_venc < 0 then v_dias_venc := 0; end if;

  select
    case when data_ultimo_acionamento is null then 9999 else (hoje - data_ultimo_acionamento::date) end,
    data_ultimo_acionamento::date,
    coalesce(status_acionamento,'') ilike 'Ação massiva%',
    data_retorno,
    retorno_origem
  into v_dias_sem_ac, v_ult_acion, v_acao_massiva, v_ret_atual, v_orig_atual
  from public.alunos where id=p_aluno_id;
  v_dias_sem_ac := coalesce(v_dias_sem_ac, 9999);

  if v_saldo_total <= 0.005 and v_conf_pend = 0 then
     v_nivel := 'NORMAL';
     if v_baixa_pend then
        v_situacao := 'QUITADO_AGUARDANDO_BAIXA';
        v_proxima  := 'Próxima ação: concluir a baixa e finalizar o caso.';
     else
        v_situacao := 'QUITADO';
        v_proxima  := null;
     end if;
     v_retorno := null; v_origem := null;
  elsif v_conf_pend > 0 and v_saldo_vencido <= 0.005 then
     v_situacao := 'AGUARDANDO_CONFIRMACAO';
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'ATENCAO');
     v_proxima := 'Próxima ação: confirmar o pagamento no financeiro.';
     v_retorno := null; v_origem := null;
  elsif v_saldo_vencido > 0.005 then
     v_nivel := public.calibragem_nivel_criticidade(v_dias_venc, v_dias_sem_ac, v_saldo_total, v_termo_pend, v_fim_mes, v_regras);
     v_situacao := 'COBRANCA_VENCIDA';
     v_proxima := 'Próxima ação: cobrar o saldo vencido de '||public.fmt_brl(v_saldo_vencido)||'.';
     if v_conf_pend > 0 then
        -- Está com o financeiro: o caso fica parado até a conferência ser
        -- concluída. Sem prazo empurrando ele de volta para o operador.
        v_proxima := 'Próxima ação: aguardar a confirmação do pagamento no financeiro'
                  || ' (saldo vencido de '||public.fmt_brl(v_saldo_vencido)||' segue em aberto).';
        v_retorno := null; v_origem := null;
     elsif v_acao_massiva and v_ult_acion is not null and (hoje - v_ult_acion) < 10 then
        v_retorno := v_ult_acion + 10;
        v_origem  := 'AUTOMATICO';
     elsif v_ret_atual is not null and v_ret_atual > hoje then
        v_retorno := v_ret_atual;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     else
        v_retorno := hoje;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     end if;
  elsif v_parc_fut_val > 0.005 and v_prox_venc is not null then
     v_nivel := 'NORMAL';
     v_situacao := 'ACORDO_EM_DIA';
     v_proxima := 'Próxima ação: lembrar o aluno da parcela de '||public.fmt_brl(coalesce(v_prox_val,0))
                ||' com vencimento em '||to_char(v_prox_venc,'DD/MM/YYYY')||'.';
     v_lembrete := public.dia_util_anterior_ou_igual(v_prox_venc - v_ant);
     if v_ret_atual is not null and v_ret_atual > hoje and coalesce(v_orig_atual,'') like 'OPERADOR%' then
        v_retorno := v_ret_atual;
        v_origem  := v_orig_atual;
     elsif v_ult_acion is not null and v_ult_acion >= v_lembrete then
        v_retorno := null;
        v_origem  := null;
     else
        v_retorno := greatest(hoje, v_lembrete);
        v_origem  := 'AUTOMATICO';
     end if;
  else
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'NORMAL');
     v_situacao := 'SEM_PENDENCIA';
     v_proxima := null;
     v_retorno := null; v_origem := null;
  end if;

  -- Acionado hoje: o desfecho tabulado pelo operador manda na fila.
  v_proxima_auto := v_proxima;  -- casos.proxima_acao_automatica segue automatica
  v_preservar_tabulacao := (v_ult_acion = hoje)
    and v_conf_pend = 0
    and v_situacao not in ('QUITADO','QUITADO_AGUARDANDO_BAIXA','AGUARDANDO_CONFIRMACAO');
  if v_preservar_tabulacao then
     select al.proxima_acao, al.data_retorno, al.retorno_origem
       into v_proxima, v_retorno, v_origem
       from public.alunos al where al.id = p_aluno_id;
  end if;
  update public.casos set
     criticidade            = v_nivel,
     situacao_operacional   = v_situacao,
     proxima_acao_automatica= coalesce(v_proxima_auto, v_proxima),
     proximo_vencimento     = coalesce(v_prox_venc, v_parc_antiga_venc, proximo_vencimento),
     parcela_a_vencer       = v_prox_val,
     parcelas_vencidas      = v_venc_qtd,
     saldo_vencido          = v_saldo_vencido,
     saldo_total            = v_saldo_total,
     data_retorno           = v_retorno,
     caso_atualizado_em     = now()
   where aluno_id = p_aluno_id;

  update public.alunos set
     nivel_criticidade    = v_nivel,
     situacao_operacional = v_situacao,
     proxima_acao         = v_proxima,
     saldo_vencido        = v_saldo_vencido,
     saldo_total          = v_saldo_total,
     data_retorno         = v_retorno,
     retorno_origem       = v_origem
   where id = p_aluno_id;

  if v_situacao='ACORDO_EM_DIA' and v_prox_venc is not null then
     insert into public.retorno_acordo_auto(aluno_id, proximo_vencimento, data_retorno, valor, lote)
     values (p_aluno_id, v_prox_venc, coalesce(v_retorno, v_lembrete), v_prox_val, coalesce(p_lote,'evento'))
     on conflict (aluno_id, proximo_vencimento)
       do update set data_retorno=excluded.data_retorno, valor=excluded.valor, gerado_em=now();
  end if;

  return jsonb_build_object(
    'aluno_id',p_aluno_id,'situacao',v_situacao,'criticidade',v_nivel,
    'proxima_acao',v_proxima,'data_retorno',v_retorno,'retorno_origem',v_origem,
    'lembrete_parcela',v_lembrete,
    'saldo_vencido',v_saldo_vencido,'saldo_total',v_saldo_total,
    'proxima_parcela_venc',v_prox_venc,'proxima_parcela_valor',v_prox_val,
    'confirmacao_pendente',v_conf_pend>0,'termo_pendente',v_termo_pend,
    'entrada_pendente',coalesce(v_entrada_pend,false),'baixa_pendente',v_baixa_pend,
    'tem_acordo',coalesce(v_tem_acordo,false));
end; $function$;

-- public._talvez_quitar_aluno
CREATE OR REPLACE FUNCTION public._talvez_quitar_aluno(v_aluno uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_saldo numeric; v_parc int; v_conf int;
begin
  if v_aluno is null then return; end if;

  select coalesce(sum(coalesce(saldo_corrigido, valor_original, 0)), 0) into v_saldo
    from public.acordos_titulos
   where aluno_id = v_aluno and upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO');
  if v_saldo > 0 then return; end if;

  select count(*) into v_parc
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = v_aluno
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  if v_parc > 0 then return; end if;

  select count(*) into v_conf
    from public.solicitacoes_confirmacao_pagamento
   where aluno_id = v_aluno::text and status = 'AGUARDANDO_CONFIRMACAO';
  if v_conf > 0 then return; end if;

  update public.alunos
    set status_jornada = 'QUITADO', status_atual = 'QUITADO', status_acionamento = 'QUITADO',
        valor_em_aberto = 0
    where id = v_aluno
      and coalesce(status_jornada,'') not in ('QUITADO','QUITADO_MANUAL','JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA');

  update public.casos
     set status_financeiro = 'QUITADO_AUTOMATICO',
         quitado_em        = current_date,
         origem_quitacao   = 'QUITACAO_AUTOMATICA',
         total_em_aberto   = 0,
         criticidade       = 'NORMAL',
         caso_atualizado_por = 'sistema_quitacao_automatica',
         caso_atualizado_em  = now()
   where aluno_id = v_aluno
     and quitado_em is null
     and operador_email is not null;
end;
$function$;

-- public._titulo_situacao_e_status_coerentes
CREATE OR REPLACE FUNCTION public._titulo_situacao_e_status_coerentes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  end if;

  return new;
end;
$function$;

-- public._trg_auto_quitar_titulo
CREATE OR REPLACE FUNCTION public._trg_auto_quitar_titulo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if upper(coalesce(old.situacao,'')) in ('ABERTO','NEGOCIADO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO') then
    perform public._talvez_quitar_aluno(new.aluno_id);
  end if;
  return new;
end;
$function$;

-- public.tg_titulo_normaliza_vinculo_incoerente
CREATE OR REPLACE FUNCTION public.tg_titulo_normaliza_vinculo_incoerente()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if lower(coalesce(NEW.status, '')) = 'vinculada'
     and upper(coalesce(NEW.situacao, '')) = 'ABERTO'
     and NEW.acordo_id is null
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
        where v.titulo_id = NEW.id and coalesce(v.ativo, true)
     )
  then
    NEW.status := 'em_aberto';
  end if;
  return NEW;
end;
$function$;

-- public.titulo_liquidado_na_origem_e_terminal
CREATE OR REPLACE FUNCTION public.titulo_liquidado_na_origem_e_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tentou text;
begin
  if coalesce(old.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL' then
    return new;
  end if;

  -- As tres marcas nao se apagam: sao a prova de POR QUE o titulo fechou.
  new.origem_liquidacao     := old.origem_liquidacao;
  -- O VELHO VENCE. Nao e coalesce do novo: uma segunda execucao concorrente
  -- chega com OUTRO pagamento em `new`, e deixar o novo ganhar reescreveria a
  -- proveniencia -- o titulo passaria a dizer que foi liquidado por um
  -- pagamento que nao foi o que o liquidou. Gravada uma vez, nao troca mais.
  new.origem_liquidacao_ref := coalesce(old.origem_liquidacao_ref, new.origem_liquidacao_ref);
  new.origem_liquidacao_em  := coalesce(old.origem_liquidacao_em,  new.origem_liquidacao_em);

  if coalesce(new.situacao,'') = 'PAGO' and coalesce(new.status,'') = 'quitada' then
    return new;   -- nada a coagir; segue a vida (acordo_id, motivo, etc.)
  end if;

  v_tentou := coalesce(new.situacao,'(null)') || '/' || coalesce(new.status,'(null)');
  new.situacao := 'PAGO';
  new.status   := 'quitada';
  new.motivo_ajuste := coalesce(new.motivo_ajuste,'')
    || case when coalesce(new.motivo_ajuste,'') = '' then '' else ' | ' end
    || 'tentativa de reabrir titulo liquidado na origem (' || v_tentou
    || ') recusada: a divida ja foi concluida pela liquidacao oficial na Prime';

  -- So registra quando REALMENTE impediu alguma coisa -- e raro, e por isso cabe.
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('sistema', 'TITULO_LIQUIDADO_REABERTURA_RECUSADA', 'acordos_titulos', old.id::text,
          jsonb_build_object('documento', old.documento, 'tentou', v_tentou,
                             'origem_liquidacao_ref', old.origem_liquidacao_ref,
                             'acordo_id_novo', new.acordo_id));
  return new;
end;
$function$;

-- public._fechar_confirmacao_ao_zerar_saldo
CREATE OR REPLACE FUNCTION public._fechar_confirmacao_ao_zerar_saldo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aluno uuid;
  v_det   jsonb;
begin
  begin
    if tg_table_name = 'parcelas' then
      select a.aluno_id into v_aluno from public.acordos a where a.id = new.acordo_id;
    else
      v_aluno := new.aluno_id;
    end if;
    if v_aluno is null then return null; end if;

    if not exists (
      select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = v_aluno::text
        and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
    ) then
      return null;
    end if;

    v_det := public.aluno_saldo_pendente_detalhe(v_aluno);

    if coalesce((v_det ->> 'total')::numeric, 1) > 0.005
       or coalesce((v_det ->> 'titulos_superados_valor')::numeric, 0) > 0.005 then
      return null;
    end if;

    update public.solicitacoes_confirmacao_pagamento s
       set status = 'PAGAMENTO_CONFIRMADO',
           observacao_adm = coalesce(nullif(btrim(s.observacao_adm), ''),
                                     'Fechada automaticamente: o aluno ficou sem saldo em aberto.'),
           confirmado_em = coalesce(s.confirmado_em, now()),
           atualizado_em = now()
     where s.aluno_id = v_aluno::text
       and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');

  exception when others then
    return null;
  end;
  return null;
end;
$function$;

-- public._reabrir_quitado_ao_incluir_titulo
CREATE OR REPLACE FUNCTION public._reabrir_quitado_ao_incluir_titulo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text; v_saldo numeric;
begin
  -- só interessa título/parcela que entra EM ABERTO e ligado a um aluno
  if new.aluno_id is null or lower(coalesce(new.status,'')) <> 'em_aberto' then
    return new;
  end if;

  select status_jornada into v_status from public.alunos where id = new.aluno_id;

  -- reabre SOMENTE se o caso estava encerrado (quitado). Não mexe em caso
  -- ativo, nem em travados de propósito (jurídico, cancelamento, etc.).
  if v_status in ('QUITADO','QUITADO_MANUAL') then
    select coalesce(sum(coalesce(valor_em_aberto, saldo_corrigido, valor_original)),0)
      into v_saldo
      from public.acordos_titulos
      where aluno_id = new.aluno_id and lower(status) = 'em_aberto';

    update public.alunos set
      status_jornada = 'CONTATAR',
      status_atual = 'CONTATAR',
      status_acionamento = 'CONTATAR',
      proxima_acao = 'CONTATAR',
      valor_em_aberto = v_saldo
    where id = new.aluno_id;

    insert into public.aluno_movimentacoes
      (aluno_id, tipo, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em, descricao)
    values
      (new.aluno_id, 'REATIVACAO_AUTOMATICA', v_status, 'CONTATAR', 'Sistema', 'sistema@reativa',
       now(), 'Caso reaberto automaticamente: entrou titulo/parcela em aberto (saldo R$ '||to_char(v_saldo,'FM999G999D00')||'). Voltou pra fila.');
  end if;

  return new;
end;
$function$;

-- public.titulo_reavaliar
CREATE OR REPLACE FUNCTION public.titulo_reavaliar(p_titulo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_situacao text; v_status text;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
begin
  select situacao, status into v_situacao, v_status
    from public.acordos_titulos where id = p_titulo;
  if not found then return; end if;

  -- Ja paga: nada aqui reabre mensalidade quitada.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return;
  end if;

  -- Ja cancelada: nada aqui ressuscita titulo cancelado. Cancelar e uma decisao
  -- deliberada (rotina ou gestao); a reavaliacao automatica nao desfaz decisao.
  -- Voltar a cobrar exige um caminho explicito, que hoje nao existe -- e quando
  -- existir sera um "desfazer" com registro, nao um efeito colateral daqui.
  if upper(coalesce(v_situacao,'')) = 'CANCELADA'
     or lower(coalesce(v_status,'')) = 'cancelada' then
    return;
  end if;

  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
    into v_acordo, v_status_acordo, v_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  -- Sem acordo vivo: a divida volta a ser cobrada. O vinculo continua na
  -- tabela, entao a composicao do acordo nao se perde -- ver a tela do acordo.
  if v_acordo is null then
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
    return;
  end if;

  -- Quitado de verdade e acordo sem parcela viva. Acordo marcado QUITADO com
  -- parcela em aberto nao quita mensalidade nenhuma (guarda de 20260831140000).
  -- RENEGOCIADA nao entra aqui: parcela renegociada nao e parcela paga.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'));

  if v_quitado then
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           motivo_ajuste = coalesce(motivo_ajuste,'')
             || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           atualizado_em = now()
     where id = p_titulo;
  else
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  end if;
end;
$function$;

-- public.titulo_situacao_por_vinculo
CREATE OR REPLACE FUNCTION public.titulo_situacao_por_vinculo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_titulo uuid;
begin
  foreach v_titulo in array
    array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null)
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return coalesce(new, old);
end;
$function$;

-- public._trg_recalc_por_vinculo_novo
CREATE OR REPLACE FUNCTION public._trg_recalc_por_vinculo_novo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  for r in
    select distinct t.aluno_id
      from novas n
      join public.acordos_titulos t on t.id = n.titulo_id
     where t.aluno_id is not null
  loop
    begin
      perform public.recalcular_situacao_aluno(r.aluno_id, 'vinculo_titulo');
    exception when others then null;
    end;
  end loop;
  return null;
end;
$function$;

-- public._parcela_guarda_titulo_origem
CREATE OR REPLACE FUNCTION public._parcela_guarda_titulo_origem()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_acordo uuid; v_docs text;
begin
  v_acordo := coalesce(new.acordo_id, old.acordo_id);
  if v_acordo is null then return null; end if;

  select string_agg(t.documento, ', ' order by t.vencimento) into v_docs
    from public.acordo_titulo_vinculo v
    join public.acordos_titulos t on t.id = v.titulo_id
   where v.acordo_id = v_acordo and coalesce(v.ativo, true)
     and coalesce(t.tipo_boleto,'') <> 'Acordo';

  update public.parcelas p set titulos_origem = v_docs, atualizado_em = now()
   where p.acordo_id = v_acordo
     and coalesce(p.titulos_origem,'') is distinct from coalesce(v_docs,'');

  return null;
end;
$function$;

-- public.vincular_titulos_acordo
CREATE OR REPLACE FUNCTION public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_numero text;
  v_quitado boolean;
  v_bloqueados uuid[];
  v_novos uuid[];
  v_ja int := 0;
  v_n int := 0;
  v_reparo uuid[];
  v_faltando uuid[];
  v_conflitos jsonb;
  v_criados int := 0;
  v_sem_amarra int := 0;
begin
  -- A ETAPA AUTOMATICA DO ACORDO A VISTA assina como sistema. A porta e a
  -- mesma de `acordo_avista_registrar`: chave transacional + pilha de chamada.
  -- Esta funcao tem um unico chamador, o registrador do acordo a vista.
  if v_email = '' and public.acordo_avista_porta_interna() then
    v_email := 'conciliacao@sistema';
  end if;
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  -- Cadeado sem fila: se o acordo esta em uso, volta agora, sem ter escrito
  -- nada. Antes esperava e morria nos 8s -- sem saber se gravou ou nao.
  if not pg_try_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0)) then
    return jsonb_build_object('ok',false,'erro','ACORDO_EM_USO');
  end if;

  select aluno_id, upper(coalesce(status,'')), coalesce(numero_acordo::text,'')
    into v_aluno_acordo, v_status_acordo, v_numero
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  -- REGRA DO VINCULO (18/09/2026), por mensalidade:
  --   1. sem vinculo ativo ............ cria o vinculo ativo com este acordo;
  --   2. so vinculo INATIVO antigo .... o historico fica como esta e nasce um
  --                                     vinculo ativo novo;
  --   3. ativo com ESTE acordo ........ trabalho ja feito: nada e duplicado;
  --   4. ativo com OUTRO acordo ....... a operacao inteira volta sem escrever
  --                                     nada: nao move, nao desativa;
  --   5. nunca dois vinculos ativos para a mesma mensalidade (o indice unico
  --      ux_titulo_vinculo_ativo continua de guarda).
  -- Antes, a linha do vinculo so era criada quando a mensalidade nao tinha
  -- NENHUMA linha na tabela -- uma linha inativa de acordo antigo bastava para
  -- a mensalidade sair PAGO sem amarra, e a funcao respondia "ok".

  -- id que nao existe e erro dito, nao item ignorado em silencio
  select array_agg(x) into v_faltando
    from unnest(p_titulo_ids) x
   where not exists (select 1 from public.acordos_titulos t where t.id = x);
  if v_faltando is not null then
    return jsonb_build_object('ok', false, 'erro', 'TITULO_NAO_ENCONTRADO', 'titulos', to_jsonb(v_faltando));
  end if;

  -- regra 4: vinculo ativo com outro acordo -- nada foi escrito ainda
  select jsonb_agg(jsonb_build_object('titulo_id', v.titulo_id, 'acordo_id', v.acordo_id))
    into v_conflitos
    from public.acordo_titulo_vinculo v
   where v.titulo_id = any(p_titulo_ids)
     and v.acordo_id <> p_acordo_id
     and coalesce(v.ativo, true);
  if v_conflitos is not null then
    return jsonb_build_object('ok', false, 'erro', 'TITULO_COM_VINCULO_ATIVO_EM_OUTRO_ACORDO',
                              'conflitos', v_conflitos);
  end if;

  -- regra 3: ja esta neste acordo -- e so conta quando a LINHA do vinculo
  -- ativo existe. `acordo_id` preenchido sem a linha e amarra faltando (regra
  -- 1), nao trabalho feito.
  -- `coalesce` obrigatorio: comparacao com NULL da NULL, e `not NULL` sumiria
  -- com a linha das duas listas.
  select count(*) into v_ja
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and coalesce(
          t.aluno_id = v_aluno_acordo
          and exists (select 1 from public.acordo_titulo_vinculo v
                       where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                         and coalesce(v.ativo,true))
        , false);

  -- regra 1, amarra faltando: a mensalidade ja aponta para este acordo e do
  -- mesmo aluno, mas nao tem a linha do vinculo. So a linha nasce; situacao e
  -- status ficam como estao.
  select array_agg(t.id) into v_reparo
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and coalesce(t.aluno_id = v_aluno_acordo and t.acordo_id = p_acordo_id, false)
    and not exists (select 1 from public.acordo_titulo_vinculo v
                     where v.titulo_id = t.id and coalesce(v.ativo,true));

  select array_agg(t.id) into v_novos
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not coalesce(
          t.aluno_id = v_aluno_acordo
          and (coalesce(t.acordo_id = p_acordo_id, false)
               or exists (select 1 from public.acordo_titulo_vinculo v
                           where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                             and coalesce(v.ativo,true)))
        , false);

  if (v_novos is null or array_length(v_novos,1) is null)
     and (v_reparo is null or array_length(v_reparo,1) is null) then
    -- tudo que veio ja estava vinculado a este acordo, com a linha ativa
    return jsonb_build_object('ok', true, 'vinculados', 0, 'ja_estavam', v_ja,
                              'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo);
  end if;

  -- mesmo cuidado com NULL aqui: titulo sem aluno_id daria NULL e escaparia da
  -- lista de bloqueados em vez de ser barrado.
  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(coalesce(v_novos, '{}'::uuid[]))
    and not coalesce(
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and lower(coalesce(t.status,'')) not in
            ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
      and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
      and (
            coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
        or upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
      )
    , false);

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object('ok',false,'erro','PARCELAS_INELEGIVEIS',
                              'bloqueados', to_jsonb(v_bloqueados), 'ja_estavam', v_ja);
  end if;

  -- O estado da mensalidade segue o acordo (20260902140000): acordo pago deixa
  -- a mensalidade quitada; acordo ativo deixa negociada.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = p_acordo_id
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));

  if v_novos is not null then
    if v_quitado then
      update public.acordos_titulos t
         set acordo_id = p_acordo_id, situacao = 'PAGO', status = 'quitada',
             motivo_ajuste = coalesce(t.motivo_ajuste,'')
               || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
               || 'quitada junto com o acordo ' || v_numero
               || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    else
      update public.acordos_titulos t
         set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    end if;
    get diagnostics v_n = row_count;
  end if;

  -- A LINHA DO VINCULO: para toda mensalidade nova ou com amarra faltando que
  -- nao tenha vinculo ATIVO. Linha inativa antiga nao impede mais -- ela e
  -- historico e fica intocada.
  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(coalesce(v_novos, '{}'::uuid[]) || coalesce(v_reparo, '{}'::uuid[]))
    and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v
                     where v.titulo_id = t.id and coalesce(v.ativo,true));
  get diagnostics v_criados = row_count;

  -- A PROVA: toda mensalidade pedida sai com exatamente UM vinculo ativo, e com
  -- este acordo. Se nao, a transacao inteira volta -- a mensalidade nao fica
  -- NEGOCIADO/PAGO sem amarra.
  select count(*) into v_sem_amarra
    from unnest(p_titulo_ids) x
   where (select count(*) from public.acordo_titulo_vinculo v
           where v.titulo_id = x and v.acordo_id = p_acordo_id
             and coalesce(v.ativo, true)) <> 1;
  if v_sem_amarra > 0 then
    raise exception 'VINCULO_INCOMPLETO: % mensalidade(s) sem exatamente um vinculo ativo com o acordo %',
      v_sem_amarra, p_acordo_id;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n, 'ja_estavam', v_ja,
                             'amarras_refeitas', coalesce(cardinality(v_reparo), 0),
                             'vinculos_criados', v_criados,
                             'status_acordo', v_status_acordo,
                             'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end,
                             'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n + coalesce(cardinality(v_reparo), 0),
                            'ja_estavam', v_ja,
                            'amarras_refeitas', coalesce(cardinality(v_reparo), 0),
                            'vinculos_criados', v_criados,
                            'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo,
                            'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end);
end;
$function$;

-- public.caso_protegido_redistribuicao
CREATE OR REPLACE FUNCTION public.caso_protegido_redistribuicao(p_cpf_limpo text, p_status_acionamento text, p_nao_acionar boolean, p_status_financeiro text DEFAULT NULL::text, p_valor_pago numeric DEFAULT NULL::numeric, p_quitado_em date DEFAULT NULL::date, p_valor_quitado numeric DEFAULT NULL::numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_status_norm text := public.normalizar_status_acionamento(p_status_acionamento);
  v_status_fin_norm text := public.normalizar_status_acionamento(p_status_financeiro);
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf_limpo,''), '\D', '', 'g'), 11, '0');
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL'];
begin
  if coalesce(p_nao_acionar, false) then return true; end if;

  if v_status_norm = any(bloq) or v_status_fin_norm = any(bloq) then
    return true;
  end if;

  if v_cpf = '00000000000' or v_cpf = '' then
    null;
  elsif exists (select 1 from public.acordos a where a.cpf = v_cpf and a.status = 'ATIVO')
     or exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = v_cpf and b.status_baixa = 'AGUARDANDO_BAIXA')
     -- pagamento em transito: protege sempre
     or exists (select 1 from public.links_pagamento l where l.aluno_cpf = v_cpf and l.status = 'AGUARDANDO_BAIXA')
     -- link vivo: protege por um dia
     or exists (select 1 from public.links_pagamento l
                 where l.aluno_cpf = v_cpf
                   and l.status in ('LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO')
                   and coalesce(l.enviado_ao_aluno_em, l.enviado_em, l.criado_em)::date >= current_date - 1)
     or exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_cpf = v_cpf and s.status = 'AGUARDANDO_CONFIRMACAO')
  then
    return true;
  end if;

  if (v_status_norm = any(quit) or v_status_fin_norm = any(quit)
      or coalesce(p_valor_pago,0) > 0 or p_quitado_em is not null or coalesce(p_valor_quitado,0) > 0)
     and public.saldo_titulos_aberto(v_cpf) = 0
  then
    return true;
  end if;

  if v_status_norm in (
    'ACORDO FECHADO','ACORDO EM ANDAMENTO','EM NEGOCIACAO',
    'AGUARDANDO PAGAMENTO','AGUARDANDO FINANCEIRO','EMAIL ENVIADO AO FINANCEIRO','E MAIL ENVIADO FINANC',
    'LINK CARTAO ENVIADO','PAGO PARCIAL','VALORES ENVIADOS','PROPOSTA ENVIADA','PROPOSTA DE EXCECAO',
    'TERMO ENVIADO','TERMO RECEBIDO','EM TRATATIVA','RETORNO AGENDADO'
  ) then
    return true;
  end if;

  return false;
end;
$function$;

-- public.contar_carteira_ativa
CREATE OR REPLACE FUNCTION public.contar_carteira_ativa(p_email text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::int FROM public.casos c
   WHERE (p_email IS NULL OR c.operador_email = p_email)
     AND (p_email IS NOT NULL OR c.operador_email IS NOT NULL)
     AND c.encerrado_operacional = false;
$function$;

-- public.calibragem_teto_operador
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
$function$;

-- public.trg_impor_teto_operador
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
      AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
      ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_excedente LOOP
    UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL WHERE id = caso_rec.id;
    INSERT INTO public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em) VALUES (caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'LIBERACAO_AUTOMATICA_TETO_EXCEDIDO', NEW.operador_nome, v_email, 'Teto de ' || v_meta || ' casos excedido apos atribuicao manual -- liberado automaticamente (menor valor, fora dos 10 dias de fidelizacao)', now());
  END LOOP;
  RETURN NEW;
END; $function$;

-- public.assumir_caso_livre
CREATE OR REPLACE FUNCTION public.assumir_caso_livre(p_caso_id uuid)
 RETURNS TABLE(sucesso boolean, mensagem text, caso_liberado uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text; v_nome text; v_upper text; v_new record; v_new_saldo numeric; v_count int;
  v_rel record; v_liberado uuid := null;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  if v_email = '' then return query select false,'Usuario nao identificado. Faca login novamente.',null::uuid; return; end if;
  v_nome := public.nome_operador_por_email(v_email);
  if v_nome is null then return query select false,'Operador nao ativo ou nao identificado.',null::uuid; return; end if;
  v_upper := upper(v_nome);
  select c.*, public.saldo_titulos_aberto(c.cpf_limpo) AS _saldo into v_new
    from public.casos c where c.id = p_caso_id for update;
  if not found then return query select false,'Caso nao encontrado.',null::uuid; return; end if;
  if coalesce(v_new.operador_email,'') <> '' then
    return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
  end if;
  if public.caso_protegido_redistribuicao(v_new.cpf_limpo,v_new.status_acionamento,v_new.nao_acionar,v_new.status_financeiro,v_new.valor_pago,v_new.quitado_em,v_new.valor_quitado)
     or public.caso_encerrado_operacional(v_new.cpf_limpo,v_new.status_atual,v_new.status_acionamento,v_new.status_financeiro,v_new.status_jornada)
     or coalesce(v_new._saldo,0) <= 0 then
    return query select false,'Caso nao elegivel (protegido, encerrado ou sem saldo).',null::uuid; return;
  end if;
  v_new_saldo := v_new._saldo;
  v_count := (select count(*) from public.casos where operador_email = v_email);
  if v_count >= 500 then
    select c.id into v_rel from public.casos c
    where c.operador_email = v_email and c.ultima_tabulacao_em is null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc, c.caso_atualizado_em desc nulls last
    limit 1 for update skip locked;
    if v_rel.id is null then
      return query select false,'Carteira cheia (500) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;
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
    'Assumido caso livre. assumido_por='||v_email||' assumido_em='||now()::text||'. Fidelizacao inicia apenas apos acionamento valido.', now()
  from public.casos where id = p_caso_id;
  if (select count(*) from public.casos where operador_email = v_email) > 500 then
    raise exception 'ROLLBACK: operador ficaria com mais de 500 casos.';
  end if;
  return query select true, 'Atendimento assumido. Acione dentro do prazo operacional para iniciar a fidelizacao de 10 dias.', v_liberado;
end;
$function$;

-- public.nivelar_medias_progressivo
CREATE OR REPLACE FUNCTION public.nivelar_medias_progressivo()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_media_alvo numeric; v_op RECORD; v_caso RECORD; v_pool_id uuid;
  v_margem numeric := 500; v_max_trocas_por_operador int := 5; v_total INT := 0;
BEGIN
  SELECT round(avg(coalesce(total_em_aberto,0))::numeric,2) INTO v_media_alvo FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br';
  IF v_media_alvo IS NULL THEN RETURN 0; END IF;
  FOR v_op IN SELECT operador_email, round(avg(coalesce(total_em_aberto,0))::numeric,2) AS media FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br' GROUP BY operador_email LOOP
    IF v_op.media > v_media_alvo + v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto DESC NULLS LAST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    ELSIF v_op.media < v_media_alvo - v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_total;
END; $function$;

-- public.reforcar_teto_operadores
CREATE OR REPLACE FUNCTION public.reforcar_teto_operadores()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op RECORD;
  v_caso RECORD;
  v_total INT := 0;
BEGIN
  FOR v_op IN
    SELECT operador_email, count(*) AS qtd
    FROM public.casos
    WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br'
    GROUP BY operador_email HAVING count(*) > 500
  LOOP
    FOR v_caso IN
      SELECT c.id FROM public.casos c
      JOIN public.alunos a ON a.id = c.aluno_id
      WHERE c.operador_email = v_op.operador_email
        AND c.quitado_em IS NULL
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%CANCEL%'
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%JURIDIC%'
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%ACORDO%'
        AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
        AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
        AND NOT public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
      ORDER BY a.data_ultimo_acionamento ASC NULLS FIRST
      LIMIT (v_op.qtd - 500)
    LOOP
      UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL,
        caso_atualizado_por = 'job_reforco_teto', caso_atualizado_em = now()
      WHERE id = v_caso.id;
      v_total := v_total + 1;
    END LOOP;
  END LOOP;
  RETURN v_total;
END;
$function$;

-- public.acoes_massivas_tipo_cobranca_alunos
CREATE OR REPLACE FUNCTION public.acoes_massivas_tipo_cobranca_alunos(p_aluno_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(aluno_id uuid, tem_mensalidade boolean, tem_acordo_vencido boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with mens as (
    select distinct t.aluno_id
      from public.acordos_titulos t
     where (p_aluno_ids is null or t.aluno_id = any(p_aluno_ids))
       and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
       and coalesce(lower(t.status), '') <> 'quitada'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA'))
  ),
  ativo as (
    select distinct a.aluno_id
      from public.acordos a
     where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
       and a.status = 'ATIVO'
  ),
  vencido as (
    select distinct a.aluno_id
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
       and a.status = 'ATIVO'
       and p.status = 'VENCIDA'
  ),
  -- acordo vencido, ou mensalidade sem acordo em dia (acordo ativo sem vencida)
  populacao as (
    select v.aluno_id from vencido v
    union
    select m.aluno_id from mens m
     where not exists (select 1 from ativo x where x.aluno_id = m.aluno_id)
  )
  select p.aluno_id,
         exists (select 1 from mens m where m.aluno_id = p.aluno_id),
         exists (select 1 from vencido v where v.aluno_id = p.aluno_id)
    from populacao p;
$function$;

-- public.prime_conferencia_listar
CREATE OR REPLACE FUNCTION public.prime_conferencia_listar()
 RETURNS TABLE(titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text, vencimento date, valor_em_aberto numeric, liquidado_em date, tem_acordo_ativo boolean, operador_responsavel text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    t.id, t.aluno_id, coalesce(a.nome,'-'), t.cpf,
    btrim(coalesce(t.documento,'')),
    t.vencimento,
    round(coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0), 2),
    p.liquidado_em,
    exists (select 1 from public.acordos ac where ac.aluno_id = t.aluno_id and ac.status = 'ATIVO'),
    coalesce(a.responsavel_atual_nome, a.responsavel_atual_email, 'Sem responsável')
  from public.acordos_titulos t
  join public.prime_titulo_semestre p
    on btrim(coalesce(p.boleto,'')) = btrim(coalesce(t.documento,''))
   and coalesce(p.boleto,'') <> ''
  left join public.alunos a on a.id = t.aluno_id
  where public.crm_usuario_pode_quitar_baixar()
    and t.status = 'em_aberto'
    and p.liquidado_em is not null
    and not exists (
      select 1 from public.acordos ac
      where ac.aluno_id = t.aluno_id and ac.status = 'CANCELADO'
    )
    -- Fora da tela: cobranca que nao e comum.
    and coalesce(upper(a.status_jornada),'')     not in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA')
    and coalesce(upper(a.status_atual),'')       not in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA')
    and coalesce(upper(a.status_acionamento),'') not in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA')
  order by p.liquidado_em desc, t.vencimento;
$function$;

-- public.prime_conferencia_fila
CREATE OR REPLACE FUNCTION public.prime_conferencia_fila()
 RETURNS TABLE(titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text, vencimento date, valor_em_aberto numeric, liquidado_em date, tem_acordo_ativo boolean, operador_responsavel text, portador integer, portador_diz text, dinheiro text, dinheiro_diz text, lote_titulos numeric, lote_pago numeric, lote_cobertura numeric, lote_diz text, acordo_situacao text, acordo_diz text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
  with inicio as (select coalesce(min(data_pagamento), current_date) as d from public.pagamentos),
  base as (
    select l.*, pt.carrier_id, inicio.d as inicio_base
      from public.prime_conferencia_listar() l
      cross join inicio
      left join lateral (
        select p.carrier_id from public.prime_titulo_semestre p
         where p.boleto = l.documento limit 1
      ) pt on true
     where not exists (
       select 1 from public.prime_conferencia_decisao dc where dc.titulo_id = l.titulo_id
     )
  ),
  lote as (
    select b.aluno_id, b.liquidado_em,
           sum(b.valor_em_aberto) as soma_titulos,
           (select coalesce(sum(p.valor_pago),0) from public.pagamentos p
             where p.aluno_id = b.aluno_id
               and p.data_pagamento between b.liquidado_em - 5 and b.liquidado_em + 5) as soma_pago
      from base b
     where b.liquidado_em is not null
     group by 1,2
  )
  select b.titulo_id, b.aluno_id, b.aluno_nome, b.cpf, b.documento,
         b.vencimento, b.valor_em_aberto, b.liquidado_em,
         b.tem_acordo_ativo, b.operador_responsavel,
         b.carrier_id,
         case b.carrier_id
           when 195 then 'Prime ainda cobra este título'
           when 166 then 'Prime tirou da cobrança'
           else case when b.carrier_id is null then 'Prime não informa o portador'
                     else 'Portador ' || b.carrier_id::text end
         end,
         d.veredito,
         case d.veredito
           when 'ENTROU'     then 'Pagamento do aluno no Santander na mesma janela'
           when 'OUTRA_DATA' then 'Aluno pagou, mas em data diferente da liquidação'
           when 'NAO_ENTROU' then 'Nenhum pagamento do aluno — liquidou sem dinheiro entrar'
           else 'Liquidado antes de a base ter pagamentos — não dá para julgar'
         end,
         round(lo.soma_titulos, 2), round(lo.soma_pago, 2),
         case when coalesce(lo.soma_titulos,0) > 0
              then round(100.0 * lo.soma_pago / lo.soma_titulos, 0) end,
         case
           when lo.soma_titulos is null then null
           when lo.soma_pago >= lo.soma_titulos * 0.98 then 'O pagamento cobre todos os títulos liquidados neste dia'
           when lo.soma_pago >= lo.soma_titulos * 0.5  then 'O pagamento cobre só parte do que foi liquidado'
           when lo.soma_pago > 0 then 'Pagou muito abaixo do que foi liquidado — provável negociação'
           else null
         end,
         ac.situacao,
         case ac.situacao
           when 'SEM_ACORDO'      then 'Liquidou no Prime e não existe acordo no CRM — simulação que não virou nada'
           when 'ACORDO_ATIVO'    then 'Tem acordo ativo: o título virou acordo e segue aberto — cobrança em dobro'
           when 'ACORDO_ENCERRADO' then 'Teve acordo, já encerrado'
           else null
         end
    from base b
    join lateral (
      select case
        when b.liquidado_em is null or b.liquidado_em < b.inicio_base then 'FORA_DA_JANELA'
        when exists (select 1 from public.pagamentos p
                      where p.aluno_id = b.aluno_id
                        and p.data_pagamento between b.liquidado_em - 5 and b.liquidado_em + 5)
          then 'ENTROU'
        when exists (select 1 from public.pagamentos p where p.aluno_id = b.aluno_id)
          then 'OUTRA_DATA'
        else 'NAO_ENTROU'
      end as veredito
    ) d on true
    join lateral (
      select case
        when exists (select 1 from public.acordos a
                      where a.aluno_id = b.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO')
          then 'ACORDO_ATIVO'
        when exists (select 1 from public.acordos a where a.aluno_id = b.aluno_id)
          then 'ACORDO_ENCERRADO'
        else 'SEM_ACORDO'
      end as situacao
    ) ac on true
    left join lote lo on lo.aluno_id = b.aluno_id and lo.liquidado_em = b.liquidado_em;
$function$;

-- public.prime_conferencia_baixar
CREATE OR REPLACE FUNCTION public.prime_conferencia_baixar(p_titulo_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_titulo    public.acordos_titulos%rowtype;
  v_liquidado date;
  v_valor     numeric;
  v_bloqueio  text;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'SEM_PERMISSAO: seu usuário não pode dar baixa em título.';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;

  if v_titulo.status <> 'em_aberto' then
    return jsonb_build_object('ja_processado', true, 'status', v_titulo.status, 'situacao', v_titulo.situacao);
  end if;

  select case
           when upper(coalesce(a.status_jornada,''))     in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_jornada)
           when upper(coalesce(a.status_atual,''))       in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_atual)
           when upper(coalesce(a.status_acionamento,'')) in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_acionamento)
         end
    into v_bloqueio
  from public.alunos a where a.id = v_titulo.aluno_id;

  if v_bloqueio is not null then
    raise exception 'COBRANCA_NAO_COMUM: aluno está como % -- fora do escopo desta conferência.', v_bloqueio;
  end if;

  select p.liquidado_em into v_liquidado
  from public.prime_titulo_semestre p
  where btrim(coalesce(p.boleto,'')) = btrim(coalesce(v_titulo.documento,''))
    and coalesce(p.boleto,'') <> ''
    and p.liquidado_em is not null
  limit 1;

  if v_liquidado is null then
    raise exception 'SEM_PROVA_NA_PRIME: este titulo nao tem boleto liquidado na Prime.';
  end if;

  if exists (select 1 from public.acordos ac where ac.aluno_id = v_titulo.aluno_id and ac.status = 'CANCELADO') then
    raise exception 'ACORDO_CANCELADO: aluno tem acordo cancelado -- conferir na mao.';
  end if;

  v_valor := round(coalesce(v_titulo.valor_em_aberto, v_titulo.saldo_corrigido, v_titulo.valor_original, 0), 2);

  update public.acordos_titulos set status = 'quitada', situacao = 'PAGO' where id = p_titulo_id;

  if v_titulo.aluno_id is not null then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_titulo.aluno_id::text,
      'BAIXA_CONFERENCIA_PRIME',
      concat_ws(' ',
        'Titulo', btrim(coalesce(v_titulo.documento,'')),
        'venc.', to_char(v_titulo.vencimento, 'DD/MM/YYYY'),
        'baixado por conferencia com a Prime (liquidado em',
        to_char(v_liquidado, 'DD/MM/YYYY') || ').',
        nullif(btrim(coalesce(p_observacao,'')), '')
      ),
      v_email, now(), v_valor
    );
  end if;

  return jsonb_build_object('ja_processado', false, 'titulo_id', p_titulo_id,
                            'valor_baixado', v_valor, 'liquidado_em', v_liquidado);
end;
$function$;

-- public.prime_conferencia_confirmar
CREATE OR REPLACE FUNCTION public.prime_conferencia_confirmar(p_titulo_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', '')); v_res jsonb;
begin
  v_res := public.prime_conferencia_baixar(p_titulo_id, p_observacao);

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  values (p_titulo_id, 'CONFIRMADO', nullif(trim(coalesce(p_observacao,'')),''), nullif(v_email,''))
  on conflict (titulo_id) do update
    set decisao = 'CONFIRMADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'decisao', 'CONFIRMADO');
end;
$function$;

-- public.prime_conferencia_rejeitar
CREATE OR REPLACE FUNCTION public.prime_conferencia_rejeitar(p_titulo_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  values (p_titulo_id, 'REJEITADO', nullif(trim(coalesce(p_motivo,'')),''), nullif(v_email,''))
  on conflict (titulo_id) do update
    set decisao = 'REJEITADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  return jsonb_build_object('ok', true, 'decisao', 'REJEITADO');
end;
$function$;

-- public.prime_conferencia_rejeitar_lote
CREATE OR REPLACE FUNCTION public.prime_conferencia_rejeitar_lote(p_titulo_ids uuid[], p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_n int;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  if p_titulo_ids is null or array_length(p_titulo_ids, 1) is null then
    return jsonb_build_object('ok', false, 'motivo', 'LISTA_VAZIA');
  end if;

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  select t, 'REJEITADO', nullif(trim(coalesce(p_motivo,'')),''), nullif(v_email,'')
    from unnest(p_titulo_ids) as t
  on conflict (titulo_id) do update
    set decisao = 'REJEITADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'rejeitados', v_n);
end;
$function$;


-- gatilhos de producao que a regra atravessa
create trigger trg_auto_quitar_titulo after update of situacao on public.acordos_titulos
  for each row execute function _trg_auto_quitar_titulo();
create trigger trg_fechar_confirmacao_titulo after update on public.acordos_titulos
  for each row when ((((upper(coalesce(new.situacao, ''::text)) = any (array['PAGO'::text, 'QUITADO'::text]))
    and (upper(coalesce(old.situacao, ''::text)) <> all (array['PAGO'::text, 'QUITADO'::text])))
    or ((lower(coalesce(new.status, ''::text)) = any (array['quitada'::text, 'quitado'::text, 'paga'::text, 'pago'::text]))
    and (lower(coalesce(old.status, ''::text)) <> all (array['quitada'::text, 'quitado'::text, 'paga'::text, 'pago'::text])))))
  execute function _fechar_confirmacao_ao_zerar_saldo();
create trigger trg_reabrir_quitado_titulo after insert on public.acordos_titulos
  for each row execute function _reabrir_quitado_ao_incluir_titulo();
create trigger trg_titulo_liquidado_na_origem_e_terminal before update on public.acordos_titulos
  for each row execute function titulo_liquidado_na_origem_e_terminal();
create trigger trg_titulo_normaliza_vinculo_incoerente before insert or update on public.acordos_titulos
  for each row execute function tg_titulo_normaliza_vinculo_incoerente();
create trigger trg_titulo_situacao_status_coerentes before insert or update of situacao, status on public.acordos_titulos
  for each row execute function _titulo_situacao_e_status_coerentes();

create trigger trg_parcela_guarda_titulo_origem after insert or delete or update on public.acordo_titulo_vinculo
  for each row execute function _parcela_guarda_titulo_origem();
create trigger trg_recalc_vinculo_ins after insert on public.acordo_titulo_vinculo
  referencing new table as novas for each statement execute function _trg_recalc_por_vinculo_novo();
create trigger trg_recalc_vinculo_upd after update on public.acordo_titulo_vinculo
  referencing new table as novas for each statement execute function _trg_recalc_por_vinculo_novo();
create trigger trg_titulo_situacao_por_vinculo after insert or delete or update on public.acordo_titulo_vinculo
  for each row execute function titulo_situacao_por_vinculo();

create trigger trg_casos_set_encerrado_operacional before insert or update on public.casos
  for each row execute function casos_set_encerrado_operacional();
create trigger trigger_impor_teto_operador after update on public.casos
  for each row when (((new.operador_email is not null) and (new.operador_email is distinct from old.operador_email)))
  execute function trg_impor_teto_operador();
