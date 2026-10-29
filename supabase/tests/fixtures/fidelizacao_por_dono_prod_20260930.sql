-- FIXTURE ESTRUTURAL DERIVADA DA PRODUCAO em 2026-09-30 (projeto ahattpqrjmhkzsmnbdzs).
--
-- >>> Fixture estrutural derivada de producao, sem dados reais.
-- >>> Serve exclusivamente para teste.
-- >>> Nao aplicar em producao. Nao e migration.
--
-- COMO FOI GERADA: somente consultas de catalogo, em producao SOMENTE LEITURA --
-- pg_get_functiondef, pg_get_triggerdef, pg_get_indexdef, pg_get_constraintdef,
-- pg_attribute, pg_attrdef. NENHUM `select` em tabela de negocio.
--
-- NENHUM DADO REAL: zero linhas. Nao ha nome, CPF, telefone, e-mail de aluno,
-- valor, aluno_id, caso_id, acordo_id nem pagamento_id de producao. Os unicos
-- literais de pessoa que aparecem vem de DEFAULT de coluna e de corpo de funcao
-- em producao (o mapa de e-mails de operador em trg_sincronizar_alunos_apos_casos
-- e o default de responsavel_baixa_* em baixas_pagamento) -- sao ESTRUTURA, e
-- foram mantidos byte a byte porque alterar quebraria o md5 de fidelidade.
--
-- FIDELIDADE: 37 funcoes com o texto EXATO de producao, cada corpo conferido por
-- md5(prosrc) contra fidelizacao_por_dono_prod_20260930.md5.json. O teste falha
-- se qualquer corpo divergir.
--
-- ESCOPO: fechamento transitivo das dependencias da migration
-- 20260930090000_fidelizacao_por_responsavel_atual.sql, partindo das 9 funcoes
-- que ela invoca, MAIS as 12 funcoes de gatilho de INSERT/UPDATE de public.casos
-- e public.aluno_movimentacoes, MAIS o CAMINHO REAL DE LIBERACAO
-- (liberar_fidelizacao_caso e liberar_casos_fidelizacao_vencida).
-- Resultado: 37 funcoes, 21 tabelas, 12 gatilhos, 33 indices, 5 sequencias.
--
-- POR QUE O CAMINHO DE LIBERACAO ENTROU: a migration
-- 20260929101500_fidelizacao_10_dias_fechar_caminhos_automaticos, ja em main,
-- colocou uma guarda DENTRO de liberar_fidelizacao_caso:
--     if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento)
--        then return false; end if;
-- Essa guarda olha o relogio do CASO. Sem ter a funcao na fixture, o teste nao
-- teria como provar o que acontece quando a v2 (relogio do DONO) marca um caso
-- elegivel e o caminho de liberacao o recusa. Ver o bloco
-- "INTERACAO COM liberar_fidelizacao_caso" no teste de comportamento.
--
-- GATILHO EXCLUIDO, com justificativa: trg_audit_del (AFTER DELETE em casos).
-- Nenhum teste executa DELETE em casos.
--
-- STUBS TECNICOS -- infraestrutura externa, nao regra de negocio:
--   auth.jwt()          -- claims do PostgREST; no teste devolve o que o cenario
--                          puser em request.jwt.claims.
--   anon / authenticated / service_role -- papeis que o Supabase cria em todo
--                          projeto; sem eles os grant/revoke nao tem alvo.
-- Nenhuma regra de negocio foi dublada. As extensoes que producao usa --
-- unaccent, pg_trgm e uuid-ossp -- existem no PGlite como contrib e sao
-- carregadas de verdade, sem substituto.
--
-- NOTA TECNICA: pg_get_functiondef nao emite o `;` final. Ele foi acrescentado
-- apenas ao delimitador de FECHAMENTO de cada definicao (nunca ao de abertura),
-- para o script poder ser executado em lote. O corpo nao e tocado -- por isso os
-- md5 continuam fechando.

set check_function_bodies = off;

-- FUSO DO BANCO IGUAL AO DE PRODUCAO. Medido em producao: TimeZone = UTC
-- (sessao e servidor). O PGlite herda o fuso do processo; sem fixar isto, um
-- teste rodado no Brasil passaria por acidente e o mesmo teste falharia no CI em
-- UTC. E justamente a diferenca que a regra nova existe para tratar.
set timezone to 'UTC';

create extension if not exists unaccent;
create extension if not exists pg_trgm;
create extension if not exists "uuid-ossp";

create schema if not exists internal;
create schema if not exists auth;

-- STUB TECNICO (infraestrutura, nao regra): os papeis que o Supabase cria em
-- todo projeto. Sem eles os `grant`/`revoke` da migration nao tem alvo.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end
$roles$;

-- STUB TECNICO (infraestrutura, nao regra): claims do PostgREST.
create or replace function auth.jwt() returns jsonb language sql stable as $stub$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$stub$;

-- ========== SEQUENCIAS (5) ==========
create sequence if not exists acordos_numero_acordo_seq;
create sequence if not exists aluno_movimentacoes_id_seq;
create sequence if not exists alunos_estado_anterior_id_seq;
create sequence if not exists ficha_reabertura_barrada_id_seq;
create sequence if not exists reposicao_carteira_fila_id_seq;

-- ========== TABELAS (21) -- estrutura de producao: colunas, tipos, defaults,
-- NOT NULL, PK, UNIQUE, CHECK e as FKs cujo alvo esta nesta fixture ==========
create table if not exists public.acoes_desfazer (
  id uuid not null default gen_random_uuid(),
  tipo text not null,
  aluno_id uuid not null,
  aluno_nome text,
  referencia_id uuid,
  movimentacao_id bigint,
  operador_email text not null,
  operador_nome text,
  rotulo text not null,
  estado_anterior jsonb,
  atribuiu_responsavel boolean not null default false,
  criado_em timestamp with time zone not null default now(),
  desfeito_em timestamp with time zone,
  desfeito_por text,
  motivo text,
  resultado jsonb,
  constraint acoes_desfazer_pkey PRIMARY KEY (id),
  constraint acoes_desfazer_tipo_check CHECK ((tipo = ANY (ARRAY['TERMO_ENVIADO'::text, 'LINK_SOLICITADO'::text, 'TABULACAO'::text])))
);

create table if not exists public.acordo_titulo_vinculo (
  id uuid not null default gen_random_uuid(),
  acordo_id uuid not null,
  titulo_id uuid not null,
  ativo boolean not null default true,
  vinculado_por text,
  motivo_desvinculo text,
  criado_em timestamp with time zone not null default now(),
  origem text,
  constraint acordo_titulo_vinculo_pkey PRIMARY KEY (id)
);

create table if not exists public.acordos (
  id uuid not null default gen_random_uuid(),
  aluno_id uuid,
  cpf text,
  tipo text not null default 'ACORDO'::text,
  forma_pagamento text not null default 'PARCELADO'::text,
  valor_total numeric,
  qtd_parcelas integer not null default 1,
  valor_entrada numeric,
  entrada_paga boolean not null default false,
  data_entrada date,
  status text not null default 'ATIVO'::text,
  observacao text,
  criado_por_nome text,
  criado_por_email text,
  confirmado_por_email text,
  confirmado_em timestamp with time zone,
  criado_em timestamp with time zone not null default now(),
  atualizado_em timestamp with time zone not null default now(),
  numero_acordo bigint not null default nextval('acordos_numero_acordo_seq'::regclass),
  operador_responsavel_email text,
  unidade text,
  entrada_percentual numeric,
  honorarios_percentual numeric,
  honorarios_valor numeric,
  saldo numeric,
  motivo_ajuste text,
  operador_responsavel_nome text,
  duplicado_de uuid,
  duplicado_marcado_em timestamp with time zone,
  numero_ulbra text,
  constraint acordos_pkey PRIMARY KEY (id)
);

create table if not exists public.acordos_titulos (
  id uuid not null default uuid_generate_v4(),
  aluno_id uuid,
  cpf text,
  documento text,
  vencimento date,
  valor_original numeric(14,2),
  saldo_corrigido numeric(14,2),
  situacao text,
  tipo_boleto text,
  dados jsonb,
  importacao_id uuid,
  created_at timestamp without time zone default now(),
  status text not null default 'em_aberto'::text,
  valor_em_aberto numeric,
  competencia text,
  motivo_ajuste text,
  atualizado_em timestamp with time zone default now(),
  acordo_id uuid,
  vinculado_em timestamp with time zone,
  vinculado_por text,
  valor_cobranca_ajustado numeric,
  motivo_ajuste_valor text,
  valor_ajustado_por text,
  valor_ajustado_em timestamp with time zone,
  origem_liquidacao text,
  origem_liquidacao_ref text,
  origem_liquidacao_em timestamp with time zone,
  origem_encerramento text,
  origem_encerramento_ref text,
  origem_encerramento_em timestamp with time zone,
  constraint acordos_titulos_documento_key UNIQUE (documento),
  constraint acordos_titulos_origem_encerramento_valida CHECK (((origem_encerramento IS NULL) OR (origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA'::text))),
  constraint acordos_titulos_origem_liquidacao_valida CHECK (((origem_liquidacao IS NULL) OR (origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL'::text))),
  constraint acordos_titulos_pkey PRIMARY KEY (id),
  constraint acordos_titulos_valor_cobranca_ajustado_positivo CHECK (((valor_cobranca_ajustado IS NULL) OR (valor_cobranca_ajustado > (0)::numeric))) NOT VALID
);

create table if not exists public.aluno_movimentacoes (
  id bigint not null default nextval('aluno_movimentacoes_id_seq'::regclass),
  aluno_id text not null,
  tipo text not null,
  descricao text,
  status_anterior text,
  status_novo text,
  registrado_por_nome text,
  registrado_por_email text,
  registrado_em timestamp with time zone not null default now(),
  operador_anterior_nome text,
  operador_anterior_email text,
  operador_novo_nome text,
  operador_novo_email text,
  data_retorno timestamp with time zone,
  solicitacao_link_id uuid,
  baixa_pagamento_id uuid,
  link_pagamento text,
  motivo_devolucao text,
  valor_movimentacao numeric,
  elogio_print_path text,
  elogio_print_nome text,
  elogio_aprovado_tv boolean default false,
  elogio_aprovado_por text,
  elogio_aprovado_em timestamp with time zone,
  elogio_rejeitado_tv boolean default false,
  elogio_rejeitado_por text,
  elogio_rejeitado_em timestamp with time zone,
  lote_id uuid,
  constraint aluno_movimentacoes_pkey PRIMARY KEY (id)
);

create table if not exists public.alunos (
  id uuid not null default uuid_generate_v4(),
  cpf text,
  cpf_mascarado text,
  matricula text,
  nome text not null,
  email text,
  telefone text,
  curso text,
  unidade text,
  semestre text,
  situacao_academica text,
  status_jornada text default 'Em cobrança'::text,
  origem text,
  aluno_novo boolean default false,
  sem_telefone boolean default false,
  sem_email boolean default false,
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now(),
  nome_normalizado text,
  operador text,
  status_atual text,
  ultimo_contato date,
  data_retorno date,
  valor_em_aberto numeric(12,2) default 0,
  hora_retorno text,
  atualizado_em timestamp with time zone default now(),
  operador_nome text,
  operador_email text,
  observacao text,
  tipo_base text,
  nome_aluno text,
  nome_referencia text,
  cpf_corrigido text,
  cpf_status_correcao text,
  registro_unico uuid default gen_random_uuid(),
  chave_unificacao text,
  unificacao_status text,
  registrado_por_nome text,
  registrado_por_email text,
  registrado_em timestamp with time zone,
  responsavel_atual_nome text,
  responsavel_atual_email text,
  responsavel_atual_em timestamp with time zone,
  status_acionamento text,
  proxima_acao text,
  data_ultimo_acionamento timestamp with time zone,
  status_link_pagamento text,
  status_baixa_pagamento text,
  fila_destino text,
  ultimo_link_pagamento_id uuid,
  ultima_baixa_pagamento_id uuid,
  nivel_criticidade text,
  processo_numero text,
  processo_prazo_tipo text,
  processo_prazo_data date,
  nome_resp1 text,
  telefone_resp1 text,
  nome_resp2 text,
  telefone_resp2 text,
  situacao_operacional text,
  saldo_vencido numeric,
  saldo_total numeric,
  curso_real text,
  academico_codigo text,
  academico_fonte text,
  academico_atualizado_em timestamp with time zone,
  retorno_confirmado_em timestamp with time zone,
  retorno_origem text,
  semestre_divida text,
  semestre_divida_em timestamp with time zone,
  constraint alunos_pkey PRIMARY KEY (id)
);

create table if not exists public.alunos_estado_anterior (
  id bigint not null default nextval('alunos_estado_anterior_id_seq'::regclass),
  aluno_id uuid not null,
  estado jsonb not null,
  ator text,
  criado_em timestamp with time zone not null default now(),
  constraint alunos_estado_anterior_pkey PRIMARY KEY (id)
);

create table if not exists public.baixas_pagamento (
  id uuid not null default gen_random_uuid(),
  aluno_id text not null,
  solicitacao_link_id uuid,
  aluno_nome text,
  aluno_cpf text,
  valor_pago numeric,
  comprovante_url text,
  comprovante_nome_arquivo text,
  observacao_operador text,
  status_baixa text not null default 'AGUARDANDO_BAIXA'::text,
  operador_origem_nome text,
  operador_origem_email text,
  responsavel_baixa_nome text default 'Amanda Seibel'::text,
  responsavel_baixa_email text default 'amanda.seibel@aelbra.com.br'::text,
  recebido_em timestamp with time zone not null default now(),
  atualizado_em timestamp with time zone not null default now(),
  baixado_por_nome text,
  baixado_por_email text,
  baixado_em timestamp with time zone,
  devolvido_por_nome text,
  devolvido_por_email text,
  devolvido_em timestamp with time zone,
  motivo_devolucao text,
  parcela_id uuid,
  acordo_id uuid,
  honorarios_recebidos numeric,
  data_pagamento date,
  constraint baixas_pagamento_pkey PRIMARY KEY (id)
);

create table if not exists public.calibragem_parametros (
  chave text not null,
  valor jsonb not null,
  descricao text,
  atualizado_em timestamp with time zone not null default now(),
  atualizado_por text,
  constraint calibragem_parametros_pkey PRIMARY KEY (chave)
);

create table if not exists public.casos (
  id uuid not null default gen_random_uuid(),
  caso_codigo integer,
  cpf_original text,
  cpf_limpo text,
  cpf_mascarado text,
  matricula text,
  nome text,
  nome_normalizado text,
  operador_base text,
  operador_mensalidade text,
  operador_acordo text,
  operador_acordo_planilha text,
  status_atual text,
  data_ultimo_acionamento date,
  status_acionamento text,
  criticidade text,
  proxima_acao_automatica text,
  total_em_aberto numeric,
  data_retorno date,
  dias_atraso integer,
  nivel_carteira text,
  sla_operacional text,
  urgencia text,
  observacoes text,
  mensalidades_em_aberto numeric,
  acordo_em_aberto numeric,
  parcela_a_vencer numeric,
  parcelas_vencidas numeric,
  proximo_vencimento date,
  valor_pago numeric,
  honorario numeric,
  data_pagamento date,
  status_financeiro text,
  observacao_financeira text,
  created_at timestamp without time zone default now(),
  data_retorno_nova date,
  ultima_tabulacao_em timestamp without time zone,
  fila_responsavel text,
  hora_retorno time without time zone,
  observacao_operacional text,
  status_termo text default 'Sem termo'::text,
  termo_status_validacao text,
  termo_url text,
  termo_nome_arquivo text,
  termo_observacao text,
  termo_motivo_rejeicao text,
  termo_enviado_por text,
  termo_validado_por text,
  termo_validado_em timestamp with time zone,
  nome_aluno text,
  cpf text,
  status_jornada text,
  operador text,
  observacao text,
  aluno text,
  nome_completo text,
  email text,
  telefone text,
  curso text,
  unidade text,
  semestre text,
  ultimo_acionamento date,
  valor_em_aberto numeric,
  valor_aberto numeric,
  valor_total numeric,
  valor_divida numeric,
  saldo_devedor numeric,
  valor numeric,
  origem text,
  operador_nome text,
  operador_email text,
  nome_referencia text,
  cpf_corrigido text,
  cpf_status_correcao text,
  registro_unico uuid default gen_random_uuid(),
  chave_unificacao text,
  unificacao_status text,
  origem_quitacao text,
  quitado_em date,
  valor_quitado numeric default 0,
  baixa_importada_id uuid,
  valor_cobranca_ajustado numeric,
  motivo_ajuste_valor text,
  valor_ajustado_por text,
  valor_ajustado_em timestamp with time zone,
  cadastro_caso_observacao text,
  caso_atualizado_por text,
  caso_atualizado_em timestamp with time zone,
  nao_acionar boolean not null default false,
  aluno_id uuid,
  nivelamento_marcador text,
  nivelamento_em timestamp with time zone,
  nivelamento_simulacao_id uuid,
  situacao_operacional text,
  saldo_vencido numeric,
  saldo_total numeric,
  encerrado_operacional boolean not null default false,
  operador_mensalidade_email text,
  operador_mensalidade_nome text,
  mensalidade_girada_em timestamp with time zone,
  constraint casos_pkey PRIMARY KEY (id)
);

create table if not exists public.elogios_atendimento (
  id uuid not null default gen_random_uuid(),
  aluno_id uuid,
  movimentacao_id bigint,
  operador_email text not null,
  operador_nome text not null,
  print_path text,
  print_nome_arquivo text,
  observacao_operador text,
  texto_final_tv text,
  status text not null default 'PENDENTE_ANALISE'::text,
  motivo_rejeicao text,
  analisado_por_email text,
  analisado_por_nome text,
  analisado_em timestamp with time zone,
  exibir_de date,
  exibir_ate date,
  publicado_por_email text,
  publicado_em timestamp with time zone,
  arquivado_por_email text,
  arquivado_em timestamp with time zone,
  registrado_por_email text not null,
  registrado_por_nome text,
  registrado_em timestamp with time zone not null default now(),
  atualizado_em timestamp with time zone not null default now(),
  constraint elogios_atendimento_pkey PRIMARY KEY (id),
  constraint elogios_motivo_rejeicao_obrigatorio CHECK (((status <> 'REJEITADO_TV'::text) OR (NULLIF(btrim(motivo_rejeicao), ''::text) IS NOT NULL))),
  constraint elogios_movimentacao_unica UNIQUE (movimentacao_id),
  constraint elogios_periodo_valido CHECK (((exibir_de IS NULL) OR (exibir_ate IS NULL) OR (exibir_ate >= exibir_de))),
  constraint elogios_status_check CHECK ((status = ANY (ARRAY['PENDENTE_ANALISE'::text, 'APROVADO_TV'::text, 'REJEITADO_TV'::text, 'PUBLICADO_TV'::text, 'ARQUIVADO'::text])))
);

create table if not exists public.ficha_reabertura_barrada (
  id bigint not null default nextval('ficha_reabertura_barrada_id_seq'::regclass),
  caso_id uuid not null,
  caso_codigo integer,
  aluno_id uuid not null,
  outro_caso_id uuid,
  outro_codigo integer,
  nome text,
  em timestamp with time zone not null default now(),
  constraint ficha_reabertura_barrada_pkey PRIMARY KEY (id)
);

create table if not exists public.historico_operadores_alunos (
  id uuid not null default gen_random_uuid(),
  aluno_id uuid,
  chave_unificacao text,
  nome_aluno text,
  cpf_referencia text,
  acao text not null,
  operador_nome text,
  operador_email text,
  operador_anterior_nome text,
  operador_anterior_email text,
  status_jornada_anterior text,
  status_jornada_novo text,
  data_retorno_anterior date,
  data_retorno_nova date,
  observacao text,
  criado_em timestamp with time zone default now(),
  constraint historico_operadores_alunos_pkey PRIMARY KEY (id)
);

create table if not exists public.links_pagamento (
  id uuid not null default gen_random_uuid(),
  aluno_id text,
  aluno_nome text,
  aluno_cpf text,
  operador_nome text,
  operador_email text,
  tipo_pagamento text default 'Cartão'::text,
  parcelas integer,
  valor numeric,
  vencimento date,
  link_url text,
  status text not null default 'SOLICITADO'::text,
  observacao_operador text,
  observacao_adm text,
  solicitado_por text,
  solicitado_em timestamp with time zone default now(),
  gerado_por text,
  gerado_em timestamp with time zone,
  enviado_em timestamp with time zone,
  pago_em timestamp with time zone,
  cancelado_em timestamp with time zone,
  atualizado_em timestamp with time zone default now(),
  baixado_por text,
  baixado_em timestamp with time zone,
  divergencia_motivo text,
  divergencia_em timestamp with time zone,
  comprovante_url text,
  comprovante_nome text,
  pagamento_identificado_por text,
  pagamento_identificado_em timestamp with time zone,
  nome_referencia text,
  cpf_corrigido text,
  cpf_status_correcao text,
  registro_unico uuid default gen_random_uuid(),
  chave_unificacao text,
  unificacao_status text,
  nome_aluno text,
  cpf_referencia text,
  forma_pagamento text,
  observacao_solicitacao text,
  link_gerado text,
  link_gerado_por text,
  link_gerado_em timestamp with time zone,
  enviado_ao_aluno_em timestamp with time zone,
  comprovante_anexado_por text,
  comprovante_anexado_em timestamp with time zone,
  baixa_realizada_por text,
  baixa_realizada_em timestamp with time zone,
  motivo_divergencia text,
  criado_em timestamp with time zone default now(),
  operador_solicitante text,
  data_vencimento date,
  observacao text,
  link_pagamento text,
  mensagem_pronta text,
  adm_responsavel text,
  assumido_em timestamp with time zone,
  respondido_em timestamp with time zone,
  enviado_operador_em timestamp with time zone,
  alerta_7min boolean default false,
  observacao_comprovante text,
  baixa_devolvida_em timestamp with time zone,
  baixa_devolvida_por text,
  valor_pago numeric,
  constraint links_pagamento_pkey PRIMARY KEY (id),
  constraint links_pagamento_status_check CHECK ((status = ANY (ARRAY['SOLICITADO_LINK'::text, 'LINK_EM_ATENDIMENTO'::text, 'LINK_PRONTO_PARA_ENVIO'::text, 'LINK_ENVIADO_AO_ALUNO'::text, 'AGUARDANDO_BAIXA'::text, 'BAIXA_REALIZADA'::text, 'BAIXA_DEVOLVIDA'::text, 'CANCELADO'::text, 'DIVERGENCIA'::text])))
);

create table if not exists public.pagamentos (
  id uuid not null default uuid_generate_v4(),
  aluno_id uuid,
  cpf text,
  data_pagamento date,
  valor_pago numeric(14,2),
  tipo_pagamento text,
  entrada_paga boolean default false,
  dados jsonb,
  importacao_id uuid,
  created_at timestamp without time zone default now(),
  operador_email text,
  operador_nome text,
  valor_honorario numeric default 0,
  aluno_nome text,
  retroativo boolean not null default false,
  titulo_numero text,
  operador_ajustado_manualmente boolean not null default false,
  numero_parcela_completo text,
  matricula text,
  origem_vinculo text,
  origem_vinculo_ref text,
  origem_vinculo_em timestamp with time zone,
  status_conciliacao text,
  conciliacao_motivo text,
  conciliacao_em timestamp with time zone,
  constraint pagamentos_origem_vinculo_valida CHECK (((origem_vinculo IS NULL) OR (origem_vinculo = ANY (ARRAY['CPF'::text, 'BOLETO_EXATO'::text, 'PREFIXO_UNICO'::text, 'NUMERO_ULBRA_UNICO'::text, 'GESTAO_MANUAL'::text, 'SEM_VINCULO'::text])))),
  constraint pagamentos_pkey PRIMARY KEY (id),
  constraint pagamentos_status_conciliacao_valido CHECK (((status_conciliacao IS NULL) OR (status_conciliacao = ANY (ARRAY['BAIXADO'::text, 'AGUARDANDO_ACORDO'::text, 'AGUARDANDO_AMARRACAO'::text, 'PARCELA_JA_PAGA'::text, 'REVISAO'::text, 'SEM_VINCULO'::text, 'ACORDO_CONFIRMADO_SEM_ESTRUTURA'::text, 'TITULO_ORIGINAL_LIQUIDADO'::text]))))
);

create table if not exists public.parametros_operacao (
  chave text not null,
  valor jsonb not null,
  descricao text,
  atualizado_em timestamp with time zone not null default now(),
  atualizado_por text,
  constraint parametros_operacao_pkey PRIMARY KEY (chave)
);

create table if not exists public.parcelas (
  id uuid not null default gen_random_uuid(),
  acordo_id uuid not null,
  numero integer not null default 1,
  valor numeric,
  vencimento date,
  status text not null default 'A_VENCER'::text,
  pago_em timestamp with time zone,
  confirmado_por_email text,
  observacao text,
  solicitacao_confirmacao_id uuid,
  criado_em timestamp with time zone not null default now(),
  atualizado_em timestamp with time zone not null default now(),
  honorarios numeric,
  forma_pagamento text,
  is_entrada boolean default false,
  boleto text,
  titulos_origem text,
  boleto_confiavel boolean not null default false,
  renegociada_em timestamp with time zone,
  renegociada_no_acordo_id uuid,
  origem_baixa text,
  origem_baixa_ref text,
  origem_baixa_em timestamp with time zone,
  constraint parcelas_origem_baixa_valida CHECK (((origem_baixa IS NULL) OR (origem_baixa = ANY (ARRAY['OPERADOR'::text, 'ADM'::text, 'GATILHO_IMPORTACAO'::text, 'BAIXA_RELATORIO'::text, 'IMPORTACAO_ACORDO'::text, 'AUTOMACAO'::text])))),
  constraint parcelas_pkey PRIMARY KEY (id)
);

create table if not exists public.reposicao_carteira_fila (
  id bigint not null default nextval('reposicao_carteira_fila_id_seq'::regclass),
  operador_email text not null,
  operador_nome text,
  operador_upper text,
  tipo text not null,
  caso_origem_id uuid,
  criado_em timestamp with time zone not null default now(),
  processado_em timestamp with time zone,
  repostos integer,
  erro text,
  constraint reposicao_carteira_fila_pkey PRIMARY KEY (id)
);

create table if not exists public.retorno_acordo_auto (
  id uuid not null default gen_random_uuid(),
  aluno_id uuid not null,
  proximo_vencimento date not null,
  data_retorno date,
  valor numeric,
  lote text,
  gerado_em timestamp with time zone not null default now(),
  constraint retorno_acordo_auto_aluno_id_proximo_vencimento_key UNIQUE (aluno_id, proximo_vencimento),
  constraint retorno_acordo_auto_pkey PRIMARY KEY (id)
);

create table if not exists public.solicitacoes_confirmacao_pagamento (
  id uuid not null default gen_random_uuid(),
  aluno_id text,
  aluno_nome text,
  aluno_cpf text,
  operador_email text,
  operador_nome text,
  valor_informado numeric,
  motivo text,
  status text not null default 'AGUARDANDO_CONFIRMACAO'::text,
  observacao_adm text,
  confirmado_por text,
  confirmado_em timestamp with time zone,
  criado_em timestamp with time zone not null default now(),
  atualizado_em timestamp with time zone not null default now(),
  acordo_id uuid,
  parcela_id uuid,
  forma_pagamento text,
  qtd_parcelas integer,
  valor_entrada numeric,
  entrada_paga boolean,
  titulo_id uuid,
  data_pagamento date,
  tipo_pagamento text,
  comprovante_link_id uuid,
  dados_vinculados_em timestamp with time zone,
  dados_vinculados_por_email text,
  principal_referencia numeric,
  juros numeric,
  multa numeric,
  honorarios numeric,
  total_negociado numeric,
  composicao_validada_em timestamp with time zone,
  composicao_validada_por_email text,
  pagamento_id uuid,
  origem_divida text,
  constraint solic_conf_pagto_origem_divida_chk CHECK (((origem_divida IS NULL) OR (origem_divida = ANY (ARRAY['ACORDO'::text, 'MENSALIDADE'::text, 'ACORDO_E_MENSALIDADE'::text, 'SEM_SALDO'::text])))),
  constraint solic_conf_pagto_tipo_chk CHECK (((tipo_pagamento IS NULL) OR (tipo_pagamento = ANY (ARRAY['PARCELA'::text, 'ENTRADA'::text, 'ACORDO'::text, 'MENSALIDADE'::text, 'QUITACAO_TOTAL'::text])))),
  constraint solicitacoes_confirmacao_pagamento_pkey PRIMARY KEY (id)
);

create table if not exists public.usuarios (
  id uuid not null default uuid_generate_v4(),
  nome text not null,
  email text not null,
  perfil text not null,
  ativo boolean default true,
  created_at timestamp without time zone default now(),
  operador_nome text,
  operador text,
  foto_url text,
  apelido text,
  aniversario date,
  receptivo boolean default false,
  pode_gerir_confirmacao_pagamento boolean not null default false,
  pode_alterar_responsavel boolean not null default false,
  deve_trocar_senha boolean default false,
  turno text not null default 'livre'::text,
  foto_path text,
  nome_exibicao text,
  recebe_novos_casos boolean not null default true,
  constraint usuarios_email_key UNIQUE (email),
  constraint usuarios_pkey PRIMARY KEY (id)
);

-- ========== CHAVES ESTRANGEIRAS -- separadas do CREATE TABLE apenas por ORDEM
-- DE CRIACAO (producao tem ciclos: acordos->alunos, parcelas->acordos,
-- baixas_pagamento->parcelas). NENHUMA constraint retirada: as 19 FKs cujo
-- alvo esta na fixture entram aqui, com o mesmo nome e a mesma definicao. ==========
alter table public.acordo_titulo_vinculo add constraint acordo_titulo_vinculo_acordo_id_fkey FOREIGN KEY (acordo_id) REFERENCES acordos(id) ON DELETE CASCADE;
alter table public.acordo_titulo_vinculo add constraint acordo_titulo_vinculo_titulo_id_fkey FOREIGN KEY (titulo_id) REFERENCES acordos_titulos(id) ON DELETE CASCADE;
alter table public.acordos add constraint acordos_aluno_id_fkey FOREIGN KEY (aluno_id) REFERENCES alunos(id);
alter table public.acordos add constraint acordos_duplicado_de_fkey FOREIGN KEY (duplicado_de) REFERENCES acordos(id) ON DELETE SET NULL;
alter table public.acordos_titulos add constraint acordos_titulos_acordo_id_fkey FOREIGN KEY (acordo_id) REFERENCES acordos(id);
alter table public.acordos_titulos add constraint acordos_titulos_aluno_id_fkey FOREIGN KEY (aluno_id) REFERENCES alunos(id);
alter table public.baixas_pagamento add constraint baixas_pagamento_acordo_id_fkey FOREIGN KEY (acordo_id) REFERENCES acordos(id);
alter table public.baixas_pagamento add constraint baixas_pagamento_parcela_id_fkey FOREIGN KEY (parcela_id) REFERENCES parcelas(id);
alter table public.casos add constraint casos_aluno_id_fkey FOREIGN KEY (aluno_id) REFERENCES alunos(id);
alter table public.elogios_atendimento add constraint elogios_atendimento_aluno_id_fkey FOREIGN KEY (aluno_id) REFERENCES alunos(id);
alter table public.elogios_atendimento add constraint elogios_atendimento_movimentacao_id_fkey FOREIGN KEY (movimentacao_id) REFERENCES aluno_movimentacoes(id);
alter table public.pagamentos add constraint pagamentos_aluno_id_fkey FOREIGN KEY (aluno_id) REFERENCES alunos(id);
alter table public.parcelas add constraint parcelas_acordo_id_fkey FOREIGN KEY (acordo_id) REFERENCES acordos(id) ON DELETE CASCADE;
alter table public.parcelas add constraint parcelas_renegociada_no_acordo_id_fkey FOREIGN KEY (renegociada_no_acordo_id) REFERENCES acordos(id);
alter table public.solicitacoes_confirmacao_pagamento add constraint solic_conf_pagto_comprovante_fk FOREIGN KEY (comprovante_link_id) REFERENCES links_pagamento(id) ON DELETE SET NULL;
alter table public.solicitacoes_confirmacao_pagamento add constraint solic_conf_pagto_titulo_fk FOREIGN KEY (titulo_id) REFERENCES acordos_titulos(id) ON DELETE SET NULL;
alter table public.solicitacoes_confirmacao_pagamento add constraint solicitacoes_confirmacao_pagamento_acordo_id_fkey FOREIGN KEY (acordo_id) REFERENCES acordos(id);
alter table public.solicitacoes_confirmacao_pagamento add constraint solicitacoes_confirmacao_pagamento_pagamento_id_fkey FOREIGN KEY (pagamento_id) REFERENCES pagamentos(id);
alter table public.solicitacoes_confirmacao_pagamento add constraint solicitacoes_confirmacao_pagamento_parcela_id_fkey FOREIGN KEY (parcela_id) REFERENCES parcelas(id);

-- ========== FUNCOES (37) -- TEXTO EXATO DE PRODUCAO ==========
CREATE OR REPLACE FUNCTION internal.carteira_geral_email()
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select 'carteira.geral@reativa.local'::text $function$;


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


CREATE OR REPLACE FUNCTION public.app_email()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select lower(coalesce((auth.jwt() ->> 'email'), ''));
$function$;


CREATE OR REPLACE FUNCTION public.caso_aguarda_confirmacao_financeira(p_aluno_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_aluno_id is not null
     and exists (select 1 from public.acordos_titulos t
                  where t.aluno_id = p_aluno_id
                    and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
     and coalesce((select sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
                     from public.acordos_titulos t
                    where t.aluno_id = p_aluno_id
                      and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                      and coalesce(lower(t.status),'') <> 'quitada'
                      and coalesce(t.tipo_boleto,'') <> 'Acordo'
                      and not exists (select 1 from public.acordo_titulo_vinculo v
                                        join public.acordos a on a.id = v.acordo_id
                                       where v.titulo_id = t.id and coalesce(v.ativo, true)
                                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))), 0) <= 0.005
     and not exists (select 1 from public.parcelas p
                       join public.acordos a on a.id = p.acordo_id
                      where a.aluno_id = p_aluno_id
                        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
                        and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO'));
$function$;


CREATE OR REPLACE FUNCTION public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_data_ultimo_acionamento is not null
     and p_data_ultimo_acionamento + 10 >= current_date;
$function$;


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
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
    and coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days') < now() - interval '1 day'
  order by c.data_ultimo_acionamento asc nulls first;
$function$;


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


CREATE OR REPLACE FUNCTION public.dia_util_anterior_ou_igual(p_dia date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case extract(isodow from p_dia)::int when 6 then p_dia - 1 when 7 then p_dia - 2 else p_dia end;
$function$;


CREATE OR REPLACE FUNCTION public.eh_tipo_acionamento(p_tipo text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(p_tipo,'') in (
    'FINALIZACAO_ATENDIMENTO','FINALIZACAO','ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL','CONTATO',
    'LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','COMPROVANTE_ENVIADO_BAIXA',
    'QUITADO_MANUAL','TERMO_ENVIADO_ADM','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO'
  );
$function$;


CREATE OR REPLACE FUNCTION public.fmt_brl(p numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select 'R$ ' || translate(to_char(round(coalesce(p,0),2),'FM999G999G999G990D00'), '.,', ',.');
$function$;


CREATE OR REPLACE FUNCTION public.nome_do_operador(p_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(nullif(btrim(u.operador_nome), ''), nullif(btrim(u.nome), ''))
  from public.usuarios u
  where lower(u.email) = lower(btrim(p_email))
  limit 1;
$function$;


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


CREATE OR REPLACE FUNCTION public.usuario_e_gestao_fila()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.usuario_e_gestao()
  OR EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE lower(u.email) = lower(coalesce(auth.jwt()->>'email',''))
      AND u.perfil IN ('gerencia','supervisor','administrativo')
  );
$function$;


CREATE OR REPLACE FUNCTION internal.set_resp_aluno(p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ant_email text; v_ant_nome text; v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select responsavel_atual_email, responsavel_atual_nome into v_ant_email, v_ant_nome from public.alunos where id=p_aluno_id;
  update public.alunos set
    responsavel_atual_email=v_email,
    responsavel_atual_nome=p_novo_nome,
    responsavel_atual_em=now(),
    data_ultimo_acionamento = case when v_ant_email is distinct from v_email then null else data_ultimo_acionamento end,
    status_acionamento      = case when v_ant_email is distinct from v_email then null else status_acionamento end,
    proxima_acao            = case when v_ant_email is distinct from v_email then null else proxima_acao end,
    data_retorno            = case when v_ant_email is distinct from v_email then null else data_retorno end,
    hora_retorno            = case when v_ant_email is distinct from v_email then null else hora_retorno end
  where id=p_aluno_id;
  insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,operador_anterior_nome,operador_anterior_email,operador_novo_nome,operador_novo_email,registrado_por_nome,registrado_por_email,registrado_em)
  values (p_aluno_id::text, p_tipo, p_descricao, coalesce(v_ant_nome,'(sem)'), v_ant_email, p_novo_nome, v_email, coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end;$function$;


CREATE OR REPLACE FUNCTION public._caso_nao_duplica_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_outro_id     uuid;
  v_outro_codigo integer;
  v_nome         text;
begin
  if new.aluno_id is null then return new; end if;
  if coalesce(new.encerrado_operacional, false) then return new; end if;
  if public.caso_encerrado_operacional(new.cpf, new.status_atual, new.status_acionamento,
                                       new.status_financeiro, new.status_jornada) then
    return new;
  end if;

  select c.id, c.caso_codigo into v_outro_id, v_outro_codigo
    from public.casos c
   where c.aluno_id = new.aluno_id
     and c.id <> new.id
     and not coalesce(c.encerrado_operacional, false)
     and public.caso_encerrado_operacional(c.cpf, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada) = false
   limit 1;

  if v_outro_id is null then return new; end if;

  select coalesce(nullif(btrim(a.nome), ''), '(sem nome)') into v_nome
    from public.alunos a where a.id = new.aluno_id;

  -- REABERTURA: a ficha ja estava encerrada e alguem (importacao, rotina) esta
  -- acordando ela enquanto o aluno tem outra ficha aberta. Nao derruba o lote:
  -- mantem encerrada e registra. So vale no gatilho BEFORE, onde ainda da para
  -- mudar a linha; o AFTER, ao ver encerrado_operacional = true, sai na 1a linha.
  if tg_op = 'UPDATE'
     and coalesce(old.encerrado_operacional, false)
     and tg_when = 'BEFORE' then
    new.encerrado_operacional := true;

    insert into public.ficha_reabertura_barrada
      (caso_id, caso_codigo, aluno_id, outro_caso_id, outro_codigo, nome)
    values (new.id, new.caso_codigo, new.aluno_id, v_outro_id, v_outro_codigo, v_nome);

    return new;
  end if;

  -- FICHA NOVA duplicada: continua sendo erro, e alto.
  raise exception
    'ALUNO_JA_TEM_CASO_ABERTO: % ja esta na fila no caso %. A ficha do aluno e unica -- um CPF, uma ficha. Abra o caso existente e trabalhe nele; se sao dois cursos, isso e um campo na ficha, nao uma segunda ficha.',
    coalesce(v_nome, new.aluno_id::text),
    coalesce(v_outro_codigo::text, left(v_outro_id::text, 8));
end;
$function$;


CREATE OR REPLACE FUNCTION public._nome_do_operador_no_caso()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_nome text;
begin
  if new.operador_email is not null then
    v_nome := public.nome_do_operador(new.operador_email);
    if v_nome is not null then
      new.operador_nome := v_nome;
      new.operador := v_nome;
    end if;
  end if;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public._trg_desfazer_cartao_tabulacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aluno uuid;
  v_estado jsonb;
  v_nome text;
begin
  if new.tipo <> 'FINALIZACAO_ATENDIMENTO' then
    return null;
  end if;
  if public.app_email() = '' then
    return null;
  end if;

  begin
    v_aluno := new.aluno_id::uuid;
  exception when others then
    return null;
  end;

  if exists (
    select 1 from public.acoes_desfazer
     where aluno_id = v_aluno and criado_em = now() and tipo <> 'TABULACAO'
  ) then
    return null;
  end if;

  select ea.estado into v_estado
    from public.alunos_estado_anterior ea
   where ea.aluno_id = v_aluno
     and ea.estado->>'status_atual' is not distinct from new.status_anterior
   order by ea.id desc
   limit 1;

  if v_estado is null then
    select ea.estado into v_estado
      from public.alunos_estado_anterior ea
     where ea.aluno_id = v_aluno
     order by ea.id desc
     limit 1;
  end if;

  if v_estado is null then
    v_estado := jsonb_build_object(
      'status_jornada',     new.status_anterior,
      'status_atual',       new.status_anterior,
      'status_acionamento', new.status_anterior
    );
  end if;

  select coalesce(nome_aluno, nome) into v_nome from public.alunos where id = v_aluno;

  insert into public.acoes_desfazer
    (tipo, aluno_id, aluno_nome, movimentacao_id, operador_email, operador_nome,
     rotulo, estado_anterior)
  values
    ('TABULACAO', v_aluno, v_nome, new.id,
     lower(coalesce(new.registrado_por_email, public.app_email())), new.registrado_por_nome,
     'Atendimento tabulado como "' || coalesce(new.status_novo, '-') || '"', v_estado);

  return null;
exception when others then
  return null;
end;
$function$;


CREATE OR REPLACE FUNCTION public.bloquear_alteracoes_restritas_casos()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if public.crm_usuario_acesso_restrito_amanda() then
    return new;
  end if;

  if new.valor_cobranca_ajustado is distinct from old.valor_cobranca_ajustado
    or new.motivo_ajuste_valor is distinct from old.motivo_ajuste_valor
    or new.valor_ajustado_por is distinct from old.valor_ajustado_por
    or new.valor_ajustado_em is distinct from old.valor_ajustado_em
    or new.cadastro_caso_observacao is distinct from old.cadastro_caso_observacao
    or new.caso_atualizado_por is distinct from old.caso_atualizado_por
    or new.caso_atualizado_em is distinct from old.caso_atualizado_em
    or new.status_financeiro is distinct from old.status_financeiro
    or new.origem_quitacao is distinct from old.origem_quitacao
    or new.quitado_em is distinct from old.quitado_em
    or new.valor_quitado is distinct from old.valor_quitado
    or new.baixa_importada_id is distinct from old.baixa_importada_id
    or new.observacao_financeira is distinct from old.observacao_financeira
  then
    raise exception 'Ação permitida somente para Amanda gestora.';
  end if;

  return new;
end;
$function$;


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

  -- Caso cujo unico saldo esta em titulo aguardando a Conferencia Prime: nao
  -- ocupa vaga (teto, reposicao, nivelamento), nao e redistribuido e nao e
  -- solto pela fidelizacao -- o responsavel fica para quando houver decisao.
  -- (o aluno e achado pelo CPF normalizado da ficha -- indice
  -- idx_alunos_cpf_normalizado; o CPF gravado no titulo pode divergir)
  if v_cpf <> '00000000000' and v_cpf <> '' and exists (
       select 1 from public.alunos al
        where lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0') = v_cpf
          and exists (select 1 from public.acordos_titulos t
                       where t.aluno_id = al.id
                         and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
          and public.caso_aguarda_confirmacao_financeira(al.id)) then
    return true;
  end if;

  -- CONFIRMACAO FINANCEIRA ABERTA (solicitacoes_confirmacao_pagamento), pelo
  -- aluno_id da solicitacao -- NAO por solicitacoes.aluno_cpf, que e nulo em
  -- 345 das 351 abertas. Os dois estados abertos protegem. Sem nome, sem
  -- aproximacao: aluno pelo CPF normalizado da ficha (mesma chave do bloco acima),
  -- solicitacao por aluno_id (texto, indexado).
  if v_cpf <> '00000000000' and v_cpf <> '' and exists (
       select 1 from public.alunos al
        where lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0') = v_cpf
          and exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                       where s.aluno_id = al.id::text
                         and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))) then
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


CREATE OR REPLACE FUNCTION public.crm_usuario_acesso_restrito_amanda()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  email_logado text;
begin
  -- roles internas/administrativas: decidir sem depender do schema auth
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return true;
  end if;

  if current_user = 'reativa_responsavel_executor' then
    -- role interna das RPCs de responsável: NÃO é acesso irrestrito;
    -- mantém a proteção de colunas sensíveis (que passa nas mudanças operacionais).
    return false;
  end if;

  -- usuários normais (authenticated): comportamento original inalterado
  email_logado := lower(coalesce(auth.jwt() ->> 'email', ''));

  return email_logado in (
    'amanda.seibel@aelbra.com.br'
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.fechar_confirmacao_ao_quitar_caso()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.aluno_id is null then return new; end if;
  if new.status_atual ilike 'quit%' or new.status_atual ilike '%QUITADO%'
     or new.quitado_em is not null or coalesce(new.origem_quitacao,'')<>''
     or new.status_financeiro ilike 'QUIT%' or coalesce(new.valor_quitado,0)>0 then
    update public.solicitacoes_confirmacao_pagamento s
    set status='PAGAMENTO_CONFIRMADO',
        observacao_adm=coalesce(nullif(trim(s.observacao_adm),''),'Confirmado automaticamente (caso quitado/baixado)'),
        confirmado_em=coalesce(s.confirmado_em, now()), atualizado_em=now()
    where s.aluno_id = new.aluno_id::text and s.status='AGUARDANDO_CONFIRMACAO';
    -- (removido) NAO marcar todos os titulos como PAGO; so o que for pago de fato.
  end if;
  return new;
end;$function$;


CREATE OR REPLACE FUNCTION public.fn_atualizar_ultimo_acionamento()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  -- Acao massiva confirmada e ATIVIDADE (fica registrada e visivel), mas NAO e
  -- contato operacional: nao renova fidelizacao, nao mexe no nivelamento nem na
  -- liberacao. A cobertura le a movimentacao diretamente.
  if new.tipo in ('ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL') then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = new.registrado_em::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < new.registrado_em::date);

  -- recalcular situacao/criticidade apos o acionamento (dias_sem_acionamento zera).
  -- protegido: falha aqui nunca impede o registro do acionamento.
  begin
    perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
  exception when others then
    null;
  end;

  return new;
exception when others then
  -- nunca impedir o registro do acionamento por falha na atualizacao da ficha
  return new;
end;
$function$;


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
$function$;


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
$function$;


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
  v_tit_conf int := 0;
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
  -- 19/09: encerramento administrativo pela Conferencia Prime (CANCELAMENTO_ESTORNO /
  -- ISENCAO_FIES_BOLSA) sem evento financeiro posterior que represente quitacao real
  v_enc_admin boolean := false; v_enc_em timestamptz;
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

  -- titulos aguardando a Conferencia Prime (fora do saldo, mas nao quitados)
  select count(*) into v_tit_conf
  from public.acordos_titulos t
  where t.aluno_id=p_aluno_id and upper(coalesce(t.situacao,''))='EM_CONFIRMACAO';

  select coalesce((c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')), false)
  into v_termo_pend from public.casos c where c.aluno_id=p_aluno_id limit 1;
  v_termo_pend := coalesce(v_termo_pend,false);

  select coalesce((al.status_baixa_pagamento is not null and al.status_baixa_pagamento <> 'BAIXA_REALIZADA'), false)
  into v_baixa_pend from public.alunos al where al.id=p_aluno_id;
  v_baixa_pend := coalesce(v_baixa_pend,false);

  v_saldo_vencido := round(v_parc_venc_val + v_tit_venc_val, 2);
  v_saldo_total   := round(v_parc_venc_val + v_parc_fut_val + v_tit_val, 2);

  -- Regra restrita (19/09): so alunos com titulo encerrado administrativamente
  -- pela Conferencia Prime. "Sem saldo" por esse motivo NAO e quitacao: fica
  -- SEM_PENDENCIA enquanto nao houver evento financeiro POSTERIOR ao
  -- encerramento (caso quitado, titulo pago, acordo quitado ou pagamento).
  select max(t.origem_encerramento_em) into v_enc_em
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id and t.origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA';
  if v_enc_em is not null then
     v_enc_admin := not (
          exists (select 1 from public.casos c where c.aluno_id = p_aluno_id and c.quitado_em is not null)
       or exists (select 1 from public.acordos_titulos t where t.aluno_id = p_aluno_id
                    and upper(coalesce(t.situacao,'')) = 'PAGO' and coalesce(t.atualizado_em, t.created_at) >= v_enc_em)
       or exists (select 1 from public.acordos a where a.aluno_id = p_aluno_id
                    and upper(coalesce(a.status,'')) = 'QUITADO' and a.criado_em >= v_enc_em)
       or exists (select 1 from public.pagamentos p where p.aluno_id = p_aluno_id and p.data_pagamento >= v_enc_em::date));
  end if;

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

  if v_saldo_total <= 0.005 and v_conf_pend = 0 and v_tit_conf > 0 then
     -- So resta titulo aguardando a Conferencia Prime: nao e quitacao.
     v_situacao := 'AGUARDANDO_CONFIRMACAO';
     v_nivel    := 'NORMAL';
     v_proxima  := 'Próxima ação: aguardar a decisão da Conferência Prime sobre a liquidação do título.';
     v_retorno  := null; v_origem := null;
  elsif v_saldo_total <= 0.005 and v_conf_pend = 0 then
     v_nivel := 'NORMAL';
     if v_baixa_pend then
        v_situacao := 'QUITADO_AGUARDANDO_BAIXA';
        v_proxima  := 'Próxima ação: concluir a baixa e finalizar o caso.';
     elsif v_enc_admin then
        -- sem saldo por encerramento administrativo: nao houve quitacao
        v_situacao := 'SEM_PENDENCIA';
        v_proxima  := null;
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
    'tem_acordo',coalesce(v_tem_acordo,false),
    'titulos_em_confirmacao',v_tit_conf,'encerramento_administrativo',v_enc_admin);
end; $function$;


CREATE OR REPLACE FUNCTION public.sincronizar_elogio_da_movimentacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_aluno uuid;
  v_obs   text;
BEGIN
  IF coalesce(NEW.status_novo, '') <> 'ELOGIO_ATENDIMENTO' THEN
    RETURN NEW;
  END IF;
  BEGIN
    v_aluno := NULLIF(btrim(NEW.aluno_id::text), '')::uuid;
  EXCEPTION WHEN others THEN
    v_aluno := NULL;
  END;
  v_obs := NULLIF(btrim(coalesce(NEW.descricao, '')), '');
  IF v_obs IS NOT NULL AND (v_obs ILIKE 'Atendimento finalizado com status:%' OR v_obs ILIKE 'Atendimento finalizado como %') THEN
    v_obs := NULL;
  END IF;
  INSERT INTO public.elogios_atendimento (
    aluno_id, movimentacao_id, operador_email, operador_nome,
    print_path, print_nome_arquivo, observacao_operador, status,
    registrado_por_email, registrado_por_nome, registrado_em
  ) VALUES (
    v_aluno, NEW.id, lower(btrim(NEW.registrado_por_email)),
    coalesce(NULLIF(btrim(NEW.registrado_por_nome), ''), NEW.registrado_por_email),
    NULLIF(btrim(coalesce(NEW.elogio_print_path, '')), ''), NEW.elogio_print_nome, v_obs, 'PENDENTE_ANALISE',
    lower(btrim(NEW.registrado_por_email)), NEW.registrado_por_nome, NEW.registrado_em
  )
  ON CONFLICT (movimentacao_id) DO UPDATE
    SET print_path         = coalesce(public.elogios_atendimento.print_path, excluded.print_path),
        print_nome_arquivo = coalesce(public.elogios_atendimento.print_nome_arquivo, excluded.print_nome_arquivo);
  IF TG_OP = 'UPDATE' AND NEW.elogio_rejeitado_tv IS TRUE AND coalesce(OLD.elogio_rejeitado_tv, false) IS FALSE THEN
    UPDATE public.elogios_atendimento e
       SET status = 'REJEITADO_TV',
           motivo_rejeicao = coalesce(NULLIF(btrim(e.motivo_rejeicao), ''), 'Rejeitado na analise do CRM'),
           analisado_por_email = NEW.elogio_rejeitado_por,
           analisado_em = coalesce(NEW.elogio_rejeitado_em, now()),
           atualizado_em = now()
     WHERE e.movimentacao_id = NEW.id AND e.status = 'PENDENTE_ANALISE';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.elogio_aprovado_tv IS TRUE AND coalesce(OLD.elogio_aprovado_tv, false) IS FALSE THEN
    UPDATE public.elogios_atendimento e
       SET status = 'APROVADO_TV',
           analisado_por_email = NEW.elogio_aprovado_por,
           analisado_em = coalesce(NEW.elogio_aprovado_em, now()),
           exibir_de = coalesce(e.exibir_de, (now() AT TIME ZONE 'America/Sao_Paulo')::date),
           atualizado_em = now()
     WHERE e.movimentacao_id = NEW.id AND e.status = 'PENDENTE_ANALISE'
       AND NULLIF(btrim(coalesce(e.texto_final_tv, '')), '') IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.tipo_fechamento_caso(p_cpf_limpo text, p_status_acionamento text, p_status_financeiro text, p_quitado_em date, p_valor_quitado numeric)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status_norm text := public.normalizar_status_acionamento(p_status_acionamento);
  v_status_fin_norm text := public.normalizar_status_acionamento(p_status_financeiro);
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf_limpo,''), '\D', '', 'g'), 11, '0');
BEGIN
  IF v_status_norm = 'QUITADO'
     OR v_status_fin_norm IN ('PAGO', 'QUITADO')
     OR p_quitado_em IS NOT NULL
     OR coalesce(p_valor_quitado, 0) > 0
  THEN
    RETURN 'QUITADO';
  END IF;

  IF v_cpf <> '' AND v_cpf <> '00000000000'
     AND EXISTS (SELECT 1 FROM public.acordos a WHERE a.cpf = v_cpf AND a.status = 'QUITADO')
  THEN
    RETURN 'QUITADO';
  END IF;

  RETURN 'OUTRO'; -- acordo parcelado ativo, negociação, proposta, termo etc.
END;
$function$;


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


CREATE OR REPLACE FUNCTION public.trg_repor_caso_operador()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := NEW.operador_email;
  v_nome  text := NEW.operador_nome;
  v_tipo  text;
begin
  if v_email is null then
    return NEW;
  end if;

  if not exists (select 1 from public.usuarios u where u.email = v_email and u.perfil = 'operador' and u.ativo = true) then
    return NEW;
  end if;

  if public.caso_protegido_redistribuicao(OLD.cpf_limpo, OLD.status_acionamento, OLD.nao_acionar, OLD.status_financeiro, OLD.valor_pago, OLD.quitado_em, OLD.valor_quitado) then
    return NEW;
  end if;

  if not public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) then
    return NEW;
  end if;

  v_tipo := public.tipo_fechamento_caso(NEW.cpf_limpo, NEW.status_acionamento, NEW.status_financeiro, NEW.quitado_em, NEW.valor_quitado);

  update public.casos
     set operador_email = null, operador_nome = null, operador = null
   where id = NEW.id;

  insert into public.historico_operadores_alunos (
    chave_unificacao, nome_aluno, cpf_referencia, acao,
    operador_anterior_nome, operador_anterior_email, observacao, criado_em
  ) values (
    NEW.chave_unificacao, NEW.nome, NEW.cpf, 'LIBERACAO_AUTOMATICA_CASO_FECHADO',
    v_nome, v_email,
    'Caso fechado (' || v_tipo || ', status: ' || coalesce(NEW.status_acionamento,'-') || ') -- liberado automaticamente', now()
  );

  insert into public.reposicao_carteira_fila (operador_email, operador_nome, operador_upper, tipo, caso_origem_id)
  values (v_email, v_nome, NEW.operador, v_tipo, NEW.id);

  return NEW;
end;
$function$;


CREATE OR REPLACE FUNCTION public.trg_sincronizar_alunos_apos_casos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
DECLARE
  v_nome text;
  mapa_nomes jsonb := '{
    "cobranca03@aelbra.com.br": "OLGA", "cobranca04@aelbra.com.br": "FERNANDA",
    "cobranca05@aelbra.com.br": "LUANA", "cobranca06@aelbra.com.br": "MAURICIO",
    "cobranca07@aelbra.com.br": "AMANDA ADM", "cobranca08@aelbra.com.br": "NATALI",
    "cobranca10@aelbra.com.br": "JOÃO", "cobranca11@aelbra.com.br": "ALLAN",
    "cobranca12@aelbra.com.br": "RAFAELLA", "cobranca13@aelbra.com.br": "DIEGO",
    "amanda.seibel@aelbra.com.br": "AMANDA GESTORA"
  }'::jsonb;
BEGIN
  IF NEW.aluno_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.operador_email IS DISTINCT FROM OLD.operador_email THEN
    v_nome := CASE WHEN NEW.operador_email IS NULL THEN NULL
                   ELSE COALESCE(mapa_nomes ->> lower(NEW.operador_email), NEW.operador_nome) END;
    PERFORM internal.set_resp_aluno(NEW.aluno_id, NEW.operador_email, v_nome,
      'REDISTRIBUICAO_SINCRONIZACAO', 'Sincronizacao automatica em tempo real (gatilho).',
      'sistema@reativaone', 'Sistema');
  END IF;
  RETURN NEW;
END;
$function$;


-- ========== INDICES de casos, alunos e aluno_movimentacoes (33 de 36) ==========
-- TRES OMITIDOS, com justificativa: ix_alunos_wa_chave_telefone,
-- ix_alunos_wa_chave_resp1 e ix_alunos_wa_chave_resp2 sao indices funcionais
-- sobre whatsapp_chave_telefone(text), funcao fora do fechamento desta
-- migration. Nenhum predicado sob teste toca telefone.
CREATE INDEX idx_aluno_mov_reg_por ON public.aluno_movimentacoes USING btree (registrado_por_email, registrado_em);
CREATE INDEX idx_aluno_mov_registrado_em ON public.aluno_movimentacoes USING btree (registrado_em);
CREATE INDEX idx_aluno_movimentacoes_aluno_id ON public.aluno_movimentacoes USING btree (aluno_id);
CREATE INDEX idx_alunos_cpf ON public.alunos USING btree (cpf);
CREATE INDEX idx_alunos_cpf_normalizado ON public.alunos USING btree (lpad(regexp_replace(COALESCE(cpf, ''::text), '\D'::text, ''::text, 'g'::text), 11, '0'::text));
CREATE INDEX idx_alunos_cpf_trgm ON public.alunos USING gin (cpf gin_trgm_ops);
CREATE INDEX idx_alunos_curso ON public.alunos USING btree (curso);
CREATE INDEX idx_alunos_data_retorno ON public.alunos USING btree (data_retorno);
CREATE INDEX idx_alunos_data_ultimo_acionamento ON public.alunos USING btree (data_ultimo_acionamento);
CREATE INDEX idx_alunos_minha_fila ON public.alunos USING btree (responsavel_atual_email, data_ultimo_acionamento);
CREATE INDEX idx_alunos_nivel_criticidade ON public.alunos USING btree (nivel_criticidade);
CREATE INDEX idx_alunos_nome ON public.alunos USING btree (nome);
CREATE INDEX idx_alunos_nome_norm_trgm ON public.alunos USING gin (nome_normalizado gin_trgm_ops);
CREATE INDEX idx_alunos_processo_prazo_tipo ON public.alunos USING btree (processo_prazo_tipo);
CREATE INDEX idx_alunos_responsavel_atual_email ON public.alunos USING btree (responsavel_atual_email);
CREATE INDEX idx_alunos_semestre_divida ON public.alunos USING btree (semestre_divida) WHERE (semestre_divida IS NOT NULL);
CREATE INDEX idx_alunos_situacao_academica ON public.alunos USING btree (situacao_academica);
CREATE INDEX idx_alunos_status_jornada ON public.alunos USING btree (status_jornada);
CREATE INDEX idx_alunos_unidade ON public.alunos USING btree (unidade);
CREATE INDEX idx_casos_aluno_id ON public.casos USING btree (aluno_id);
CREATE INDEX idx_casos_baixa_importada_id ON public.casos USING btree (baixa_importada_id);
CREATE INDEX idx_casos_chave_unificacao ON public.casos USING btree (chave_unificacao);
CREATE INDEX idx_casos_cpf_corrigido ON public.casos USING btree (cpf_corrigido);
CREATE INDEX idx_casos_cpf_normalizado ON public.casos USING btree (lpad(regexp_replace(COALESCE(cpf_limpo, ''::text), '\D'::text, ''::text, 'g'::text), 11, '0'::text));
CREATE INDEX idx_casos_nome_referencia ON public.casos USING btree (nome_referencia);
CREATE INDEX idx_casos_operador_email ON public.casos USING btree (operador_email);
CREATE INDEX idx_casos_operador_mensalidade ON public.casos USING btree (operador_mensalidade_email) WHERE (operador_mensalidade_email IS NOT NULL);
CREATE INDEX idx_casos_status_financeiro ON public.casos USING btree (status_financeiro);
CREATE INDEX idx_casos_valor_ajustado ON public.casos USING btree (valor_cobranca_ajustado);
CREATE INDEX ix_aluno_mov_lote ON public.aluno_movimentacoes USING btree (lote_id) WHERE (lote_id IS NOT NULL);
CREATE INDEX ix_aluno_mov_tipo_data ON public.aluno_movimentacoes USING btree (tipo, registrado_em);
CREATE INDEX ix_alunos_nome_normalizado ON public.alunos USING btree (translate(upper(regexp_replace(TRIM(BOTH FROM nome), '\s+'::text, ' '::text, 'g'::text)), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ'::text, 'AAAAAEEEEIIIIOOOOOUUUUC'::text));
CREATE INDEX ix_casos_operador_ativo ON public.casos USING btree (operador_email) WHERE (encerrado_operacional = false);

-- ========== GATILHOS de INSERT/UPDATE (12) ==========
CREATE TRIGGER trg_atualizar_ultimo_acionamento AFTER INSERT ON public.aluno_movimentacoes FOR EACH ROW EXECUTE FUNCTION fn_atualizar_ultimo_acionamento();
CREATE TRIGGER trg_sincronizar_elogio_da_movimentacao AFTER INSERT OR UPDATE OF elogio_print_path, elogio_aprovado_tv, elogio_rejeitado_tv ON public.aluno_movimentacoes FOR EACH ROW EXECUTE FUNCTION sincronizar_elogio_da_movimentacao();
CREATE TRIGGER trg_zz_desfazer_cartao_tabulacao AFTER INSERT ON public.aluno_movimentacoes FOR EACH ROW EXECUTE FUNCTION _trg_desfazer_cartao_tabulacao();
CREATE TRIGGER trg_bloquear_alteracoes_restritas_casos BEFORE UPDATE ON public.casos FOR EACH ROW EXECUTE FUNCTION bloquear_alteracoes_restritas_casos();
CREATE TRIGGER trg_casos_set_encerrado_operacional BEFORE INSERT OR UPDATE ON public.casos FOR EACH ROW EXECUTE FUNCTION casos_set_encerrado_operacional();
CREATE TRIGGER trg_fechar_confirmacao_ao_quitar_caso AFTER UPDATE OF status_atual, quitado_em, origem_quitacao ON public.casos FOR EACH ROW EXECUTE FUNCTION fechar_confirmacao_ao_quitar_caso();
CREATE TRIGGER trg_nome_do_operador_no_caso BEFORE INSERT OR UPDATE OF operador_email, operador_nome, operador ON public.casos FOR EACH ROW EXECUTE FUNCTION _nome_do_operador_no_caso();
CREATE TRIGGER trg_sync_alunos_apos_casos AFTER UPDATE ON public.casos FOR EACH ROW WHEN ((new.operador_email IS DISTINCT FROM old.operador_email)) EXECUTE FUNCTION trg_sincronizar_alunos_apos_casos();
CREATE CONSTRAINT TRIGGER trg_zz_caso_nao_duplica_aluno AFTER INSERT OR UPDATE ON public.casos DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION _caso_nao_duplica_aluno();
CREATE TRIGGER trg_zz_caso_nao_duplica_aluno_before BEFORE INSERT OR UPDATE ON public.casos FOR EACH ROW EXECUTE FUNCTION _caso_nao_duplica_aluno();
CREATE TRIGGER trigger_impor_teto_operador AFTER UPDATE ON public.casos FOR EACH ROW WHEN (((new.operador_email IS NOT NULL) AND (new.operador_email IS DISTINCT FROM old.operador_email))) EXECUTE FUNCTION trg_impor_teto_operador();
CREATE TRIGGER trigger_repor_caso_operador AFTER UPDATE ON public.casos FOR EACH ROW WHEN (((new.operador_email IS NOT NULL) AND (new.operador_email = old.operador_email))) EXECUTE FUNCTION trg_repor_caso_operador();
