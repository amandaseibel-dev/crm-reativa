-- Fixture confirmacao_d2 (21/09/2026): DDL de producao + funcoes com texto EXATO de pg_get_functiondef.
-- Unicos stubs: auth.*, sistema_sob_carga. Dados 100% ficticios sao inseridos pelo teste.

create schema if not exists auth;
create schema if not exists internal;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('test.jwt', true), '')::jsonb $$;
create or replace function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt()->>'role','') $$;
create or replace function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub','')::uuid $$;
create or replace function public.sistema_sob_carga() returns jsonb language sql stable as $$ select jsonb_build_object('sob_carga', false) $$;

set check_function_bodies = off;
create table public.alunos (
  "id" uuid default gen_random_uuid() primary key,
  "cpf" text,
  "cpf_mascarado" text,
  "matricula" text,
  "nome" text,
  "email" text,
  "telefone" text,
  "curso" text,
  "unidade" text,
  "semestre" text,
  "situacao_academica" text,
  "status_jornada" text default 'Em cobrança'::text,
  "origem" text,
  "aluno_novo" boolean default false,
  "sem_telefone" boolean default false,
  "sem_email" boolean default false,
  "created_at" timestamp without time zone default now(),
  "updated_at" timestamp without time zone default now(),
  "nome_normalizado" text,
  "operador" text,
  "status_atual" text,
  "ultimo_contato" date,
  "data_retorno" date,
  "valor_em_aberto" numeric(12,2) default 0,
  "hora_retorno" text,
  "atualizado_em" timestamp with time zone default now(),
  "operador_nome" text,
  "operador_email" text,
  "observacao" text,
  "tipo_base" text,
  "nome_aluno" text,
  "nome_referencia" text,
  "cpf_corrigido" text,
  "cpf_status_correcao" text,
  "registro_unico" uuid default gen_random_uuid(),
  "chave_unificacao" text,
  "unificacao_status" text,
  "registrado_por_nome" text,
  "registrado_por_email" text,
  "registrado_em" timestamp with time zone,
  "responsavel_atual_nome" text,
  "responsavel_atual_email" text,
  "responsavel_atual_em" timestamp with time zone,
  "status_acionamento" text,
  "proxima_acao" text,
  "data_ultimo_acionamento" timestamp with time zone,
  "status_link_pagamento" text,
  "status_baixa_pagamento" text,
  "fila_destino" text,
  "ultimo_link_pagamento_id" uuid,
  "ultima_baixa_pagamento_id" uuid,
  "nivel_criticidade" text,
  "processo_numero" text,
  "processo_prazo_tipo" text,
  "processo_prazo_data" date,
  "nome_resp1" text,
  "telefone_resp1" text,
  "nome_resp2" text,
  "telefone_resp2" text,
  "situacao_operacional" text,
  "saldo_vencido" numeric,
  "saldo_total" numeric,
  "curso_real" text,
  "academico_codigo" text,
  "academico_fonte" text,
  "academico_atualizado_em" timestamp with time zone,
  "retorno_confirmado_em" timestamp with time zone,
  "retorno_origem" text,
  "semestre_divida" text,
  "semestre_divida_em" timestamp with time zone
);

create table public.casos (
  "id" uuid default gen_random_uuid() primary key,
  "caso_codigo" integer,
  "cpf_original" text,
  "cpf_limpo" text,
  "cpf_mascarado" text,
  "matricula" text,
  "nome" text,
  "nome_normalizado" text,
  "operador_base" text,
  "operador_mensalidade" text,
  "operador_acordo" text,
  "operador_acordo_planilha" text,
  "status_atual" text,
  "data_ultimo_acionamento" date,
  "status_acionamento" text,
  "criticidade" text,
  "proxima_acao_automatica" text,
  "total_em_aberto" numeric,
  "data_retorno" date,
  "dias_atraso" integer,
  "nivel_carteira" text,
  "sla_operacional" text,
  "urgencia" text,
  "observacoes" text,
  "mensalidades_em_aberto" numeric,
  "acordo_em_aberto" numeric,
  "parcela_a_vencer" numeric,
  "parcelas_vencidas" numeric,
  "proximo_vencimento" date,
  "valor_pago" numeric,
  "honorario" numeric,
  "data_pagamento" date,
  "status_financeiro" text,
  "observacao_financeira" text,
  "created_at" timestamp without time zone default now(),
  "data_retorno_nova" date,
  "ultima_tabulacao_em" timestamp without time zone,
  "fila_responsavel" text,
  "hora_retorno" time without time zone,
  "observacao_operacional" text,
  "status_termo" text default 'Sem termo'::text,
  "termo_status_validacao" text,
  "termo_url" text,
  "termo_nome_arquivo" text,
  "termo_observacao" text,
  "termo_motivo_rejeicao" text,
  "termo_enviado_por" text,
  "termo_validado_por" text,
  "termo_validado_em" timestamp with time zone,
  "nome_aluno" text,
  "cpf" text,
  "status_jornada" text,
  "operador" text,
  "observacao" text,
  "aluno" text,
  "nome_completo" text,
  "email" text,
  "telefone" text,
  "curso" text,
  "unidade" text,
  "semestre" text,
  "ultimo_acionamento" date,
  "valor_em_aberto" numeric,
  "valor_aberto" numeric,
  "valor_total" numeric,
  "valor_divida" numeric,
  "saldo_devedor" numeric,
  "valor" numeric,
  "origem" text,
  "operador_nome" text,
  "operador_email" text,
  "nome_referencia" text,
  "cpf_corrigido" text,
  "cpf_status_correcao" text,
  "registro_unico" uuid default gen_random_uuid(),
  "chave_unificacao" text,
  "unificacao_status" text,
  "origem_quitacao" text,
  "quitado_em" date,
  "valor_quitado" numeric default 0,
  "baixa_importada_id" uuid,
  "valor_cobranca_ajustado" numeric,
  "motivo_ajuste_valor" text,
  "valor_ajustado_por" text,
  "valor_ajustado_em" timestamp with time zone,
  "cadastro_caso_observacao" text,
  "caso_atualizado_por" text,
  "caso_atualizado_em" timestamp with time zone,
  "nao_acionar" boolean default false,
  "aluno_id" uuid,
  "nivelamento_marcador" text,
  "nivelamento_em" timestamp with time zone,
  "nivelamento_simulacao_id" uuid,
  "situacao_operacional" text,
  "saldo_vencido" numeric,
  "saldo_total" numeric,
  "encerrado_operacional" boolean default false,
  "operador_mensalidade_email" text,
  "operador_mensalidade_nome" text,
  "mensalidade_girada_em" timestamp with time zone
);

create table public.acordos (
  "id" uuid default gen_random_uuid() primary key,
  "aluno_id" uuid,
  "cpf" text,
  "tipo" text default 'ACORDO'::text,
  "forma_pagamento" text default 'PARCELADO'::text,
  "valor_total" numeric,
  "qtd_parcelas" integer default 1,
  "valor_entrada" numeric,
  "entrada_paga" boolean default false,
  "data_entrada" date,
  "status" text default 'ATIVO'::text,
  "observacao" text,
  "criado_por_nome" text,
  "criado_por_email" text,
  "confirmado_por_email" text,
  "confirmado_em" timestamp with time zone,
  "criado_em" timestamp with time zone default now(),
  "atualizado_em" timestamp with time zone default now(),
  "numero_acordo" bigint generated by default as identity,
  "operador_responsavel_email" text,
  "unidade" text,
  "entrada_percentual" numeric,
  "honorarios_percentual" numeric,
  "honorarios_valor" numeric,
  "saldo" numeric,
  "motivo_ajuste" text,
  "operador_responsavel_nome" text,
  "duplicado_de" uuid,
  "duplicado_marcado_em" timestamp with time zone,
  "numero_ulbra" text
);

create table public.acordos_titulos (
  "id" uuid default gen_random_uuid() primary key,
  "aluno_id" uuid,
  "cpf" text,
  "documento" text,
  "vencimento" date,
  "valor_original" numeric(14,2),
  "saldo_corrigido" numeric(14,2),
  "situacao" text,
  "tipo_boleto" text,
  "dados" jsonb,
  "importacao_id" uuid,
  "created_at" timestamp without time zone default now(),
  "status" text default 'em_aberto'::text,
  "valor_em_aberto" numeric,
  "competencia" text,
  "motivo_ajuste" text,
  "atualizado_em" timestamp with time zone default now(),
  "acordo_id" uuid,
  "vinculado_em" timestamp with time zone,
  "vinculado_por" text,
  "valor_cobranca_ajustado" numeric,
  "motivo_ajuste_valor" text,
  "valor_ajustado_por" text,
  "valor_ajustado_em" timestamp with time zone,
  "origem_liquidacao" text,
  "origem_liquidacao_ref" text,
  "origem_liquidacao_em" timestamp with time zone,
  "origem_encerramento" text,
  "origem_encerramento_ref" text,
  "origem_encerramento_em" timestamp with time zone
);

create table public.acordo_titulo_vinculo (
  "id" uuid default gen_random_uuid() primary key,
  "acordo_id" uuid,
  "titulo_id" uuid,
  "ativo" boolean default true,
  "vinculado_por" text,
  "motivo_desvinculo" text,
  "criado_em" timestamp with time zone default now(),
  "origem" text
);

create table public.parcelas (
  "id" uuid default gen_random_uuid() primary key,
  "acordo_id" uuid,
  "numero" integer default 1,
  "valor" numeric,
  "vencimento" date,
  "status" text default 'A_VENCER'::text,
  "pago_em" timestamp with time zone,
  "confirmado_por_email" text,
  "observacao" text,
  "solicitacao_confirmacao_id" uuid,
  "criado_em" timestamp with time zone default now(),
  "atualizado_em" timestamp with time zone default now(),
  "honorarios" numeric,
  "forma_pagamento" text,
  "is_entrada" boolean default false,
  "boleto" text,
  "titulos_origem" text,
  "boleto_confiavel" boolean default false,
  "renegociada_em" timestamp with time zone,
  "renegociada_no_acordo_id" uuid,
  "origem_baixa" text,
  "origem_baixa_ref" text,
  "origem_baixa_em" timestamp with time zone
);

create table public.solicitacoes_confirmacao_pagamento (
  "id" uuid default gen_random_uuid() primary key,
  "aluno_id" text,
  "aluno_nome" text,
  "aluno_cpf" text,
  "operador_email" text,
  "operador_nome" text,
  "valor_informado" numeric,
  "motivo" text,
  "status" text default 'AGUARDANDO_CONFIRMACAO'::text,
  "observacao_adm" text,
  "confirmado_por" text,
  "confirmado_em" timestamp with time zone,
  "criado_em" timestamp with time zone default now(),
  "atualizado_em" timestamp with time zone default now(),
  "acordo_id" uuid,
  "parcela_id" uuid,
  "forma_pagamento" text,
  "qtd_parcelas" integer,
  "valor_entrada" numeric,
  "entrada_paga" boolean,
  "titulo_id" uuid,
  "data_pagamento" date,
  "tipo_pagamento" text,
  "comprovante_link_id" uuid,
  "dados_vinculados_em" timestamp with time zone,
  "dados_vinculados_por_email" text,
  "principal_referencia" numeric,
  "juros" numeric,
  "multa" numeric,
  "honorarios" numeric,
  "total_negociado" numeric,
  "composicao_validada_em" timestamp with time zone,
  "composicao_validada_por_email" text,
  "pagamento_id" uuid,
  "origem_divida" text
);

create table public.auditoria (
  id uuid default gen_random_uuid() not null primary key,
  usuario text, acao text not null, tabela_afetada text, registro_id uuid, detalhes jsonb,
  created_at timestamp without time zone default now()
);



create table public.historico_operadores_alunos (
  "id" uuid default gen_random_uuid() primary key,
  "aluno_id" uuid,
  "chave_unificacao" text,
  "nome_aluno" text,
  "cpf_referencia" text,
  "acao" text,
  "operador_nome" text,
  "operador_email" text,
  "operador_anterior_nome" text,
  "operador_anterior_email" text,
  "status_jornada_anterior" text,
  "status_jornada_novo" text,
  "data_retorno_anterior" date,
  "data_retorno_nova" date,
  "observacao" text,
  "criado_em" timestamp with time zone default now()
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
  "id" uuid default gen_random_uuid() primary key,
  "aluno_id" text,
  "aluno_nome" text,
  "aluno_cpf" text,
  "operador_nome" text,
  "operador_email" text,
  "tipo_pagamento" text default 'Cartão'::text,
  "parcelas" integer,
  "valor" numeric,
  "vencimento" date,
  "link_url" text,
  "status" text default 'SOLICITADO'::text,
  "observacao_operador" text,
  "observacao_adm" text,
  "solicitado_por" text,
  "solicitado_em" timestamp with time zone default now(),
  "gerado_por" text,
  "gerado_em" timestamp with time zone,
  "enviado_em" timestamp with time zone,
  "pago_em" timestamp with time zone,
  "cancelado_em" timestamp with time zone,
  "atualizado_em" timestamp with time zone default now(),
  "baixado_por" text,
  "baixado_em" timestamp with time zone,
  "divergencia_motivo" text,
  "divergencia_em" timestamp with time zone,
  "comprovante_url" text,
  "comprovante_nome" text,
  "pagamento_identificado_por" text,
  "pagamento_identificado_em" timestamp with time zone,
  "nome_referencia" text,
  "cpf_corrigido" text,
  "cpf_status_correcao" text,
  "registro_unico" uuid default gen_random_uuid(),
  "chave_unificacao" text,
  "unificacao_status" text,
  "nome_aluno" text,
  "cpf_referencia" text,
  "forma_pagamento" text,
  "observacao_solicitacao" text,
  "link_gerado" text,
  "link_gerado_por" text,
  "link_gerado_em" timestamp with time zone,
  "enviado_ao_aluno_em" timestamp with time zone,
  "comprovante_anexado_por" text,
  "comprovante_anexado_em" timestamp with time zone,
  "baixa_realizada_por" text,
  "baixa_realizada_em" timestamp with time zone,
  "motivo_divergencia" text,
  "criado_em" timestamp with time zone default now(),
  "operador_solicitante" text,
  "data_vencimento" date,
  "observacao" text,
  "link_pagamento" text,
  "mensagem_pronta" text,
  "adm_responsavel" text,
  "assumido_em" timestamp with time zone,
  "respondido_em" timestamp with time zone,
  "enviado_operador_em" timestamp with time zone,
  "alerta_7min" boolean default false,
  "observacao_comprovante" text,
  "baixa_devolvida_em" timestamp with time zone,
  "baixa_devolvida_por" text,
  "valor_pago" numeric
);

create table public.baixas_pagamento (
  "id" uuid default gen_random_uuid() primary key,
  "aluno_id" text,
  "solicitacao_link_id" uuid,
  "aluno_nome" text,
  "aluno_cpf" text,
  "valor_pago" numeric,
  "comprovante_url" text,
  "comprovante_nome_arquivo" text,
  "observacao_operador" text,
  "status_baixa" text default 'AGUARDANDO_BAIXA'::text,
  "operador_origem_nome" text,
  "operador_origem_email" text,
  "responsavel_baixa_nome" text default 'Amanda Seibel'::text,
  "responsavel_baixa_email" text default 'amanda.seibel@aelbra.com.br'::text,
  "recebido_em" timestamp with time zone default now(),
  "atualizado_em" timestamp with time zone default now(),
  "baixado_por_nome" text,
  "baixado_por_email" text,
  "baixado_em" timestamp with time zone,
  "devolvido_por_nome" text,
  "devolvido_por_email" text,
  "devolvido_em" timestamp with time zone,
  "motivo_devolucao" text,
  "parcela_id" uuid,
  "acordo_id" uuid,
  "honorarios_recebidos" numeric,
  "data_pagamento" date
);

create table public.usuarios (
  "id" uuid default gen_random_uuid() primary key,
  "nome" text,
  "email" text,
  "perfil" text,
  "ativo" boolean default true,
  "created_at" timestamp without time zone default now(),
  "operador_nome" text,
  "operador" text,
  "foto_url" text,
  "apelido" text,
  "aniversario" date,
  "receptivo" boolean default false,
  "pode_gerir_confirmacao_pagamento" boolean default false,
  "pode_alterar_responsavel" boolean default false,
  "deve_trocar_senha" boolean default false,
  "turno" text default 'livre'::text,
  "foto_path" text,
  "nome_exibicao" text
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

create table public.alunos_unificados (
  "chave_unificacao" text,
  "nome_referencia" text,
  "nome_aluno" text,
  "cpf_referencia" text,
  "quantidade_cpfs" integer default 0,
  "quantidade_casos" integer default 0,
  "quantidade_links" integer default 0,
  "valor_total_casos" numeric default 0,
  "valor_total_links" numeric default 0,
  "status_unificacao" text,
  "atualizado_em" timestamp with time zone default now(),
  "operador_nome" text,
  "operador_email" text,
  "status_jornada" text default 'EM_COBRANCA'::text,
  "data_retorno" date,
  "hora_retorno" time without time zone,
  "prioridade_operacional" text default 'NORMAL'::text,
  "observacao_operacional" text,
  "ultima_interacao_em" timestamp with time zone,
  "ocultar_fila" boolean default false,
  "nome_aluno_editado" text,
  "cpf_referencia_editado" text,
  "telefone_aluno" text,
  "email_aluno" text,
  "curso_aluno" text,
  "unidade_aluno" text,
  "observacao_cadastro" text,
  "cadastro_atualizado_por" text,
  "cadastro_atualizado_em" timestamp with time zone,
  "atendimento_assumido_em" timestamp with time zone,
  "ultimo_operador_nome" text,
  "ultimo_operador_email" text,
  "status_atendimento" text,
  "retorno_origem" text
);

create table public.operador_agenda (
  "id" uuid default gen_random_uuid() primary key,
  "atendimento_id" uuid,
  "aluno_id" text,
  "aluno_nome" text,
  "aluno_cpf" text,
  "operador_email" text,
  "operador_nome" text,
  "retorno_em" timestamp with time zone,
  "titulo" text default 'Retorno de atendimento'::text,
  "tipo" text default 'RETORNO'::text,
  "status" text default 'PENDENTE'::text,
  "observacao" text,
  "concluido_em" timestamp with time zone,
  "criado_em" timestamp with time zone default now(),
  "atualizado_em" timestamp with time zone default now()
);

create table public.reposicao_carteira_fila (
  "id" bigint generated by default as identity primary key,
  "operador_email" text,
  "operador_nome" text,
  "operador_upper" text,
  "tipo" text,
  "caso_origem_id" uuid,
  "criado_em" timestamp with time zone default now(),
  "processado_em" timestamp with time zone,
  "repostos" integer,
  "erro" text
);
-- Colunas e tipos de prod (information_schema, 21/09/2026). Sem NOT NULL/FK/indices. ids bigint viram identity (aproximacao).
create table public.acoes_desfazer (id uuid default gen_random_uuid(), tipo text, aluno_id uuid, aluno_nome text, referencia_id uuid, movimentacao_id bigint, operador_email text, operador_nome text, rotulo text, estado_anterior jsonb, atribuiu_responsavel boolean default false, criado_em timestamp with time zone default now(), desfeito_em timestamp with time zone, desfeito_por text, motivo text, resultado jsonb);
create table public.acoes_massivas_previas (id uuid default gen_random_uuid(), criado_em timestamp with time zone default now(), criado_por_email text, filtros jsonb, solicitado integer, universo_base integer, disponiveis integer, elegiveis integer, selecionado integer, indisponiveis integer, motivos jsonb, com_responsavel integer default 0, com_fidelizacao integer default 0);
create table public.aluno_movimentacoes (id bigint generated by default as identity, aluno_id text, tipo text, descricao text, status_anterior text, status_novo text, registrado_por_nome text, registrado_por_email text, registrado_em timestamp with time zone default now(), operador_anterior_nome text, operador_anterior_email text, operador_novo_nome text, operador_novo_email text, data_retorno timestamp with time zone, solicitacao_link_id uuid, baixa_pagamento_id uuid, link_pagamento text, motivo_devolucao text, valor_movimentacao numeric, elogio_print_path text, elogio_print_nome text, elogio_aprovado_tv boolean default false, elogio_aprovado_por text, elogio_aprovado_em timestamp with time zone, elogio_rejeitado_tv boolean default false, elogio_rejeitado_por text, elogio_rejeitado_em timestamp with time zone, lote_id uuid);
create table public.alunos_estado_anterior (id bigint generated by default as identity, aluno_id uuid, estado jsonb, ator text, criado_em timestamp with time zone default now());
create table public.audit_log (id bigint generated by default as identity, tabela text, operacao text, registro_id text, usuario text, dados_antes jsonb, dados_depois jsonb, criado_em timestamp with time zone default now());
create table public.ficha_reabertura_barrada (id bigint generated by default as identity, caso_id uuid, caso_codigo integer, aluno_id uuid, outro_caso_id uuid, outro_codigo integer, nome text, em timestamp with time zone default now());
create table public.fila_acordos_confirmar (id uuid default gen_random_uuid() primary key, aluno_id uuid, cpf text, nome text, acordo_base text, qtd_parcelas integer, valor_total numeric, unidade text, situacao_aluno text, status_confirmacao text default 'A_CONFIRMAR'::text, operador_email text, observacao text, importacao_id uuid, criado_em timestamp with time zone default now(), confirmado_em timestamp with time zone, acordo_id uuid);
create table public.fila_acordos_vinculo_auditoria (id uuid default gen_random_uuid(), fila_acordo_id uuid, acordo_id_anterior uuid, acordo_id_novo uuid, alterado_por text, alterado_em timestamp with time zone default now(), motivo text);
create table public.notificacoes (id uuid default gen_random_uuid(), usuario_destino_nome text, usuario_destino_email text, tipo text, titulo text, mensagem text, aluno_id text, solicitacao_link_id uuid, baixa_id uuid, url_destino text, lida boolean default false, criado_em timestamp with time zone default now(), lida_em timestamp with time zone, caso_id uuid, link_pagamento_id uuid);
create table public.prime_contratos (cpf text, registration text, valid_from date, valid_to date, status text, tipo text, curso text, campus text, turno text, periodo_curso integer, cancelado_em date, coletado_em timestamp with time zone default now());
create table public.retornos_adm (id bigint generated by default as identity, aluno_id uuid, origem text, solicitacao_id text, tipo_solicitacao text, resultado_adm text, acionavel boolean default true, motivo text, proximo_passo text, evento_conclusao_esperado text, prioridade text default 'ALTA'::text, operador_destino_email text, operador_destino_nome text, distribuicao text, adm_email text, adm_nome text, status_tratamento text default 'PENDENTE'::text, visualizado_em timestamp with time zone, visualizado_por text, concluido_em timestamp with time zone, concluido_por text, movimentacao_id bigint, chave_idempotencia text, criado_em timestamp with time zone default now(), atualizado_em timestamp with time zone default now());
create table public.tabulacoes (codigo text, rotulo text, ativa boolean default true, ordem integer, grupo text default 'CONTATO'::text, retorno_modo text default 'NENHUM'::text, retorno_dias_uteis integer, proxima_acao text default 'CONTATAR'::text, bloco_ficha text, exige_processo boolean default false, bloqueia_acionamento boolean default false, sistema boolean default false, criado_em timestamp with time zone default now(), criado_por text, atualizado_em timestamp with time zone, atualizado_por text, desativada_em timestamp with time zone, desativada_por text, somente_gestao boolean default false, redireciona_para_email text);

create table public.importacoes (id uuid default gen_random_uuid() primary key, tipo text not null, referencia text, arquivo_nome text, usuario text, qtd_registros integer default 0, status text default 'Concluída', observacao text, created_at timestamp without time zone default now(), retroativo boolean not null default false, mes_referencia text, dia_pagamento date, substitui_importacao_id uuid, substituido_por text, substituido_em timestamptz, excluido_por text, excluido_em timestamptz, motivo_exclusao text, motivo_substituicao text, reprocessado_por text, reprocessado_em timestamptz);
create sequence public.fila_pagamento_sem_vinculo_id_seq start 9400;
create table public.fila_pagamento_sem_vinculo (id bigint not null default nextval('public.fila_pagamento_sem_vinculo_id_seq') primary key, pagamento_id uuid not null unique, importacao_id uuid, arquivo_nome text, boleto text, data_pagamento date, valor_pago numeric, valor_honorario numeric, nome_recebido text, cpf_recebido text, matricula_recebida text, sugestoes jsonb not null default '[]'::jsonb, motivo text not null, detectado_em timestamptz not null default now(), decisao text, aluno_escolhido_id uuid, decidido_por text, decidido_em timestamptz, observacao text, status_conciliacao text, evidencia_origem text, evidencia_em timestamptz, consulta_portador_em timestamptz, consulta_estrutura_resultado text);
create table public.fluxo_pagamentos_config (etapa text not null primary key, ligado boolean not null default false, observacao text, alterado_em timestamptz not null default now(), alterado_por text);
create table public.fluxo_pagamentos_execucoes (id bigint generated by default as identity primary key, rodou_em timestamptz not null default now(), origem text, carteira_antes numeric, carteira_depois numeric, resultado jsonb, erro text);
create table public.prime_portador_membro (cpf text not null, portador integer not null, coletado_em timestamptz not null default now(), ciclo integer not null default 0);
create table public.calibragem_dono_anterior_confirmacao (aluno_id text, operador_email text, operador_nome text, operador_upper text);
insert into public.fluxo_pagamentos_config(etapa,ligado) values ('amarrar_boleto',true),('pos_importacao',true),('sinalizar_duplicado',true),('baixa_por_documento',false),('vinculo_por_negociacao',false),('consulta_portador',false),('baixa_pelo_relatorio',true),('reconstruir_parcela_paga_antes',true),('encerrar_ja_paga_conferida',true),('recuperar_acordo_avista',true),('prime_liquidacao_classificar',true);

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
$function$
;

CREATE OR REPLACE FUNCTION public.titulo_superado_por_acordo(p_aluno_id uuid, p_vencimento date)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Aposentada em 26/08/2026. A mensalidade so sai da conta quando VINCULADA
  -- a um acordo (acordo_titulo_vinculo). Nao existe deducao por data.
  select false;
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.alunos_em_confirmacao_pendente()
 RETURNS TABLE(aluno_id text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT s.aluno_id::text
  FROM public.solicitacoes_confirmacao_pagamento s
  WHERE s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
    AND s.aluno_id IS NOT NULL;
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.caso_saldo_zerado_real(p_aluno_id uuid, p_matricula text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (public.caso_saldo_operacional(p_aluno_id, p_matricula) ->> 'classificacao') = 'ZERADO_REAL';
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
$function$
;

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
END; $function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public._acordo_confirmado_encerra_confirmacoes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status_confirmacao = 'CONFIRMADO'
     and coalesce(old.status_confirmacao,'') is distinct from 'CONFIRMADO'
     and new.aluno_id is not null then
    -- tira o aluno da fila de confirmacao de pagamento (encerra pendentes)
    update public.solicitacoes_confirmacao_pagamento s
    set status = 'ENCERRADO_VIA_ACORDO',
        observacao_adm = coalesce(nullif(trim(s.observacao_adm),''),'Encerrado ao confirmar o acordo na Fila de Acordos'),
        atualizado_em = now()
    where s.aluno_id = new.aluno_id::text
      and s.status = 'AGUARDANDO_CONFIRMACAO';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._acordo_fecha_com_a_ultima_parcela()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_acordo uuid;
begin
  v_acordo := coalesce(new.acordo_id, old.acordo_id);
  if v_acordo is null then return null; end if;

  update public.acordos a
     set status = 'QUITADO', saldo = 0,
         motivo_ajuste = coalesce(a.motivo_ajuste,'')
           || case when coalesce(a.motivo_ajuste,'')='' then '' else ' | ' end
           || 'quitado automaticamente: a ultima parcela foi paga',
         atualizado_em = now()
   where a.id = v_acordo
     and upper(coalesce(a.status,'')) = 'ATIVO'
     and exists (select 1 from public.parcelas p where p.acordo_id = a.id)
     and not exists (select 1 from public.parcelas p where p.acordo_id = a.id
                      and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));

  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._acordo_herda_responsavel_do_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text; v_nome text; v_ctx text;
begin
  -- ACORDO SEM CREDITO INDIVIDUAL (18/09/2026): pagamento de origem externa que
  -- a gestao autorizou. So vale com a chave transacional acesa E o registrador
  -- do acordo a vista na pilha de chamada; fora disso, nada muda.
  if coalesce(current_setting('reativa.acordo_sem_credito', true), 'off') = 'on' then
    get diagnostics v_ctx = pg_context;
    if position('function acordo_avista_registrar(uuid,uuid[],boolean)' in v_ctx) > 0 then
      return new;
    end if;
  end if;
  if new.operador_responsavel_email is not null then return new; end if;
  select al.responsavel_atual_email, al.responsavel_atual_nome
    into v_email, v_nome
    from public.alunos al where al.id = new.aluno_id;
  if v_email is not null then
    new.operador_responsavel_email := v_email;
    new.operador_responsavel_nome  := coalesce(new.operador_responsavel_nome, v_nome);
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._acordo_status_reavalia_titulos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_titulo uuid;
begin
  for v_titulo in
    select distinct t.id from public.acordos_titulos t
     where t.acordo_id = new.id
    union
    select distinct v.titulo_id from public.acordo_titulo_vinculo v
     where v.acordo_id = new.id
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._aluno_segue_dono_do_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_mensalidade numeric; v_e_operador boolean;
begin
  if nullif(trim(coalesce(new.operador_responsavel_email,'')),'') is null then return new; end if;
  if upper(coalesce(new.status,'')) <> 'ATIVO' then return new; end if;

  -- lancamento feito pela bancada (gerencia/ADM/supervisao) NAO muda o dono
  select (u.perfil = 'operador' and u.ativo) into v_e_operador
    from public.usuarios u where lower(u.email) = lower(new.operador_responsavel_email);
  if coalesce(v_e_operador, false) = false then return new; end if;

  select (public.aluno_saldo_pendente_detalhe(new.aluno_id)->>'titulos_abertos')::numeric
    into v_mensalidade;
  -- com mensalidade em aberto o nivelamento continua livre para redistribuir
  if coalesce(v_mensalidade, 0) > 0.005 then return new; end if;

  begin
    perform set_config('reativa.dono_por_acordo', '1', true);
    update public.alunos
       set responsavel_atual_email = new.operador_responsavel_email,
           responsavel_atual_nome = coalesce(new.operador_responsavel_nome, responsavel_atual_nome)
     where id = new.aluno_id
       and lower(coalesce(responsavel_atual_email,'')) is distinct from lower(new.operador_responsavel_email);
    perform set_config('reativa.dono_por_acordo', '0', true);
  exception when others then
    -- nunca bloquear a troca do acordo por causa do alinhamento do aluno
    perform set_config('reativa.dono_por_acordo', '0', true);
  end;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._bloquear_parcela_baixa_acordo_encerrado()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text;
begin
  if new.status = 'PAGO' and coalesce(old.status,'') is distinct from 'PAGO' then
    select upper(coalesce(status,'')) into v_status from public.acordos where id = new.acordo_id;
    if v_status = 'CANCELADO' then
      raise exception 'acordo_cancelado_operacao_nao_permitida' using errcode='P0001';
    end if;
  end if;
  return new;
end; $function$
;

CREATE OR REPLACE FUNCTION public._fila_acordo_fecha_ao_encerrar_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- So interessa quando o acordo DEIXA de ser ativo.
  if upper(coalesce(new.status,'')) = 'ATIVO' or upper(coalesce(old.status,'')) <> 'ATIVO' then
    return null;
  end if;
  if new.aluno_id is null then
    return null;
  end if;

  update public.fila_acordos_confirmar f
     set status_confirmacao = 'ENCERRADO_SEM_ACORDO_ATIVO',
         confirmado_em = coalesce(f.confirmado_em, now()),
         observacao = coalesce(nullif(btrim(f.observacao),''),
           'Fechada automaticamente: o acordo correspondente foi encerrado. Nao ha o que confirmar.')
   where f.confirmado_em is null
     and coalesce(f.status_confirmacao,'A_CONFIRMAR') = 'A_CONFIRMAR'
     and (
       f.acordo_id = new.id
       or (f.acordo_id is null
           and f.aluno_id = new.aluno_id
           and round(coalesce(f.valor_total,0),2) = round(coalesce(new.valor_total,0),2))
     )
     -- Guarda: se ainda existe acordo ATIVO com esse valor, ha o que confirmar.
     and not exists (
       select 1 from public.acordos a
        where a.aluno_id = new.aluno_id
          and a.status = 'ATIVO'
          and round(coalesce(a.valor_total,0),2) = round(coalesce(f.valor_total,0),2)
     );

  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._guard_resp_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.operador_responsavel_email is distinct from old.operador_responsavel_email then
    if current_user = 'reativa_responsavel_executor' then return new; end if;
    if coalesce(current_setting('app.vinculo_resp_acordo_ok', true), 'off') = 'on' then
      return new;
    end if;
    raise exception 'SEM_PERMISSAO_ALTERAR_RESPONSAVEL_ACORDO';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._parcela_pago_em_automatico()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'PAGO' and new.pago_em is null then
    new.pago_em := now();
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._reabrir_aluno_com_divida_nova()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aluno  uuid;
  v_status text;
begin
  begin
    -- Só interessa parcela que representa dívida viva.
    if upper(coalesce(new.status,'')) not in ('A_VENCER','VENCIDA') then
      return null;
    end if;

    select a.aluno_id into v_aluno
      from public.acordos a
     where a.id = new.acordo_id and a.status = 'ATIVO';

    if v_aluno is null then
      return null;
    end if;

    select upper(coalesce(status_atual,'')) into v_status
      from public.alunos where id = v_aluno;

    -- Só mexe em quem está marcado como encerrado. Aluno normal não é tocado.
    if not (v_status like 'QUIT%'
            or v_status in ('BAIXA_REALIZADA','AGUARDANDO_BAIXA',
                            'SALDO_ZERO_CONFIRMADO','SEM_SALDO_EM_ABERTO')) then
      return null;
    end if;

    update public.alunos
       set status_atual       = 'ACORDO_FECHADO',
           status_jornada     = 'ACORDO_FECHADO',
           status_acionamento = 'ACORDO_FECHADO'
     where id = v_aluno;

    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values (v_aluno::text, 'REABERTURA_DIVIDA_NOVA',
      'Aluno estava como ' || v_status || ' e voltou a ter parcela de acordo em aberto. '
      || 'Devolvido para a fila automaticamente -- sem isso a divida ficaria invisivel.',
      'ACORDO_FECHADO', 'SISTEMA', 'sistema_reabertura', now());

  exception when others then
    -- Nunca derrubar a criacao da parcela por causa disto.
    return null;
  end;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._titulo_quita_com_o_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if upper(coalesce(new.status,'')) <> 'QUITADO'
     or upper(coalesce(old.status,'')) = 'QUITADO' then
    return new;
  end if;

  -- acordo marcado quitado mas com parcela viva nao quita mensalidade nenhuma
  if exists (select 1 from public.parcelas p
              where p.acordo_id = new.id
                and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA')) then
    return new;
  end if;

  update public.acordos_titulos t
     set situacao = 'PAGO', status = 'quitada',
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'')='' then '' else ' | ' end
           || 'quitada junto com o acordo ' || coalesce(new.numero_acordo::text,'')
           || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
         atualizado_em = now()
   where t.acordo_id = new.id
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO');

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._trg_auto_quitar_parcela()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_aluno uuid;
begin
  if upper(coalesce(old.status,'')) <> 'PAGO' and upper(coalesce(new.status,'')) = 'PAGO' then
    select aluno_id into v_aluno from public.acordos where id = new.acordo_id;
    perform public._talvez_quitar_aluno(v_aluno);
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._trg_recalc_por_aluno_uuid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_aluno uuid;
begin
  begin
    v_aluno := coalesce(NEW.aluno_id, OLD.aluno_id);
    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, TG_ARGV[0]); end if;
  exception when others then null;
  end;
  return null;
end; $function$
;

CREATE OR REPLACE FUNCTION public._trg_recalc_por_parcela()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_aluno uuid;
begin
  begin
    select a.aluno_id into v_aluno from public.acordos a
     where a.id = coalesce(NEW.acordo_id, OLD.acordo_id);
    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, 'trg_parcela'); end if;
  exception when others then null;
  end;
  return null;
end; $function$
;

CREATE OR REPLACE FUNCTION public.atribuir_responsavel_por_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aid uuid; v_atual text; v_nome text; v_aluno_nome text;
  v_valor_br text; v_mudou boolean; v_aluno_id text; v_e_operador boolean;
begin
  if coalesce(new.operador_responsavel_email,'') = '' then return new; end if;

  v_aluno_id := nullif(btrim(coalesce(new.aluno_id::text, '')), '');
  begin v_aid := v_aluno_id::uuid; exception when others then v_aid := null; end;

  select coalesce(nome, new.operador_responsavel_email),
         (ativo and perfil = 'operador')
    into v_nome, v_e_operador
    from public.usuarios where lower(email) = lower(new.operador_responsavel_email) limit 1;

  v_mudou := (TG_OP = 'INSERT')
             or (TG_OP = 'UPDATE'
                 and coalesce(old.operador_responsavel_email,'') is distinct from coalesce(new.operador_responsavel_email,''));

  if v_mudou then
    if v_aid is not null then
      select nome into v_aluno_nome from public.alunos where id = v_aid;
    end if;
    v_valor_br := replace(to_char(coalesce(new.valor_total,0), 'FM999999990.00'), '.', ',');

    insert into public.notificacoes
      (usuario_destino_nome, usuario_destino_email, tipo, titulo, mensagem, aluno_id, url_destino, lida)
    values (
      coalesce(v_nome, new.operador_responsavel_email), new.operador_responsavel_email,
      'RESPONSAVEL_ACORDO', '🤝 Novo acordo sob sua responsabilidade',
      'Você é o responsável por um acordo de R$ ' || v_valor_br
        || ' do aluno ' || coalesce(v_aluno_nome, new.cpf, 'aluno')
        || '. Clique em Abrir para tratar o caso.',
      v_aid,
      case when v_aluno_id is not null then '/aluno?alunoId=' || v_aluno_id else '/painel-carteira' end,
      false);
  end if;

  if v_aid is not null and coalesce(v_e_operador, false) then
    select responsavel_atual_email into v_atual from public.alunos where id = v_aid;
    if coalesce(trim(v_atual),'') = '' then
      perform internal.set_resp_aluno(
        v_aid, new.operador_responsavel_email, coalesce(v_nome, new.operador_responsavel_email),
        'ATRIBUICAO_ACORDO', 'Responsavel definido pelo acordo',
        new.operador_responsavel_email, coalesce(v_nome, new.operador_responsavel_email));
    end if;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fila_acordos_guard_acordo_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_audit_generic()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user text := coalesce(nullif(lower(auth.email()),''), 'Sistema (rotina interna)');
  v_old jsonb; v_new jsonb; v_id text;
begin
  if TG_OP = 'DELETE' then
    v_old := to_jsonb(OLD); v_id := v_old->>'id';
  elsif TG_OP = 'INSERT' then
    v_new := to_jsonb(NEW); v_id := v_new->>'id';
  else
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); v_id := v_new->>'id';
    if v_old = v_new then return NEW; end if;
  end if;
  insert into public.audit_log (tabela, operacao, registro_id, usuario, dados_antes, dados_depois)
  values (TG_TABLE_NAME, TG_OP, v_id, v_user, v_old, v_new);
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $function$
;

CREATE OR REPLACE FUNCTION public.tg_acordo_bloquear_duplicado()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existente public.acordos%rowtype;
  v_precisa_conferir boolean;
  v_importando boolean;
begin
  if coalesce(new.status,'') <> 'ATIVO' or new.aluno_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_precisa_conferir := true;
  else
    -- So interessa quando a linha PASSA a ser uma copia: mudou a chave, ou um
    -- acordo encerrado voltou a ficar ativo. Reescrever o mesmo valor nao cria
    -- duplicacao nenhuma e nao pode barrar o trabalho.
    v_precisa_conferir :=
         coalesce(old.status,'') <> 'ATIVO'
      or old.aluno_id     is distinct from new.aluno_id
      or old.valor_total  is distinct from new.valor_total
      or old.qtd_parcelas is distinct from new.qtd_parcelas;
  end if;

  if not v_precisa_conferir then
    return new;
  end if;

  select * into v_existente
  from public.acordos
  where aluno_id = new.aluno_id
    and status = 'ATIVO'
    and coalesce(valor_total,0) = coalesce(new.valor_total,0)
    and coalesce(qtd_parcelas,0) = coalesce(new.qtd_parcelas,0)
    and id <> new.id
  limit 1;

  if not found then
    return new;
  end if;

  -- Importacao: sinaliza e deixa passar. So a propria importar_acordos liga
  -- este sinal, e so dentro da transacao dela.
  v_importando := coalesce(current_setting('reativa.importando', true), '') = 'on';

  if v_importando then
    new.duplicado_de := v_existente.id;
    new.duplicado_marcado_em := now();
    return new;
  end if;

  raise exception
    'ACORDO_DUPLICADO: este aluno já tem um acordo ATIVO de % em %x (acordo nº %, criado em %). Se o novo substitui o antigo, cancele o antigo primeiro; se são acordos diferentes, confira valor e parcelas.',
    to_char(coalesce(new.valor_total,0),'FM999G999G990D00'),
    coalesce(new.qtd_parcelas,0),
    coalesce(v_existente.numero_acordo::text,'sem número'),
    to_char(v_existente.criado_em,'DD/MM/YYYY')
    using errcode = '23505';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.titulos_por_status_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'QUITADO' then
    update public.acordos_titulos t set situacao = 'PAGO', atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('ABERTO','NEGOCIADO');

  elsif new.status = 'CANCELADO' then
    -- a MENSALIDADE volta a ser cobravel: o acordo que a substituia caiu
    update public.acordos_titulos t set situacao = 'ABERTO', atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao = 'NEGOCIADO'
       and coalesce(t.tipo_boleto,'') <> 'Acordo';

    -- o BOLETO DO PROPRIO ACORDO morre junto com ele, tendo mensalidade
    -- vinculada ou nao. Ele nunca foi divida: e o numero do documento.
    update public.acordos_titulos t
       set situacao = 'CANCELADA',
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'boleto do proprio acordo, cancelado junto com o acordo em '
             || to_char(now(),'DD/MM/YYYY'),
           atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('NEGOCIADO','ABERTO')
       and coalesce(t.tipo_boleto,'') = 'Acordo';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._acionamento_nao_volta_para_nulo()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Acionamento e fato consumado: uma vez registrado, nao se apaga.
  if old.data_ultimo_acionamento is not null and new.data_ultimo_acionamento is null then
    new.data_ultimo_acionamento := old.data_ultimo_acionamento;
  end if;

  -- A tabulacao do contato acompanha o acionamento.
  if old.status_acionamento is not null
     and nullif(btrim(old.status_acionamento),'') is not null
     and new.status_acionamento is null then
    new.status_acionamento := old.status_acionamento;
  end if;

  return new;
end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public._encerramento_so_gestao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_encerra text[] := array['CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','JURIDICO'];
  v_novo text[];
  v_antigo text[];
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role'
                       or auth.jwt() is null
                       or session_user in ('postgres','reativa_responsavel_executor');
begin
  if v_sistema or coalesce(public.usuario_e_gestao(), false) then
    return new;
  end if;

  v_novo := array[upper(coalesce(new.status_atual,'')), upper(coalesce(new.status_jornada,'')),
                  upper(coalesce(new.status_acionamento,''))];
  v_antigo := array[upper(coalesce(old.status_atual,'')), upper(coalesce(old.status_jornada,'')),
                    upper(coalesce(old.status_acionamento,''))];

  -- So barra quando o encerramento e NOVO: reescrever o que ja estava la nao e
  -- o operador encerrando nada.
  if (v_novo && v_encerra) and not (v_antigo && v_encerra) then
    raise exception
      'Encerrar cobrança (cancelamento, suspensão ou jurídico) é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._guard_resp_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.responsavel_atual_email is distinct from old.responsavel_atual_email then
    if current_user = 'reativa_responsavel_executor' then return new; end if;
    -- alinhamento automatico do dono quando a divida e so de acordo
    if coalesce(current_setting('reativa.dono_por_acordo', true), '') = '1' then return new; end if;
    -- auto-atribuicao de caso livre (regra existente)
    if old.responsavel_atual_email is null
       and lower(coalesce(new.responsavel_atual_email,'')) = lower(coalesce(auth.jwt()->>'email','')) then
      return new;
    end if;
    raise exception 'SEM_PERMISSAO_ALTERAR_RESPONSAVEL_ALUNO';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._nome_do_operador_no_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_nome text;
begin
  if new.operador_email is not null then
    v_nome := public.nome_do_operador(new.operador_email);
    if v_nome is not null then new.operador_nome := v_nome; end if;
  end if;
  if new.responsavel_atual_email is not null then
    v_nome := public.nome_do_operador(new.responsavel_atual_email);
    if v_nome is not null then new.responsavel_atual_nome := v_nome; end if;
  end if;
  return new;
end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public._sync_casos_resp_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.responsavel_atual_email is distinct from old.responsavel_atual_email then
    update public.casos
       set operador_email = lower(new.responsavel_atual_email),
           operador_nome  = new.responsavel_atual_nome,
           operador       = new.responsavel_atual_nome,
           caso_atualizado_por = coalesce(new.registrado_por_email, lower(coalesce(auth.jwt() ->> 'email',''))),
           caso_atualizado_em  = now()
     where aluno_id = new.id;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._titulo_em_confirmacao_protegido()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_oficial boolean := coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on';
  v_novo    text := upper(coalesce(new.situacao,''));
  v_velho   text := case when tg_op = 'UPDATE' then upper(coalesce(old.situacao,'')) else '' end;
begin
  if v_oficial then
    return new;
  end if;

  if v_novo = 'EM_CONFIRMACAO' and v_velho <> 'EM_CONFIRMACAO' then
    raise exception 'EM_CONFIRMACAO_SO_PELA_CONFERENCIA_PRIME: o titulo % so entra em confirmacao pela deteccao do grupo A.',
      coalesce(new.documento, '?') using errcode = 'P0001';
  end if;

  if v_velho = 'EM_CONFIRMACAO'
     and (v_novo <> 'EM_CONFIRMACAO'
          or lower(coalesce(new.status,'')) <> lower(coalesce(old.status,''))
          or new.aluno_id is distinct from old.aluno_id
          or new.acordo_id is distinct from old.acordo_id) then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('sistema', 'TITULO_EM_CONFIRMACAO_ALTERACAO_RECUSADA', 'acordos_titulos', old.id,
            jsonb_build_object('documento', old.documento,
                               'tentou_situacao', new.situacao, 'tentou_status', new.status,
                               'tentou_aluno_id', new.aluno_id, 'tentou_acordo_id', new.acordo_id));
    new.situacao  := old.situacao;
    new.status    := old.status;
    new.aluno_id  := old.aluno_id;
    new.acordo_id := old.acordo_id;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._titulo_encerrado_administrativo_protegido()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_oficial boolean := coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on';
begin
  if v_oficial or old.origem_encerramento is null then
    return new;
  end if;
  if upper(coalesce(new.situacao,'')) <> 'CANCELADA'
     or lower(coalesce(new.status,'')) <> 'cancelada'
     or new.origem_encerramento is distinct from old.origem_encerramento
     or new.origem_encerramento_ref is distinct from old.origem_encerramento_ref
     or new.origem_encerramento_em is distinct from old.origem_encerramento_em then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('sistema', 'TITULO_ENCERRADO_ADMINISTRATIVO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,
            jsonb_build_object('documento', old.documento, 'tentou_situacao', new.situacao, 'tentou_status', new.status));
    new.situacao := 'CANCELADA';
    new.status := 'cancelada';
    new.origem_encerramento := old.origem_encerramento;
    new.origem_encerramento_ref := old.origem_encerramento_ref;
    new.origem_encerramento_em := old.origem_encerramento_em;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._trg_aluno_estado_anterior()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.app_email() = '' then
    return new;
  end if;

  if coalesce(current_setting('reativa.sem_snapshot', true), '') = '1' then
    return new;
  end if;

  insert into public.alunos_estado_anterior (aluno_id, estado, ator)
  values (old.id, public._aluno_estado_json(old), public.app_email());

  return new;
exception when others then
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.alunos_propaga_encerramento_para_caso()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if upper(coalesce(new.status_atual,'')) is distinct from upper(coalesce(old.status_atual,''))
     and upper(coalesce(new.status_atual,'')) in ('JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA') then
    update public.casos
       set status_atual = case upper(new.status_atual)
                            when 'JURIDICO' then 'JURIDICO'
                            when 'SUSPENSAO_COBRANCA' then 'SUSPENSAO COBRANCA'
                            else 'CANCELAMENTO COBRANCA' end
     where aluno_id = new.id
       and not coalesce(encerrado_operacional, false);
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.atualizar_nome_normalizado()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.nome_normalizado := lower(unaccent(COALESCE(NEW.nome, '')));
  RETURN NEW;
END;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.fechar_confirmacao_ao_quitar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status_atual ilike 'QUIT%' or new.status_atual='BAIXA_REALIZADA'
     or new.status_jornada ilike 'QUIT%' or new.status_jornada='BAIXA_REALIZADA' then
    update public.solicitacoes_confirmacao_pagamento s
    set status='PAGAMENTO_CONFIRMADO',
        observacao_adm=coalesce(nullif(trim(s.observacao_adm),''),'Confirmado automaticamente (aluno quitado/baixado)'),
        confirmado_em=coalesce(s.confirmado_em, now()), atualizado_em=now()
    where s.aluno_id = new.id::text and s.status='AGUARDANDO_CONFIRMACAO';
    -- (removido) NAO marcar todos os titulos como PAGO; so o que for pago de fato.
  end if;
  return new;
end;$function$
;

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
end;$function$
;

CREATE OR REPLACE FUNCTION public.fn_audit_responsavel_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_user text := coalesce(nullif(lower(auth.email()),''), 'Sistema (rotina interna)');
begin
  if NEW.responsavel_atual_email IS NOT DISTINCT FROM OLD.responsavel_atual_email then
    return NEW;
  end if;

  insert into public.audit_log (tabela, operacao, registro_id, usuario, dados_antes, dados_depois)
  values (
    'alunos.responsavel', 'TROCA_RESPONSAVEL', NEW.id::text, v_user,
    jsonb_build_object('responsavel_email', OLD.responsavel_atual_email,
                       'responsavel_nome',  OLD.responsavel_atual_nome),
    jsonb_build_object('responsavel_email', NEW.responsavel_atual_email,
                       'responsavel_nome',  NEW.responsavel_atual_nome)
  );
  return NEW;
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_sync_acionamento_alunos_para_casos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_dia date;
begin
  if new.data_ultimo_acionamento is not null
     and new.data_ultimo_acionamento is distinct from old.data_ultimo_acionamento then
    v_dia := (new.data_ultimo_acionamento at time zone 'America/Sao_Paulo')::date;
    update public.casos c
       set data_ultimo_acionamento = v_dia
     where c.aluno_id = new.id
       and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento < v_dia);
  end if;
  return new;
end; $function$
;

CREATE OR REPLACE FUNCTION public.limpar_retorno_origem()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.data_retorno is null then
    new.retorno_origem := null;
  end if;
  return new;
end;
$function$
;

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
$function$
;

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
end;$function$
;

CREATE OR REPLACE FUNCTION public.sincronizar_alunos_unificados()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.chave_unificacao is null then
    return new;
  end if;

  update public.alunos_unificados
  set
    data_retorno = new.data_retorno,
    retorno_origem = new.retorno_origem,
    hora_retorno = nullif(new.hora_retorno, '')::time,
    status_jornada = new.status_jornada,
    operador_nome = coalesce(new.responsavel_atual_nome, new.operador_nome, new.operador, operador_nome),
    operador_email = coalesce(new.responsavel_atual_email, new.operador_email, operador_email),
    ultima_interacao_em = now()
  where chave_unificacao = new.chave_unificacao;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_aluno_concluir_retorno_adm_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_afetados int;
begin
  begin
    update public.retornos_adm
      set status_tratamento = 'CONCLUIDO', concluido_em = now(),
          concluido_por = coalesce(auth.email(), 'sistema (status do aluno avancou)')
      where aluno_id = new.id
        and origem = 'links_pagamento'
        and resultado_adm = 'LINK_PRONTO_PARA_ENVIO'
        and status_tratamento in ('PENDENTE','EM_TRATAMENTO');
    get diagnostics v_afetados = row_count;
    if v_afetados > 0 then
      insert into public.aluno_movimentacoes(
        aluno_id, tipo, descricao, status_anterior, status_novo,
        registrado_por_nome, registrado_por_email, registrado_em
      ) values (
        new.id, 'RETORNO_ADM_CONCLUIDO',
        'Retorno do ADM concluído: aluno avançou de "link pronto para envio".',
        'LINK_PRONTO_PARA_ENVIO', new.status_atual,
        'Sistema (Retorno ADM)', auth.email(), now()
      );
    end if;
  exception when others then
    raise notice 'tg_aluno_concluir_retorno_adm_link falhou (ignorado): %', sqlerrm;
  end;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.tg_aluno_reset_retorno_confirmado()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.retorno_confirmado_em := null;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.tg_titulo_ajuste_valor_protegido()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_mudou boolean;
begin
  if TG_OP = 'INSERT' then
    v_mudou := new.valor_cobranca_ajustado is not null
            or new.motivo_ajuste_valor is not null
            or new.valor_ajustado_por is not null
            or new.valor_ajustado_em is not null;
  else
    v_mudou := new.valor_cobranca_ajustado is distinct from old.valor_cobranca_ajustado
            or new.motivo_ajuste_valor     is distinct from old.motivo_ajuste_valor
            or new.valor_ajustado_por      is distinct from old.valor_ajustado_por
            or new.valor_ajustado_em       is distinct from old.valor_ajustado_em;
  end if;

  if not v_mudou then return new; end if;

  -- escrita vinda do RPC oficial
  if coalesce(current_setting('app.ajuste_valor_ok', true), 'off') = 'on' then
    return new;
  end if;

  -- backend sem pessoa: cron, service_role, manutencao
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  raise exception 'SEM_PERMISSAO_AJUSTAR_VALOR_COBRAVEL' using errcode = '42501';
end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.trg_tabulacao_redireciona()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_destino text; v_nome text; v_ant_email text; v_ant_nome text;
begin
  -- Só reage quando a TABULAÇÃO muda; troca de responsável não dispara de novo.
  if new.status_jornada is not distinct from old.status_jornada then
    return new;
  end if;

  select t.redireciona_para_email into v_destino
    from public.tabulacoes t
   where t.codigo = new.status_jornada and t.ativa and t.redireciona_para_email is not null;
  if v_destino is null then return new; end if;

  if lower(coalesce(new.responsavel_atual_email,'')) = lower(v_destino) then
    return new;  -- ja esta com quem deveria
  end if;

  select nome into v_nome from public.usuarios where lower(email) = lower(v_destino) and ativo;
  if v_nome is null then return new; end if;  -- destino inativo: nao move

  v_ant_email := new.responsavel_atual_email;
  v_ant_nome  := new.responsavel_atual_nome;

  -- NAO usa internal.set_resp_aluno de proposito: aquela funcao ZERA
  -- data_retorno, proxima_acao e status_acionamento quando o responsavel muda,
  -- e apagaria justamente o retorno de 20 dias que a tabulacao acabou de
  -- agendar. Aqui a troca preserva o agendamento.
  update public.alunos
     set responsavel_atual_email = lower(v_destino),
         responsavel_atual_nome  = v_nome,
         responsavel_atual_em    = now(),
         operador_email = lower(v_destino),
         operador_nome  = v_nome,
         operador       = v_nome
   where id = new.id;

  update public.casos
     set operador_email = lower(v_destino), operador_nome = v_nome, operador = upper(v_nome)
   where aluno_id = new.id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, operador_anterior_nome, operador_anterior_email,
     operador_novo_nome, operador_novo_email, registrado_por_nome, registrado_por_email, registrado_em)
  values (new.id::text, 'ALEGACAO_ENCAMINHADA',
    'Tabulado como "' || new.status_jornada || '": caso encaminhado a ' || v_nome ||
    ' para envio ao financeiro. Retorno em 20 dias úteis para cobrar a unidade.',
    coalesce(v_ant_nome,'(sem)'), v_ant_email, v_nome, lower(v_destino),
    coalesce(v_ant_nome, v_ant_email, 'sistema'), coalesce(v_ant_email,'sistema'), now());

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._aluno_estado_json(a alunos)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select jsonb_build_object(
    'status_jornada',          a.status_jornada,
    'status_atual',            a.status_atual,
    'status_acionamento',      a.status_acionamento,
    'proxima_acao',            a.proxima_acao,
    'data_retorno',            a.data_retorno,
    'hora_retorno',            a.hora_retorno,
    'observacao',              a.observacao,
    'data_ultimo_acionamento', a.data_ultimo_acionamento,
    'ultimo_contato',          a.ultimo_contato,
    'registrado_em',           a.registrado_em,
    'registrado_por_email',    a.registrado_por_email,
    'registrado_por_nome',     a.registrado_por_nome
  );
$function$
;

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

  -- Titulo aguardando a Conferencia Prime nao e divida quitada: o aluno
  -- espera a decisao, nao vira QUITADO.
  if exists (select 1 from public.acordos_titulos
              where aluno_id = v_aluno and upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') then
    return;
  end if;

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
$function$
;

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
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._trg_auto_quitar_titulo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- EM_CONFIRMACAO conta como divida ainda nao resolvida: entrar nele nao
  -- quita ninguem; sair dele para PAGO (baixa confirmada) segue quitando.
  -- CANCELADA e saida ADMINISTRATIVA (saiu da base / encerramento pela
  -- Conferencia Prime): nao e quitacao, nao chama _talvez_quitar_aluno.
  if upper(coalesce(new.situacao,'')) = 'CANCELADA' then
    return new;
  end if;
  if upper(coalesce(old.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO') then
    perform public._talvez_quitar_aluno(new.aluno_id);
  end if;
  return new;
end;
$function$
;

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
  v_tit_conf       int := 0;
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

  -- Titulo aguardando a Conferencia Prime: fora do total exigivel (nao e
  -- cobrado), mas e pendencia -- ninguem quita nem encerra o aluno por ele.
  select count(*)
    into v_tit_conf
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO';

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
    'titulos_em_confirmacao', v_tit_conf,
    'tem_pendencia', (v_total > 0.005 or v_conf_pendentes > 0 or v_tit_conf > 0)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_email()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select lower(coalesce((auth.jwt() ->> 'email'), ''));
$function$
;

CREATE OR REPLACE FUNCTION public.cancelar_acordo_ficha(p_acordo_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_agora    timestamptz := now();
  v_acordo   public.acordos%rowtype;
  v_titulos  int := 0;
  v_vinculos int := 0;
  v_parcelas int := 0;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Cancelar acordo e exclusivo da gestao financeira.' using errcode = '42501';
  end if;

  select * into v_acordo from public.acordos where id = p_acordo_id for update;
  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo ja esta cancelado.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.parcelas where acordo_id = p_acordo_id and upper(coalesce(status, '')) = 'PAGO') then
    raise exception 'Esse acordo ja tem parcela paga -- nao da pra cancelar (protege o historico financeiro). Se foi um erro, fale com quem confirmou o pagamento antes de mexer.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.baixas_pagamento where acordo_id = p_acordo_id and devolvido_em is null) then
    raise exception 'Esse acordo ja tem alguma baixa/pagamento registrado -- nao da pra cancelar por aqui.' using errcode = 'P0001';
  end if;

  update public.acordos_titulos t
     set status = 'em_aberto', atualizado_em = v_agora
   where t.id in (select v.titulo_id from public.acordo_titulo_vinculo v where v.acordo_id = p_acordo_id);
  get diagnostics v_titulos = row_count;

  delete from public.acordo_titulo_vinculo where acordo_id = p_acordo_id;
  get diagnostics v_vinculos = row_count;

  update public.parcelas
     set status = 'CANCELADA', atualizado_em = v_agora
   where acordo_id = p_acordo_id
     and upper(coalesce(status, '')) <> 'PAGO';
  get diagnostics v_parcelas = row_count;

  update public.acordos
     set status = 'CANCELADO', saldo = 0, atualizado_em = v_agora
   where id = p_acordo_id;

  if v_acordo.aluno_id is not null then
    perform public.liberar_caso_por_evento(v_acordo.aluno_id, 'CANCELADO');
  end if;

  return jsonb_build_object(
    'ok', true,
    'acordo_id', p_acordo_id,
    'titulos_reabertos', v_titulos,
    'vinculos_removidos', v_vinculos,
    'parcelas_canceladas', v_parcelas
  );
end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.fila_acordos_pode_vincular()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.usuario_e_gestao_fila()
     and exists (
       select 1 from public.usuarios u
       where lower(u.email) = lower(auth.email()) and u.ativo
     );
$function$
;

CREATE OR REPLACE FUNCTION public.fila_vincular_acordo(p_fila_id uuid, p_acordo_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email       text := lower(auth.email());
  v_motivo      text := btrim(coalesce(p_motivo, ''));
  v_old         uuid;
  v_alterado    boolean := false;
  v_nome        text;
  v_email_resp  text;
begin
  if not public.fila_acordos_pode_vincular() then
    raise exception 'Usuário % não autorizado a vincular acordos.', coalesce(v_email, '(anônimo)')
      using errcode = '42501';
  end if;
  if v_motivo = '' then
    raise exception 'Motivo é obrigatório para vincular/trocar o acordo.'
      using errcode = '22023';
  end if;
  if p_acordo_id is null then
    raise exception 'acordo_id é obrigatório.' using errcode = '22023';
  end if;

  select acordo_id into v_old
  from public.fila_acordos_confirmar
  where id = p_fila_id
  for update;
  if not found then
    raise exception 'Linha da fila % inexistente.', p_fila_id using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.acordos where id = p_acordo_id) then
    raise exception 'Acordo % inexistente.', p_acordo_id using errcode = 'P0002';
  end if;

  if v_old is not distinct from p_acordo_id then
    v_alterado := false;
  else
    v_alterado := true;
    perform set_config('app.fila_vinculo_ok', 'on', true);
    update public.fila_acordos_confirmar
       set acordo_id = p_acordo_id
     where id = p_fila_id;
    perform set_config('app.fila_vinculo_ok', 'off', true);

    insert into public.fila_acordos_vinculo_auditoria
      (fila_acordo_id, acordo_id_anterior, acordo_id_novo, alterado_por, motivo)
    values
      (p_fila_id, v_old, p_acordo_id, v_email, v_motivo);
  end if;

  select operador_responsavel_nome,
         case when nullif(btrim(operador_responsavel_nome), '') is null
              then operador_responsavel_email else null end
    into v_nome, v_email_resp
  from public.acordos
  where id = p_acordo_id;

  return jsonb_build_object(
    'fila_id',                    p_fila_id,
    'acordo_id',                  p_acordo_id,
    'acordo_id_anterior',         v_old,
    'alterado',                   v_alterado,
    'operador_responsavel_nome',  v_nome,
    'operador_responsavel_email', v_email_resp
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.liberar_caso_por_evento(p_aluno_id uuid, p_evento text, p_valor_pago numeric DEFAULT NULL::numeric, p_data_pagamento date DEFAULT CURRENT_DATE)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_det jsonb;
begin
  IF p_evento = 'LINK_PAGO' THEN
    v_det := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);
    IF (v_det ->> 'tem_pendencia')::boolean THEN
      insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe)
      values (p_aluno_id, 'LINK_PAGAMENTO', (v_det ->> 'total')::numeric, v_det);
      RETURN;
    END IF;
    UPDATE public.casos
    SET status_financeiro = 'QUITADO_LINK_PAGAMENTO', quitado_em = p_data_pagamento,
        valor_quitado = COALESCE(p_valor_pago, 0), origem_quitacao = 'LINK_PAGAMENTO',
        caso_atualizado_por = 'sistema_link_pagamento', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'CANCELADO' THEN
    -- ANTES: status_acionamento = 'CANCELADO' -- lido como cobranca cancelada.
    -- AGORA: rotulo que so fala de acordo. O caso continua na fila.
    UPDATE public.casos
    SET status_acionamento = 'ACORDO_CANCELADO', caso_atualizado_por = 'sistema_cancelamento_acordo', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
    PERFORM public.retirar_zerados_reais_sem_saldo(p_aluno_id, null);
  ELSIF p_evento = 'JURIDICO' THEN
    UPDATE public.casos
    SET status_acionamento = 'JURIDICO', caso_atualizado_por = 'sistema_juridico', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'ACORDO_MENSALIDADE_LIBERADA' THEN
    UPDATE public.casos
    SET status_acionamento = 'ACORDO FECHADO', caso_atualizado_por = 'sistema_acordo_fechado', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  END IF;
end;
$function$
;

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
  values ('sistema', 'TITULO_LIQUIDADO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,
          jsonb_build_object('documento', old.documento, 'tentou', v_tentou,
                             'origem_liquidacao_ref', old.origem_liquidacao_ref,
                             'acordo_id_novo', new.acordo_id));
  return new;
end;
$function$
;

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
$function$
;

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
end; $function$
;

CREATE OR REPLACE FUNCTION public.acoes_massivas_liquidados_prime(p_aluno_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(aluno_id uuid, titulos integer, valor_crm numeric, pago_prime numeric, ultima_liquidacao date)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with vivos as (
    select t.id, t.aluno_id, t.cpf, t.vencimento, t.created_at::date as importado,
           regexp_replace(coalesce(t.documento,''), '\D', '', 'g') as boleto,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v
      from public.acordos_titulos t
     where (p_aluno_ids is null or t.aluno_id = any(p_aluno_ids))
       and upper(coalesce(t.situacao,'')) = 'ABERTO'
       and coalesce(lower(t.status),'') <> 'quitada'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and not exists (
         select 1 from public.acordo_titulo_vinculo vv
           join public.acordos ac on ac.id = vv.acordo_id
          where vv.titulo_id = t.id and coalesce(vv.ativo, true)
            and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA'))
  ),
  cls as (
    select v.aluno_id, v.v, e.liquidado_em, e.valor_pago,
           (e.liquidado_em is not null
            and e.liquidado_em > v.vencimento + 30
            and e.liquidado_em >= v.importado
            and coalesce(e.valor_pago, 0) > 0) as liquidado_real
      from vivos v
      left join lateral (
        select e.liquidado_em, e.valor_pago
          from public.prime_extrato e
         where e.boleto = v.boleto and e.cpf = v.cpf
         order by e.coletado_em desc limit 1) e on true
  )
  select cls.aluno_id, count(*)::int, sum(cls.v), sum(cls.valor_pago), max(cls.liquidado_em)
    from cls
   group by cls.aluno_id
  having bool_and(cls.liquidado_real)
     and not exists (select 1 from public.acordos ac
                      where ac.aluno_id = cls.aluno_id
                        and upper(coalesce(ac.status,'')) in ('CANCELADO','CANCELADA'))
     and (sum(cls.valor_pago) >= sum(cls.v) * 0.5
          or exists (select 1 from public.acordos ac
                      where ac.aluno_id = cls.aluno_id
                        and upper(coalesce(ac.status,'')) like 'QUITADO%'));
$function$
;

CREATE OR REPLACE FUNCTION public.acoes_massivas_previa(p_ano_vencimento text DEFAULT NULL::text, p_limite integer DEFAULT 1000, p_dias_minimo_sem_contato integer DEFAULT NULL::integer, p_apenas_nunca_acionado boolean DEFAULT false, p_unidade text DEFAULT NULL::text, p_curso text DEFAULT NULL::text, p_apenas_ja_acionado boolean DEFAULT false, p_situacao_academica text DEFAULT NULL::text, p_importacao_ids uuid[] DEFAULT NULL::uuid[], p_matricula text DEFAULT NULL::text, p_canal text DEFAULT NULL::text, p_valor_min numeric DEFAULT 0, p_valor_max numeric DEFAULT NULL::numeric, p_operador_email text DEFAULT NULL::text, p_tipo_cobranca text DEFAULT NULL::text, p_acionamento text DEFAULT 'TODOS'::text, p_recencia_dias integer DEFAULT 10, p_sem_telefone boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_autor text;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 5000);
  v_acion text := upper(coalesce(nullif(btrim(p_acionamento), ''), 'TODOS'));
  v_op text := coalesce(lower(nullif(btrim(p_operador_email), '')), 'livres');
  v_filtros jsonb;
  v_res jsonb;
  v_previa uuid;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: previa de acao massiva restrita a gestao.' using errcode = '42501';
  end if;
  if v_acion not in ('TODOS', 'NAO_MES', 'MES', 'NAO_HOJE', 'HOJE', 'NUNCA', 'JA') then
    raise exception 'Filtro de acionamento invalido: %', p_acionamento using errcode = '22023';
  end if;
  if v_acion = 'TODOS' and p_apenas_nunca_acionado then v_acion := 'NUNCA'; end if;
  if v_acion = 'TODOS' and p_apenas_ja_acionado then v_acion := 'JA'; end if;
  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;

  v_filtros := jsonb_strip_nulls(jsonb_build_object(
    'ano', nullif(btrim(p_ano_vencimento), ''),
    'unidade', nullif(btrim(p_unidade), ''),
    'curso', nullif(btrim(p_curso), ''),
    'situacao_academica', nullif(btrim(p_situacao_academica), ''),
    'matricula', nullif(btrim(p_matricula), ''),
    'importacao_ids', to_jsonb(p_importacao_ids),
    'operador', v_op,
    'tipo_cobranca', coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), 'MENSALIDADES_E_ACORDOS'),
    'canal', upper(nullif(btrim(p_canal), '')),
    'sem_telefone', coalesce(p_sem_telefone, false),
    'valor_min', coalesce(p_valor_min, 0),
    'valor_max', p_valor_max,
    'recencia_dias', coalesce(p_recencia_dias, 10),
    'acionamento', v_acion,
    'dias_minimo_sem_contato', p_dias_minimo_sem_contato,
    'limite', v_limite));

  with u as materialized (select * from public.acoes_massivas_universo(v_filtros)),
  el as materialized (
    select u.*
      from u
     where u.disponivel
       and (case v_acion
              when 'TODOS' then true
              when 'NAO_MES' then not u.acionado_mes
              when 'MES' then u.acionado_mes
              when 'NAO_HOJE' then not u.acionado_hoje
              when 'HOJE' then u.acionado_hoje
              when 'NUNCA' then u.nunca_acionado
              when 'JA' then not u.nunca_acionado
            end)
       and (p_dias_minimo_sem_contato is null or u.ultimo_acionamento is null
            or (u.ultimo_acionamento at time zone 'America/Sao_Paulo')::date <= v_hoje - p_dias_minimo_sem_contato)
  ),
  -- PRIORIDADE: nao acionados no mes; nunca acionados; maior tempo sem acionamento;
  -- maior saldo apenas como desempate; aluno_id como ultimo desempate.
  sel as materialized (
    select el.*
      from el
     order by el.acionado_mes asc, el.nunca_acionado desc, el.ultimo_acionamento asc nulls first,
              el.valor desc nulls last, el.aluno_id
     limit v_limite
  ),
  itens as (
    select s.*, a.nome, a.telefone, a.email, a.situacao_academica, a.curso, a.unidade,
           nullif(regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g'), '') as tel_dig,
           btrim(coalesce(a.email, '')) as email_t
      from sel s join public.alunos a on a.id = s.aluno_id
  )
  select jsonb_build_object(
    'resumo', jsonb_build_object(
      'solicitado', v_limite,
      'universo_base', (select count(*) from u),
      'disponiveis', (select count(*) from u where u.disponivel),
      'elegiveis', (select count(*) from el),
      'fora_do_filtro_acionamento', (select count(*) from u where u.disponivel) - (select count(*) from el),
      'selecionado', (select count(*) from sel),
      'indisponiveis', (select count(*) from u where not u.disponivel),
      'motivos', coalesce((select jsonb_object_agg(m.motivo, m.n)
                             from (select u.motivo, count(*) as n from u where u.motivo is not null group by u.motivo) m), '{}'::jsonb),
      'com_responsavel', (select count(*) from sel where sel.responsavel_email is not null),
      'com_fidelizacao_ativa', (select count(*) from sel where sel.fidelizacao_ativa),
      'menos_que_solicitado', (select count(*) from sel) < v_limite,
      'filtros', v_filtros),
    'elegiveis', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.aluno_id,
        'nome', split_part(coalesce(i.nome, '-'), ' ', 1) || ' ***',
        'situacao_academica', nullif(btrim(i.situacao_academica), ''),
        'curso', nullif(btrim(i.curso), ''),
        'unidade', i.unidade,
        'tem_telefone', i.tel_dig is not null,
        'tem_email', (i.email_t <> '' and position('@' in i.email_t) > 1),
        'telefone_mascarado', case when i.tel_dig is null then null
                                   when length(i.tel_dig) >= 4 then '••••' || right(i.tel_dig, 4) else '••••' end,
        'email_mascarado', case when i.email_t <> '' and position('@' in i.email_t) > 1
                                then left(i.email_t, 1) || '•••@' || split_part(i.email_t, '@', 2) else null end,
        'data_ultimo_acionamento', i.ultimo_acionamento,
        'valor', i.valor,
        'tem_responsavel', i.responsavel_email is not null,
        'responsavel_email', i.responsavel_email,
        'fidelizacao_ativa', i.fidelizacao_ativa,
        'acionado_mes', i.acionado_mes)
        order by i.acionado_mes asc, i.nunca_acionado desc, i.ultimo_acionamento asc nulls first,
                 i.valor desc nulls last, i.aluno_id) from itens i), '[]'::jsonb),
    'excluidos_confirmacao', '[]'::jsonb,
    'total_excluidos_confirmacao', (select count(*) from u where u.motivo = 'confirmacao_pendente'),
    'total_elegivel_filtros', (select count(*) from el),
    'prime_extrato_em', (select max(e.coletado_em)::date from public.prime_extrato e),
    'operador_email', v_op,
    'tipo_cobranca', coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), 'MENSALIDADES_E_ACORDOS'),
    -- quantidade por opcao de tipo, com todos os demais filtros aplicados e sem o limite
    'contagem_tipo', (select jsonb_build_object(
        'mensalidades', count(*) filter (where u.motivo_sem_tipo is null
                          and public.acoes_massivas_tipo_cobranca_corresponde('MENSALIDADES', u.tem_mensalidade, u.tem_acordo_vencido)),
        'acordos_vencidos', count(*) filter (where u.motivo_sem_tipo is null
                          and public.acoes_massivas_tipo_cobranca_corresponde('ACORDOS_VENCIDOS', u.tem_mensalidade, u.tem_acordo_vencido)),
        'mensalidades_e_acordos_vencidos', count(*) filter (where u.motivo_sem_tipo is null
                          and u.tem_mensalidade and u.tem_acordo_vencido),
        'total_unico', count(*) filter (where u.motivo_sem_tipo is null
                          and public.acoes_massivas_tipo_cobranca_corresponde('MENSALIDADES_E_ACORDOS', u.tem_mensalidade, u.tem_acordo_vencido)))
        from u)
  ) into v_res;

  insert into public.acoes_massivas_previas
    (criado_por_email, filtros, solicitado, universo_base, disponiveis, elegiveis, selecionado,
     indisponiveis, motivos, com_responsavel, com_fidelizacao)
  values (v_autor, v_filtros, v_limite,
          (v_res->'resumo'->>'universo_base')::int, (v_res->'resumo'->>'disponiveis')::int,
          (v_res->'resumo'->>'elegiveis')::int, (v_res->'resumo'->>'selecionado')::int,
          (v_res->'resumo'->>'indisponiveis')::int, v_res->'resumo'->'motivos',
          (v_res->'resumo'->>'com_responsavel')::int, (v_res->'resumo'->>'com_fidelizacao_ativa')::int)
  returning id into v_previa;

  return v_res || jsonb_build_object('previa_id', v_previa);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.acoes_massivas_tipo_cobertura(p_tipo text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(p_tipo, '') in (
    'FINALIZACAO_ATENDIMENTO', 'FINALIZACAO', 'CONTATO',
    'LINK_ENVIADO_AO_ALUNO', 'SOLICITACAO_LINK_PAGAMENTO',
    'ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL');
$function$
;

CREATE OR REPLACE FUNCTION public.acoes_massivas_tipo_cobranca_corresponde(p_tipo text, p_tem_mensalidade boolean, p_tem_acordo_vencido boolean)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case upper(coalesce(p_tipo, ''))
           -- mensalidade SEM acordo vencido: quem tem os dois fica nos acordos
           when 'MENSALIDADES' then coalesce(p_tem_mensalidade, false) and not coalesce(p_tem_acordo_vencido, false)
           when 'ACORDOS_VENCIDOS' then coalesce(p_tem_acordo_vencido, false)
           when 'MENSALIDADES_E_ACORDOS' then coalesce(p_tem_mensalidade, false) or coalesce(p_tem_acordo_vencido, false)
           else false
         end;
$function$
;

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
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.dia_util_anterior_ou_igual(p_dia date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case extract(isodow from p_dia)::int when 6 then p_dia - 1 when 7 then p_dia - 2 else p_dia end;
$function$
;

CREATE OR REPLACE FUNCTION public.fmt_brl(p numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select 'R$ ' || translate(to_char(round(coalesce(p,0),2),'FM999G999G999G990D00'), '.,', ',.');
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.acoes_massivas_universo(p_filtros jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(aluno_id uuid, anos integer[], responsavel_email text, valor numeric, ultimo_acionamento timestamp with time zone, ultimo_massivo timestamp with time zone, acionado_mes boolean, acionado_hoje boolean, nunca_acionado boolean, tem_mensalidade boolean, tem_acordo_vencido boolean, fidelizacao_ativa boolean, tem_telefone boolean, tem_email boolean, disponivel boolean, motivo text, motivo_sem_tipo text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
#variable_conflict use_column
declare
  f jsonb := coalesce(p_filtros, '{}'::jsonb);
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_hoje_ini timestamptz;
  v_mes_ini timestamptz;
  v_anos int[];
  v_unid text[];
  v_curso text := nullif(btrim(f->>'curso'), '');
  v_sit text[];
  v_matricula text := nullif(btrim(f->>'matricula'), '');
  v_imp uuid[];
  v_ids uuid[];
  v_ids_txt text[];
  v_op text := coalesce(lower(nullif(btrim(f->>'operador'), '')), 'livres');
  v_tipo text := coalesce(upper(nullif(btrim(f->>'tipo_cobranca'), '')), 'MENSALIDADES_E_ACORDOS');
  v_canal text := upper(nullif(btrim(f->>'canal'), ''));
  v_sem_tel boolean := coalesce((f->>'sem_telefone')::boolean, false);
  v_min numeric := coalesce(nullif(f->>'valor_min', '')::numeric, 0);
  v_max numeric := nullif(f->>'valor_max', '')::numeric;
  v_rec int := coalesce(nullif(f->>'recencia_dias', '')::int, 10);
  v_tipos_massivo text[];
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: universo das acoes massivas restrito a gestao.' using errcode = '42501';
  end if;
  if v_tipo not in ('MENSALIDADES', 'ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS') then
    raise exception 'Tipo de cobranca invalido: %', v_tipo using errcode = '22023';
  end if;
  if v_canal is not null and v_canal not in ('WHATSAPP', 'EMAIL') then
    raise exception 'Canal invalido: %', v_canal using errcode = '22023';
  end if;
  if v_rec < 0 or v_rec > 60 then
    raise exception 'Recencia da acao massiva deve estar entre 0 e 60 dias (recebido: %).', v_rec using errcode = '22023';
  end if;

  v_hoje_ini := v_hoje::timestamp at time zone 'America/Sao_Paulo';
  v_mes_ini  := date_trunc('month', v_hoje::timestamp) at time zone 'America/Sao_Paulo';
  v_anos := case when nullif(btrim(f->>'ano'), '') is null then null
                 else string_to_array(btrim(f->>'ano'), '|')::int[] end;
  v_unid := case when nullif(btrim(f->>'unidade'), '') is null then null
                 else string_to_array(btrim(f->>'unidade'), '|') end;
  v_sit  := case when nullif(btrim(f->>'situacao_academica'), '') is null then null
                 else string_to_array(btrim(f->>'situacao_academica'), '|') end;
  v_imp := case when jsonb_typeof(f->'importacao_ids') = 'array'
                then array(select jsonb_array_elements_text(f->'importacao_ids')::uuid) end;
  v_ids := case when jsonb_typeof(f->'aluno_ids') = 'array'
                then array(select jsonb_array_elements_text(f->'aluno_ids')::uuid) end;
  v_ids_txt := case when v_ids is null then null else array(select x::text from unnest(v_ids) x) end;
  v_tipos_massivo := case v_canal
    when 'WHATSAPP' then array['ACAO_MASSIVA_EXTERNA']
    when 'EMAIL'    then array['ACAO_MASSIVA_EXTERNA_EMAIL']
    else array['ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL'] end;

  return query
  with liq as materialized (
    select lp.aluno_id from public.acoes_massivas_liquidados_prime(v_ids) lp
  ),
  sol as materialized (
    select distinct s.aluno_id::text as id
      from public.solicitacoes_confirmacao_pagamento s
     where s.status in ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  tc as materialized (
    select t.aluno_id, t.tem_mensalidade, t.tem_acordo_vencido
      from public.acoes_massivas_tipo_cobranca_alunos(v_ids) t
  ),
  -- BASE: quem tem divida ativa; o ano e o do vencimento do titulo em aberto
  -- (ou da parcela vencida de acordo ativo).
  tit as materialized (
    select t.aluno_id, extract(year from t.vencimento)::int as ano
      from public.acordos_titulos t
     where t.aluno_id is not null
       and (v_ids is null or t.aluno_id = any(v_ids))
       and t.vencimento is not null
       and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
       and coalesce(lower(t.status), '') <> 'quitada'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
  ),
  parc as materialized (
    select a.aluno_id, extract(year from p.vencimento)::int as ano
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where a.status = 'ATIVO' and p.status = 'VENCIDA' and p.vencimento is not null
       and (v_ids is null or a.aluno_id = any(v_ids))
  ),
  base as materialized (
    select x.aluno_id, array_agg(distinct x.ano order by x.ano) as anos
      from (select * from tit union select * from parc) x
     group by x.aluno_id
  ),
  -- COBERTURA: so eventos de acionamento valido.
  mov as materialized (
    select m.aluno_id,
           max(m.registrado_em) as ult,
           bool_or(m.registrado_em >= v_mes_ini) as mes,
           bool_or(m.registrado_em >= v_hoje_ini) as hoje,
           max(m.registrado_em) filter (where m.tipo = any(v_tipos_massivo)) as ult_mass
      from public.aluno_movimentacoes m
     where public.acoes_massivas_tipo_cobertura(m.tipo)
       and (v_ids_txt is null or m.aluno_id = any(v_ids_txt))
       -- FINALIZACAO DESFEITA nao conta. Regra restrita ao par deterministico:
       -- acoes_desfazer.movimentacao_id aponta para ESTA movimentacao e a acao
       -- foi desfeita (desfeito_em preenchido). Hoje desfazer_acao ja retipa a
       -- movimentacao para FINALIZACAO_ATENDIMENTO_DESFEITA (que nao esta na
       -- lista); este filtro garante o mesmo resultado se algum desfazer futuro
       -- nao retipar. Uma ACAO_DESFEITA generica, sem vinculo, NAO invalida nada.
       and not exists (
         select 1 from public.acoes_desfazer ad
          where ad.movimentacao_id = m.id and ad.desfeito_em is not null)
     group by m.aluno_id
  ),
  -- POPULACAO: filtros que definem a base.
  pop as materialized (
    select a.id, b.anos, a.responsavel_atual_email as resp, a.data_retorno,
           a.data_ultimo_acionamento as dua, a.telefone, a.email,
           a.status_jornada, a.status_atual, a.status_acionamento, a.situacao_operacional, a.cpf
      from base b
      join public.alunos a on a.id = b.aluno_id
     where (v_anos is null or b.anos && v_anos)
       and (v_unid is null or a.unidade = any(v_unid))
       and (v_curso is null or a.curso = v_curso)
       and (v_sit is null or nullif(btrim(a.situacao_academica), '') = any(v_sit))
       and (v_matricula is null or (
         case when exists (
                select 1 from public.prime_contratos pc
                 where pc.cpf = lpad(regexp_replace(coalesce(a.cpf, ''), '\D', '', 'g'), 11, '0')
                   and pc.valid_from >= public.semestre_corrente_inicio()
                   and pc.status = 'Confirmado')
              then 'CONFIRMADA' else 'NAO_CONFIRMADA' end) = v_matricula)
       and (v_imp is null or exists (
         select 1 from public.acordos_titulos at3
          where at3.aluno_id = a.id and at3.importacao_id = any(v_imp)))
  ),
  cls as materialized (
    select p.*,
           c.v as valor_caso,
           mv.ult, mv.ult_mass,
           coalesce(mv.mes, false) as mes, coalesce(mv.hoje, false) as hoje,
           (tc.aluno_id is not null) as em_tc,
           coalesce(tc.tem_mensalidade, false) as tm,
           coalesce(tc.tem_acordo_vencido, false) as tav
      from pop p
      left join mov mv on mv.aluno_id = p.id::text
      left join tc on tc.aluno_id = p.id
      left join lateral (
        select c2.total_em_aberto as v
          from public.casos c2
         where c2.aluno_id = p.id
         order by (v_op not in ('todos', 'livres') and c2.operador_email is not distinct from v_op) desc,
                  c2.total_em_aberto desc nulls last
         limit 1
      ) c on true
  ),
  flags as (
    select k.*,
           (coalesce(k.status_jornada, '') in ('QUITADO', 'QUITADO_MANUAL')
            or coalesce(k.status_atual, '') in ('QUITADO', 'QUITADO_MANUAL')) as f_quit,
           (k.id in (select l.aluno_id from liq l)) as f_liq,
           (public.normalizar_status_acionamento(k.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
            or k.id::text in (select s.id from sol s)) as f_conf,
           (k.em_tc and public.acoes_massivas_tipo_cobranca_corresponde(v_tipo, k.tm, k.tav)) as f_tipo_ok,
           (k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,
           case when v_op = 'todos' then false
                when v_op = 'livres' then k.resp is not null
                else k.resp is distinct from v_op end as f_outro,
           (v_rec > 0 and k.ult_mass is not null
            and v_hoje < (k.ult_mass at time zone 'America/Sao_Paulo')::date + v_rec) as f_rec,
           (nullif(regexp_replace(coalesce(k.telefone, ''), '\D', '', 'g'), '') is not null) as f_tel,
           (btrim(coalesce(k.email, '')) <> '' and position('@' in btrim(k.email)) > 1) as f_mail,
           (coalesce(k.valor_caso, 0) < v_min
            or (v_max is not null and coalesce(k.valor_caso, 0) > v_max)) as f_val
      from cls k
  ),
  enc as (
    -- funcao pesada: so roda para quem ainda nao caiu em quitado/liquidado
    select z.*,
           case when z.f_quit or z.f_liq then false
                else public.caso_encerrado_operacional(z.cpf, z.status_atual, z.status_acionamento, null::text, z.status_jornada)
           end as f_enc,
           case when v_canal = 'WHATSAPP' then not z.f_tel
                when v_canal = 'EMAIL' then not z.f_mail
                else false end
           or (v_sem_tel and z.f_tel) as f_ctt
      from flags z
  ),
  cl as (
    select e.*,
           case when e.f_quit then 'quitado'
                when e.f_liq then 'liquidado_prime'
                when e.f_enc then 'encerrado_operacional'
                when e.f_conf then 'confirmacao_pendente'
                when not e.f_tipo_ok then 'fora_tipo_cobranca'
                when e.f_ret then 'retorno_futuro'
                when e.f_outro then 'outro_responsavel'
                when e.f_rec then 'acao_massiva_recente'
                when e.f_ctt then 'contato_indisponivel'
                when e.f_val then 'valor_fora_da_faixa'
           end as mot,
           case when e.f_quit then 'quitado'
                when e.f_liq then 'liquidado_prime'
                when e.f_enc then 'encerrado_operacional'
                when e.f_conf then 'confirmacao_pendente'
                when e.f_ret then 'retorno_futuro'
                when e.f_outro then 'outro_responsavel'
                when e.f_rec then 'acao_massiva_recente'
                when e.f_ctt then 'contato_indisponivel'
                when e.f_val then 'valor_fora_da_faixa'
           end as mot_st
      from enc e
  )
  select cl.id, cl.anos, cl.resp, coalesce(cl.valor_caso, 0), cl.ult, cl.ult_mass,
         cl.mes, cl.hoje, (cl.ult is null),
         cl.tm, cl.tav,
         (cl.resp is not null and cl.dua is not null and public.caso_dentro_prazo_fidelizacao(cl.dua::date)),
         cl.f_tel, cl.f_mail,
         (cl.mot is null), cl.mot, cl.mot_st
    from cl;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.semestre_corrente_inicio()
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when extract(month from current_date) <= 6
              then make_date(extract(year from current_date)::int, 1, 1)
              else make_date(extract(year from current_date)::int, 7, 1) end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.vencimento_do_pagamento(p_dados jsonb)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when coalesce(p_dados->>'vencimento','') ~ '^\d{4}-\d{2}-\d{2}' then (p_dados->>'vencimento')::date end
$function$
;

CREATE OR REPLACE FUNCTION public.documento_casa_com_parcela(p_parcela_id uuid, p_vencimento date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_vencimento is not null then abs(p.vencimento - p_vencimento) <= 3
    else not exists (
      select 1 from public.parcelas y
       where y.acordo_id = p.acordo_id and y.id <> p.id
         and upper(coalesce(y.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
         and y.vencimento < p.vencimento)
  end
  from public.parcelas p
  where p.id = p_parcela_id
$function$
;

CREATE OR REPLACE FUNCTION public.parcelas_amarrar_boleto()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
declare v_anc int := 0; v_limpos int := 0; v_limpos2 int := 0; v_desloc int := 0; v_legado int := 0;
begin
  -- Donos de cada prefixo de titulo (documento sem os 4 ultimos digitos), pelo
  -- Relatorio de Titulos em Aberto. E o unico vinculo aluno <-> documento
  -- aceito: numero do titulo, nunca nome.
  create temp table _tp on commit drop as
  select distinct left(ltrim(documento,'0'), length(ltrim(documento,'0'))-4) prefixo, aluno_id
    from public.acordos_titulos where documento ~ '^\d{8,}$' and aluno_id is not null;
  create index on _tp(prefixo);

  -- A. titulo tipo Acordo com vencimento -> parcela do mesmo aluno, mesmo
  --    vencimento (+-3 dias) e mesmo valor.
  create temp table _anc on commit drop as
  select distinct on (p.id) p.id parcela_id, p.acordo_id, ltrim(t.documento,'0') chave, 'titulo'::text origem
    from public.acordos_titulos t
    join public.acordos a on a.aluno_id = t.aluno_id and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
    join public.parcelas p on p.acordo_id = a.id and abs(p.vencimento - t.vencimento) <= 3
   where coalesce(t.tipo_boleto,'') = 'Acordo' and t.documento ~ '^\d{8,}$'
     and abs(p.valor - coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) <= 0.05
   order by p.id, abs(p.vencimento - t.vencimento);

  -- B. linha do extrato com vencimento -> parcela do acordo cujo aluno e dono
  --    do PREFIXO do documento (pelo titulo, ou por boleto confiavel do mesmo
  --    acordo). O nome do extrato nao entra: e o pagador, nao o dono.
  insert into _anc
  select distinct on (p.id) p.id, p.acordo_id, px.chave, 'pagamento'
    from public.pagamentos g
    cross join lateral (select ltrim(g.numero_parcela_completo,'0') chave,
                               left(ltrim(g.numero_parcela_completo,'0'), length(ltrim(g.numero_parcela_completo,'0'))-4) prefixo) px
    join public.acordos a on upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
         and (exists (select 1 from _tp t where t.prefixo = px.prefixo and t.aluno_id = a.aluno_id)
              or exists (select 1 from public.parcelas pc where pc.acordo_id = a.id and pc.boleto_confiavel and left(pc.boleto, length(pc.boleto)-4) = px.prefixo))
    join public.parcelas p on p.acordo_id = a.id and abs(p.vencimento - public.vencimento_do_pagamento(g.dados)) <= 3
   where public.vencimento_do_pagamento(g.dados) is not null
     and coalesce(g.numero_parcela_completo,'') ~ '^\d{8,}$'
     and g.valor_pago >= p.valor - 0.05 and g.valor_pago <= p.valor * 1.15
     and not exists (select 1 from _anc x where x.parcela_id = p.id)
   order by p.id, abs(p.vencimento - public.vencimento_do_pagamento(g.dados));

  delete from _anc x where (select count(*) from _anc y where y.chave = x.chave) > 1;

  update public.parcelas p set boleto = null, atualizado_em = now()
    from _anc x
   where x.chave = p.boleto and x.parcela_id <> p.id and not p.boleto_confiavel;
  get diagnostics v_limpos = row_count;

  with ofs as (
    select x.acordo_id, (right(x.chave,4))::int - p.numero as off
      from _anc x join public.parcelas p on p.id = x.parcela_id
  ), ofs_u as (
    select acordo_id, min(off) as off from ofs group by acordo_id having min(off) = max(off)
  )
  update public.parcelas p set boleto = null, atualizado_em = now()
    from ofs_u o
   where p.acordo_id = o.acordo_id and p.boleto is not null and not p.boleto_confiavel
     and p.boleto ~ '^\d{8,}$'
     and (right(p.boleto,4))::int - p.numero <> o.off;
  get diagnostics v_limpos2 = row_count;
  v_limpos := v_limpos + v_limpos2;

  update public.parcelas p
     set boleto = x.chave, boleto_confiavel = true, atualizado_em = now()
    from _anc x
   where p.id = x.parcela_id
     and (p.boleto is distinct from x.chave or not p.boleto_confiavel)
     and not exists (select 1 from public.parcelas z where z.boleto = x.chave and z.id <> p.id);
  get diagnostics v_anc = row_count;

  with conf as (
    select p.acordo_id, left(p.boleto, length(p.boleto) - 4) as prefixo, (right(p.boleto,4))::int - p.numero as off
      from public.parcelas p where p.boleto_confiavel and p.boleto ~ '^\d{8,}$'
  ), u as (
    select acordo_id, min(prefixo) as prefixo, min(off) as off
      from conf group by acordo_id
    having min(off) = max(off) and min(prefixo) = max(prefixo)
  ), alvo as (
    select p.id, u.prefixo || lpad((p.numero + u.off)::text, 4, '0') as chave
      from public.parcelas p join u on u.acordo_id = p.acordo_id
     where p.boleto is null and p.numero + u.off between 1 and 9999
  )
  update public.parcelas p
     set boleto = alvo.chave, boleto_confiavel = true, atualizado_em = now()
    from alvo
   where p.id = alvo.id
     and not exists (select 1 from public.parcelas z where z.boleto = alvo.chave);
  get diagnostics v_desloc = row_count;

  with tb as (
    select t.aluno_id, ltrim(t.documento,'0') chave, (right(t.documento,4))::int nr,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) valor
      from public.acordos_titulos t
     where coalesce(t.tipo_boleto,'') = 'Acordo' and t.documento ~ '^\d{8,}$'
  ), casado as (
    select distinct on (p.id) p.id parcela_id, tb.chave
      from tb join public.acordos a on a.aluno_id = tb.aluno_id
      join public.parcelas p on p.acordo_id = a.id and p.numero = tb.nr
     where abs(p.valor - tb.valor) <= 0.05 and p.boleto is null
       and not exists (select 1 from public.parcelas c where c.acordo_id = a.id and c.boleto_confiavel)
     order by p.id, abs(p.valor - tb.valor)
  ), unico as (
    select c.* from casado c
     where (select count(*) from casado c2 where c2.chave = c.chave) = 1
       and not exists (select 1 from public.parcelas p3 where p3.boleto = c.chave)
  )
  update public.parcelas p set boleto = u.chave, boleto_confiavel = false, atualizado_em = now()
    from unico u where p.id = u.parcela_id;
  get diagnostics v_legado = row_count;

  return jsonb_build_object(
    'ancoras_gravadas', v_anc,
    'legados_limpos', v_limpos,
    'por_deslocamento', v_desloc,
    'legado_por_sufixo', v_legado,
    'total_com_boleto', (select count(*) from public.parcelas where boleto is not null),
    'total_confiavel', (select count(*) from public.parcelas where boleto_confiavel),
    'sem_boleto', (select count(*) from public.parcelas where boleto is null));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.conciliacao_reprocessar(p_aplicar boolean DEFAULT true, p_limite integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_r jsonb; v_res jsonb := '{}'::jsonb; v_n int := 0; v_baixou int := 0;
  v_conta jsonb := '{}'::jsonb; v_st text;
begin
  for v_id in
    select p.id
      from public.pagamentos p
     -- A FRONTEIRA. status_conciliacao NULL = entrou antes de 14/09/2026:
     -- invisivel para o motor automatico, por decisao. Nao reclassifica, nao
     -- baixa, nao enfileira.
     where p.status_conciliacao is not null
       and p.status_conciliacao <> 'BAIXADO'
       -- o que a gestao ja decidiu nao volta sozinho para a fila
       and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                        where f.pagamento_id = p.id and f.decisao is not null)
     order by p.data_pagamento, p.id
     limit greatest(coalesce(p_limite, 5000), 0)
  loop
    v_r := public.pagamento_conciliar_um(v_id, p_aplicar);
    v_n := v_n + 1;
    v_st := coalesce(v_r->>'status','?');
    v_conta := jsonb_set(v_conta, array[v_st],
                         to_jsonb(coalesce((v_conta->>v_st)::int, 0) + 1), true);
    if coalesce((v_r->>'baixou')::boolean, false) then v_baixou := v_baixou + 1; end if;
  end loop;

  v_res := jsonb_build_object('modo', case when p_aplicar then 'aplicado' else 'previa' end,
                              'avaliados', v_n, 'baixados', v_baixou, 'por_status', v_conta);

  -- CAMINHO B, AUTOMATICO. So no modo aplicado, e so depois de o motor ter feito
  -- o que dava para fazer localmente: o que sobrou em AGUARDANDO_ACORDO sem
  -- evidencia e sem linha no espelho vai para consulta pontual ao Prime.
  -- Aqui e seguro: esta funcao roda pela rodada horaria, nunca pelo gatilho.
  if p_aplicar then
    begin
      v_res := v_res || jsonb_build_object('consulta_portador',
                 public.conciliacao_consultar_portador_pendentes(5));
    exception when others then
      -- o disparo e efeito colateral: falhar aqui nao pode derrubar a conciliacao
      v_res := v_res || jsonb_build_object('consulta_portador',
                 jsonb_build_object('erro', SQLERRM));
    end;
  end if;

  return v_res;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.conciliacao_consultar_portador_pendentes(p_limite integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_url text; v_token text; v_req bigint; v_carga jsonb;
  v_n int := 0; v_casos jsonb := '[]'::jsonb; r record;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Consulta pontual ao portador e da gestao ou da rotina.' using errcode = '42501';
  end if;

  -- PAUSA DE NEGOCIO (15/09/2026). A gestao nao considera o ciclo concluido
  -- enquanto o CRM nao souber o que foi negociado no acordo: valor original,
  -- desconto, encargos, entrada, parcelas, vencimentos, saldo. Ate la, o
  -- caminho automatico novo fica desligado.
  --
  -- ESTA SAIDA VEM ANTES DE TUDO QUE ESCREVE OU SAI DA CASA: antes do disjuntor
  -- de carga, antes do carimbo de `consulta_portador_em`, antes do net.http_post
  -- e antes de qualquer chamada a Edge. Pausado, este disparador nao tem efeito
  -- colateral nenhum.
  --
  -- E A PAUSA E UM DADO, NAO CODIGO: `fluxo_pagamentos_config.consulta_portador`
  -- e a mesma mecanica de etapa que `fluxo_pagamentos_rodar` ja usa desde
  -- sempre. Religar e um UPDATE -- e exige autorizacao expressa da gestao.
  if not coalesce((select ligado from public.fluxo_pagamentos_config
                    where etapa = 'consulta_portador'), false) then
    return jsonb_build_object('pulou', 'PAUSADO_PARA_MAPEAMENTO_DE_ACORDOS');
  end if;

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    return jsonb_build_object('pulou', 'sistema sob carga');
  end if;

  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'prime_cadastro_token';
  if v_url is null or v_token is null then
    return jsonb_build_object('pulou', 'segredo ausente no Vault');
  end if;

  for r in
    select p.id,
           coalesce(nullif(p.matricula,''), f.matricula_recebida) as registration,
           p.titulo_numero
      from public.pagamentos p
      join public.fila_pagamento_sem_vinculo f
        on f.pagamento_id = p.id and f.decisao is null
     where (
             -- a pendencia de sempre
             (p.status_conciliacao = 'AGUARDANDO_ACORDO' and f.evidencia_origem is null)
             -- SEGUNDA CHANCE, CURTA E QUE FECHA SOZINHA.
             --
             -- `ACORDO_CONFIRMADO_SEM_ESTRUTURA` afirma que houve negociacao --
             -- e isso continua verdade. Mas o extrato da Prime pode passar a
             -- mostrar o titulo-mae liquidado depois, e ai existe resposta
             -- melhor. Sem esta janela o caso ficaria congelado para sempre.
             --
             -- O QUE O CODIGO GARANTE, e so isso: janela FINITA de 72h a
             -- partir de `conciliacao_em`, que agora so anda quando o ESTADO
             -- muda, mais no maximo UMA tentativa por 24h por caso. Em +72h a
             -- janela fecha e o caso para de ser consultado, para sempre.
             --
             -- No fluxo automatico normal isso produz DUAS reconsultas (~+24h e
             -- ~+48h), porque a confirmacao vem logo depois de um disparo e
             -- `consulta_portador_em` esta fresca. Mas nao e invariante: num
             -- caminho excepcional -- `consulta_portador_em` nula ou antiga,
             -- por confirmacao vinda da rodada em lote e nao do disparador --
             -- cabe uma tentativa adicional imediata. O limite continua sendo o
             -- relogio, nao uma contagem, e de proposito: contar exigiria
             -- coluna nova para um ganho que a janela ja entrega.
             --
             -- Nao exige `evidencia_origem is null` aqui: um caso confirmado TEM
             -- evidencia -- e essa e justamente a condicao que o traz de volta.
             or (p.status_conciliacao = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA'
                 and p.conciliacao_em > now() - interval '72 hours')
           )
       -- NAO exclui quem ja tem linha local do 166. O espelho prova negociacao,
       -- nao ausencia de estrutura -- e a tentativa oficial precisa acontecer
       -- antes do fallback. O teto de uma por dia por caso e que segura o volume.
       and coalesce(nullif(p.matricula,''), f.matricula_recebida) ~ '^\d{6,12}$'
       and (f.consulta_portador_em is null
            or f.consulta_portador_em < now() - interval '24 hours')
     order by p.data_pagamento, p.id
     limit greatest(coalesce(p_limite, 5), 0)
  loop
    -- A marca vem ANTES: se a chamada falhar, o caso nao volta na proxima hora.
    -- E SO ISSO que ela significa -- frequencia, uma tentativa por dia por caso.
    -- Nao e resultado: quem responde "o que a API disse" e
    -- `consulta_estrutura_resultado`, gravado pela Edge DEPOIS da chamada.
    update public.fila_pagamento_sem_vinculo
       set consulta_portador_em = now()
     where pagamento_id = r.id;

    select net.http_post(
      url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
      headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
      body := jsonb_build_object('registration', r.registration, 'pagamento_id', r.id,
                                 'titulo_numero', r.titulo_numero),
      timeout_milliseconds := 60000) into v_req;

    v_n := v_n + 1;
    v_casos := v_casos || jsonb_build_object('pagamento_id', r.id,
                            'registration', r.registration, 'requisicao', v_req);
  end loop;

  return jsonb_build_object('disparados', v_n, 'limite', p_limite, 'casos', v_casos);
end;
$function$
;

CREATE OR REPLACE FUNCTION public._trg_recalc_por_aluno_text()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_aluno uuid;
begin
  begin
    v_aluno := nullif(coalesce(NEW.aluno_id, OLD.aluno_id),'')::uuid;
    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, TG_ARGV[0]); end if;
  exception when others then null;
  end;
  return null;
end; $function$
;

CREATE OR REPLACE FUNCTION public.devolver_operador_ao_rejeitar_confirmacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if upper(coalesce(NEW.status,'')) = 'PAGAMENTO_REJEITADO'
     and upper(coalesce(OLD.status,'')) is distinct from 'PAGAMENTO_REJEITADO'
     and NEW.aluno_id is not null then

    -- 1) devolve o dono anterior (comportamento que ja existia)
    update public.casos c
       set operador_email = m.operador_email,
           operador_nome  = m.operador_nome,
           operador       = coalesce(m.operador_upper, upper(m.operador_nome))
      from public.calibragem_dono_anterior_confirmacao m
     where m.aluno_id = NEW.aluno_id::text
       and c.aluno_id::text = NEW.aluno_id::text
       and c.operador_email is null;

    delete from public.calibragem_dono_anterior_confirmacao where aluno_id = NEW.aluno_id::text;

    -- 2) devolve o STATUS: sem isso o aluno fica preso em AGUARDANDO_BAIXA e o
    --    caso nunca reaparece na fila. So mexe em quem esta nesse estado de
    --    espera -- nao pisa em quitado, juridico, suspensao ou cancelamento.
    update public.alunos al
       set status_atual   = 'CONTATAR',
           status_jornada = 'CONTATAR'
     where al.id = NEW.aluno_id::uuid
       and upper(coalesce(al.status_atual,'')) in ('AGUARDANDO_BAIXA','BAIXA_REALIZADA');
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_conf_pagamento_agenda()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aluno uuid;
  v_pendente boolean;
begin
  begin
    v_aluno := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  v_pendente := new.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');

  if v_pendente then
    update public.alunos
       set retorno_origem = 'OPERADOR_EM_CONFIRMACAO'
     where id = v_aluno
       and retorno_origem = 'OPERADOR';
  else
    update public.alunos
       set retorno_origem = 'OPERADOR'
     where id = v_aluno
       and retorno_origem = 'OPERADOR_EM_CONFIRMACAO'
       and not exists (
         select 1 from public.solicitacoes_confirmacao_pagamento s
          where s.aluno_id = new.aluno_id
            and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'));
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._confirmacao_sem_valor_sai_da_fila()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin
    if new.status not in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO') then
      return null;
    end if;

    -- 1) Sem valor informado: nao ha o que conferir.
    if coalesce(new.valor_informado, 0) <= 0.005 then
      update public.solicitacoes_confirmacao_pagamento
         set status = 'ENCERRADO_SEM_VALOR',
             observacao_adm = coalesce(nullif(btrim(observacao_adm),''),
               'Fechada automaticamente: sem valor informado, nao ha o que conferir. O aluno segue na cobranca normalmente.'),
             atualizado_em = now()
       where id = new.id
         and status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');
      return null;
    end if;

    -- 2) Tem valor, mas o aluno nao deve nada. O pagamento existiu; a divida,
    --    nao existe mais. Conferir o que ja esta zerado e retrabalho puro.
    if upper(coalesce(new.origem_divida,'')) = 'SEM_SALDO' then
      update public.solicitacoes_confirmacao_pagamento
         set status = 'CONCLUIDA_SALDO_ZERO',
             observacao_adm = coalesce(nullif(btrim(observacao_adm),''),
               'Fechada automaticamente: o aluno nao tem saldo em aberto. Nao ha divida para conferir.'),
             confirmado_em = coalesce(confirmado_em, now()),
             atualizado_em = now()
       where id = new.id
         and status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');
      return null;
    end if;
  exception when others then
    return null;
  end;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.pagamento_conciliar_um(p_pagamento_id uuid, p_aplicar boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pag record; v_parcela record;
  v_chave text; v_venc date; v_pref text;
  v_status text; v_motivo text;
  v_acordos int := 0; v_livres int := 0;
  v_cand int := 0; v_cand_id uuid;
  -- `v_parcela` pode nunca ser atribuida (linha sem boleto): ler `v_parcela.id`
  -- nesse caso levanta "record is not assigned yet". Estes dois guardam o
  -- resultado e sao nulos quando nao houve parcela.
  v_parcela_id uuid; v_acordo_id uuid;
  v_baixou boolean := false;
  v_evid jsonb := '{}'::jsonb;
  v_sug jsonb := '[]'::jsonb; v_arq text;
  v_origem text; v_origem_em timestamptz; v_quem text; v_dup int := 0;
  -- releitura da parcela DEPOIS do lock, antes de escrever
  v_re_status text; v_re_ref text;
  -- evidencia do portador 166 (negociacao comprovada, sem estrutura de acordo)
  v_cpf_pag text; v_ev_origem text; v_ev_em timestamptz;
  -- concordancia entre o numero do acordo do arquivo e o prefixo do boleto
  v_tit text; v_acordo_do_boleto text; v_concorda boolean; v_estrutura text;
begin
  select * into v_pag from public.pagamentos where id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO');
  end if;

  v_chave := ltrim(coalesce(v_pag.numero_parcela_completo,''),'0');
  v_venc  := public.vencimento_do_pagamento(v_pag.dados);

  -- ESTADO TERMINAL, ANTES DE QUALQUER RECLASSIFICACAO.
  -- O titulo original ja foi concluido pela liquidacao oficial na Prime. Nada
  -- que este motor saiba olhar -- parcela, acordo, portador -- pode desfazer
  -- isso, e reclassificar so devolveria o pagamento para uma pendencia que ja
  -- tem resposta. Sai aqui, sem escrever.
  if coalesce(v_pag.status_conciliacao,'') = 'TITULO_ORIGINAL_LIQUIDADO' then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'status', 'TITULO_ORIGINAL_LIQUIDADO', 'aplicou', false,
      'motivo', 'estado terminal: o titulo original ja foi concluido pela liquidacao oficial na Prime');
  end if;

  if v_chave = '' then
    v_status := 'SEM_VINCULO';
    v_motivo := 'a linha do arquivo nao trouxe numero de boleto';
  else
    select p.id, p.valor, p.status, p.honorarios, p.acordo_id, p.vencimento, p.numero,
           p.boleto_confiavel, p.origem_baixa, p.origem_baixa_ref, p.origem_baixa_em,
           p.confirmado_por_email,
           a.aluno_id, a.status status_acordo
      into v_parcela
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where p.boleto = v_chave limit 1;

    v_parcela_id := v_parcela.id;
    v_acordo_id  := v_parcela.acordo_id;

    if v_parcela_id is null then
      -- Sem parcela com esse boleto. A classificacao abaixo e SOMENTE LEITURA e
      -- nao autoriza baixa nenhuma: diz o que falta, o acordo ou a amarracao.
      if length(coalesce(v_pag.numero_parcela_completo,'')) = 11 then
        v_pref := substring(v_pag.numero_parcela_completo, 2, 6);

        select count(*) into v_acordos
          from public.acordos a
         where a.numero_ulbra is not null
           and lpad(a.numero_ulbra, 6, '0') = v_pref
           and upper(coalesce(a.status,'')) <> 'CANCELADO';

        select count(*) into v_livres
          from public.acordos a join public.parcelas p on p.acordo_id = a.id
         where a.numero_ulbra is not null
           and lpad(a.numero_ulbra, 6, '0') = v_pref
           and upper(coalesce(a.status,'')) <> 'CANCELADO'
           and p.boleto is null
           and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA');

        if v_acordos = 0 then
          -- O acordo nao esta no CRM. Isso NAO significa que nao houve negociacao:
          -- o Relatorio de Titulos em Aberto so traz acordo COM titulo em aberto, e
          -- quem pagou some dele para sempre. A prova de que houve negociacao vem de
          -- fora: no Prime, o debito negociado migra do portador 195 (mensalidade em
          -- cobranca) para o 166 (SANTANDER REATIVA - CONVENIO 272047). Estar no 166
          -- e evidencia objetiva de acordo -- regra da gestao, e ja e o que o
          -- cabecalho de `prime-portador` documenta desde 24/08/2026.
          v_cpf_pag := nullif(regexp_replace(coalesce(v_pag.cpf,''), '\D', '', 'g'), '');

          -- CONCORDANCIA SANTANDER. O arquivo traz o numero do acordo DUAS vezes:
          -- na coluna C (`titulo_numero`) e dentro do boleto (posicoes 2 a 7).
          -- Medido em 14/09: batem em 13 de 13 divergentes. Promover sem essa
          -- concordancia seria confirmar negociacao a partir de UMA leitura so --
          -- e a regra da casa e nunca decidir com uma variavel unica.
          -- O sufixo do boleto continua sem significado: nao e numero de parcela.
          v_acordo_do_boleto := ltrim(v_pref, '0');
          v_tit := nullif(ltrim(regexp_replace(coalesce(v_pag.titulo_numero,''), '\D', '', 'g'), '0'), '');
          v_concorda := (v_tit is not null and v_tit = v_acordo_do_boleto);

          -- O FALLBACK E FALLBACK, E DEPENDE DO RESULTADO -- NAO DA TENTATIVA.
          -- Estar no portador 166 prova que houve negociacao; nao prova que a
          -- estrutura nao existe. E "tentei" nao e resposta: so
          -- NAO_ENCONTRADA -- /agreements respondeu JSON valido e veio vazio --
          -- autoriza dizer "sem estrutura". ENCONTRADA significa que ha
          -- estrutura e ela ainda nao foi capturada; ERRO significa que nao se
          -- sabe; NULL, que ninguem perguntou. Nenhum dos tres promove.
          select f.consulta_estrutura_resultado into v_estrutura
            from public.fila_pagamento_sem_vinculo f
           where f.pagamento_id = p_pagamento_id;

          if coalesce(v_pag.status_conciliacao,'') = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA' then
            -- IDEMPOTENCIA. Uma vez confirmado, nao volta para AGUARDANDO_ACORDO.
            -- O espelho do portador expira por ciclo (`prime-portador` apaga quem nao
            -- foi recarimbado na varredura). Sem esta parada, a confirmacao de hoje
            -- viraria pendencia de novo no sabado que vem -- e a evidencia ja gravada
            -- seria perdida. So se move para frente: quando o acordo aparecer.
            v_status := 'ACORDO_CONFIRMADO_SEM_ESTRUTURA';
            v_motivo := 'negociacao comprovada pelo portador 166; o acordo ' || v_pref
              || ' ainda nao entrou no CRM. Sem estrutura: nenhum acordo ou parcela foi criado.';

          elsif v_cpf_pag is not null
            and exists (select 1 from public.prime_portador_membro m
                         where lpad(m.cpf,11,'0') = lpad(v_cpf_pag,11,'0') and m.portador = 166)
            and coalesce(v_estrutura,'') = 'NAO_ENCONTRADA' then

            if not v_concorda then
              -- Evidencia positiva de negociacao, mas o arquivo se contradiz. Nao se
              -- confirma acordo cujo numero o proprio arquivo discorda -- vai para
              -- conferencia humana, sem inferir qual dos dois esta certo.
              v_status := 'REVISAO';
              v_motivo := 'o aluno esta no portador 166 (negociacao comprovada), mas o'
                || ' numero do acordo nao concorda no arquivo: titulo_numero '
                || coalesce(nullif(v_pag.titulo_numero,''),'(ausente)')
                || ' x prefixo do boleto ' || v_acordo_do_boleto
                || '. Nao confirmado -- conferir qual e o acordo.';
            else
              select max(m.coletado_em) into v_ev_em
                from public.prime_portador_membro m
               where lpad(m.cpf,11,'0') = lpad(v_cpf_pag,11,'0') and m.portador = 166;
              v_ev_origem := 'PRIME_PORTADOR_MEMBRO';
              v_status := 'ACORDO_CONFIRMADO_SEM_ESTRUTURA';
              v_motivo := 'negociacao comprovada: o aluno esta no portador 166 (SANTANDER'
                || ' REATIVA) desde ' || coalesce(to_char(v_ev_em,'DD/MM/YYYY'),'?')
                || '; o numero do acordo ' || v_acordo_do_boleto || ' concorda entre a'
                || ' coluna de titulo e o prefixo do boleto. O acordo ainda nao entrou no'
                || ' CRM, e nenhum acordo ou parcela foi criado a partir desta evidencia.';
            end if;

          else
            -- AUSENCIA NAO E PROVA NEGATIVA. Nao estar no espelho do 166 nao diz que
            -- nao houve negociacao -- diz que aqui nao temos como afirmar. A confirmacao
            -- ao vivo (caminho B) e quem pode promover este caso; ate la, fica pendente.
            v_status := 'AGUARDANDO_ACORDO';
            v_motivo := 'boleto ' || v_pag.numero_parcela_completo
              || ' nao existe em parcelas e o acordo ' || v_pref || ' nao esta no CRM'
              || case when v_cpf_pag is null
                      then ' | sem CPF no pagamento: identidade precisa ser resolvida antes'
                      when coalesce(v_estrutura,'') = 'ENCONTRADA'
                      then ' | a API oficial DEVOLVEU estrutura para este acordo: a captura ainda nao existe, e o payload esta em auditoria'
                      when coalesce(v_estrutura,'') = 'ERRO'
                      then ' | a consulta a API oficial falhou -- sera repetida na proxima janela de 24h'
                      when v_estrutura is null
                      then ' | a API oficial ainda nao foi consultada para este caso -- a rodada horaria consulta'
                      else ' | sem evidencia local do portador 166 -- inconclusivo, nao e prova de que nao houve acordo' end;
          end if;
        elsif v_livres > 0 then
          v_status := 'AGUARDANDO_AMARRACAO';
          v_motivo := 'o acordo ' || v_pref || ' esta no CRM com ' || v_livres
            || ' parcela(s) sem boleto: falta amarrar o boleto '
            || v_pag.numero_parcela_completo || ' a parcela certa';
        else
          v_status := 'REVISAO';
          v_motivo := 'o acordo ' || v_pref
            || ' esta no CRM e nao tem parcela livre para receber o boleto '
            || v_pag.numero_parcela_completo;
        end if;
      else
        v_status := 'SEM_VINCULO';
        v_motivo := 'boleto fora do padrao de 11 digitos: ' || v_pag.numero_parcela_completo;
      end if;

    -- TRAVA DE IDEMPOTENCIA. Antes de qualquer outra coisa: esta parcela ja foi
    -- baixada POR ESTE pagamento? Entao o trabalho ja esta feito. Sem esta
    -- checagem, reprocessar confundiria a propria baixa com a de um terceiro e
    -- devolveria PARCELA_JA_PAGA -- pendencia falsa que nunca mais sai.
    elsif upper(coalesce(v_parcela.status,'')) = 'PAGO'
      and coalesce(v_parcela.origem_baixa_ref,'') = p_pagamento_id::text then
      v_status := 'BAIXADO';
      v_motivo := null;

    elsif v_parcela.status = 'PAGO' then
      -- Baixa anterior, de outra origem. NUNCA uma segunda baixa. A evidencia e
      -- computada aqui para a tela mostrar origem, data e responsavel.
      select b.baixado_por_email, b.baixado_em
        into v_quem, v_origem_em
        from public.baixas_pagamento b
       where b.parcela_id = v_parcela.id and b.devolvido_em is null
       order by b.baixado_em desc nulls last limit 1;

      v_origem := coalesce(v_parcela.origem_baixa,
                           case when v_quem is not null then 'BAIXA_REGISTRADA' end);
      v_quem   := coalesce(v_quem, v_parcela.origem_baixa_ref, v_parcela.confirmado_por_email);
      v_origem_em := coalesce(v_origem_em, v_parcela.origem_baixa_em);

      select count(*) into v_dup
        from public.pagamentos g
       where g.numero_parcela_completo = v_pag.numero_parcela_completo
         and g.id <> v_pag.id
         and round(coalesce(g.valor_pago,0),2) = round(coalesce(v_pag.valor_pago,0),2)
         and coalesce(g.retroativo,false) = false;

      v_evid := jsonb_build_object(
        'tem_evidencia', v_origem is not null,
        'origem', v_origem, 'responsavel', v_quem, 'quando', v_origem_em,
        'pagamentos_iguais_na_base', v_dup);

      v_status := 'PARCELA_JA_PAGA';
      v_motivo := 'a parcela ' || coalesce(v_parcela.numero::text,'?') || ' do boleto '
        || v_chave || ' ja estava PAGO antes deste pagamento entrar'
        || case when v_origem is not null
                then ': baixa anterior ' || v_origem
                     || coalesce(' por ' || v_quem, '')
                     || coalesce(' em ' || to_char(v_origem_em,'DD/MM/YYYY'), '')
                else ': nao ha registro de quem baixou' end
        || case when v_dup > 0
                then ' | ATENCAO: ha ' || v_dup || ' outro(s) pagamento(s) com o mesmo boleto e o mesmo valor'
                else '' end;

    elsif upper(coalesce(v_parcela.status_acordo,'')) <> 'ATIVO' then
      v_status := 'REVISAO';
      v_motivo := 'o acordo do boleto ' || v_chave || ' esta '
        || upper(coalesce(v_parcela.status_acordo,'(sem status)')) || ', nao ATIVO';

    elsif v_pag.valor_pago < v_parcela.valor - 0.05
       or v_pag.valor_pago > v_parcela.valor * 1.15 then
      v_status := 'REVISAO';
      v_motivo := 'valor pago ' || to_char(v_pag.valor_pago,'FM999G999G990D00')
        || ' fora da faixa aceita para a parcela de '
        || to_char(v_parcela.valor,'FM999G999G990D00')
        || ' (de -R$ 0,05 ate +15%)';

    elsif not public.documento_casa_com_parcela(v_parcela.id, v_venc) then
      if p_aplicar then
        insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
        values ('rotina', 'BAIXA_DOCUMENTO_RECUSADA', 'parcelas', v_parcela.id,
                jsonb_build_object('pagamento_id', v_pag.id, 'documento', v_chave,
                                   'vencimento_extrato', v_venc, 'parcela_numero', v_parcela.numero,
                                   'parcela_vencimento', v_parcela.vencimento, 'valor_pago', v_pag.valor_pago,
                                   'motivo', case when v_venc is not null then 'vencimento do extrato nao bate com a parcela do boleto'
                                                  else 'ha parcela mais antiga em aberto no acordo' end));
      end if;
      v_status := 'REVISAO';
      v_motivo := case when v_venc is not null
        then 'vencimento do arquivo (' || to_char(v_venc,'DD/MM/YYYY')
             || ') nao bate com a parcela ' || coalesce(v_parcela.numero::text,'?')
             || ' do boleto, que vence ' || to_char(v_parcela.vencimento,'DD/MM/YYYY')
        else 'ha parcela mais antiga em aberto no acordo: o boleto ' || v_chave
             || ' nao pode baixar a parcela ' || coalesce(v_parcela.numero::text,'?') end;

    elsif not coalesce(v_parcela.boleto_confiavel, false) then
      -- AMARRACAO FRACA. O boleto veio do fallback legado por numero/sufixo, que
      -- acertou 5.969 de 10.924 parcelas quando foi medido em 08/09 -- nao e
      -- prova. Aqui a prova tem de vir de fora: entre as parcelas do MESMO
      -- acordo, exatamente UMA pode ser compativel com o que o Santander diz, e
      -- ela tem de ser justamente esta. Se o arquivo nao traz vencimento,
      -- nenhuma candidata qualifica e o caso cai em REVISAO -- que e o certo:
      -- sufixo sem data nao decide nada.
      select count(*), min(c.id::text)::uuid
        into v_cand, v_cand_id
        from public.parcelas c
       where c.acordo_id = v_parcela.acordo_id
         and upper(coalesce(c.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
         and v_venc is not null
         and abs(c.vencimento - v_venc) <= 3
         and v_pag.valor_pago >= c.valor - 0.05
         and v_pag.valor_pago <= c.valor * 1.15;

      if v_cand = 1 and v_cand_id = v_parcela.id then
        v_status := 'BAIXA';
      else
        v_status := 'REVISAO';
        v_motivo := 'o boleto ' || v_chave || ' foi amarrado pela regra legada de sufixo'
          || ' (boleto_confiavel = false) e '
          || case when v_cand = 0 then 'nenhuma parcela do acordo bate com o vencimento e o valor do Santander'
                  when v_cand > 1 then v_cand || ' parcelas do acordo batem: ambiguo por desenho'
                  else 'a parcela compativel e outra, nao a que esta com o boleto' end
          || '. Amarracao fraca nao baixa sozinha.';
      end if;

    else
      v_status := 'BAIXA';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- A PARTIR DAQUI, ESCRITA. Em previa (`p_aplicar => false`) nada disto roda.
  -- -------------------------------------------------------------------------
  if v_status = 'BAIXA' then
    if not p_aplicar then
      return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
        'status', 'BAIXADO', 'motivo', null, 'parcela_id', v_parcela_id,
        'acordo_id', v_acordo_id, 'aplicou', false, 'baixou', false,
        'boleto_confiavel', coalesce(v_parcela.boleto_confiavel,false));
    end if;

    -- O LOCK, E A RELEITURA DEPOIS DELE. A decisao acima foi tomada com a foto
    -- de ANTES do lock: duas transacoes podem ter decidido BAIXA ao mesmo tempo.
    -- Quem entra primeiro baixa; quem entra depois TEM de reler a parcela ja
    -- dentro do lock. Sem isso, o segundo sobrescreveria a baixa do primeiro, ou
    -- -- pior -- marcaria BAIXADO sem ter escrito nada.
    perform pg_advisory_xact_lock(hashtextextended(v_parcela_id::text, 0));

    select upper(coalesce(p.status,'')), coalesce(p.origem_baixa_ref,'')
      into v_re_status, v_re_ref
      from public.parcelas p
     where p.id = v_parcela_id;

    if v_re_status = 'PAGO' then
      if v_re_ref = p_pagamento_id::text then
        -- Fui eu mesmo, nesta ou noutra transacao. Nada a escrever.
        v_status := 'BAIXADO';
        v_motivo := null;
      else
        -- Outro pagamento chegou primeiro. NUNCA uma segunda baixa, e NAO fecha
        -- sozinho: vai para conferencia humana como qualquer PARCELA_JA_PAGA.
        v_status := 'PARCELA_JA_PAGA';
        v_motivo := 'a parcela ' || coalesce(v_parcela.numero::text,'?') || ' do boleto '
          || v_chave || ' foi baixada por outro pagamento entre a decisao e a escrita'
          || case when v_re_ref <> '' then ' (referencia ' || v_re_ref || ')' else '' end
          || '. Nenhuma segunda baixa foi feita.';
        v_evid := jsonb_build_object('tem_evidencia', v_re_ref <> '',
                                     'origem', 'CORRIDA_NA_BAIXA',
                                     'responsavel', nullif(v_re_ref,''), 'quando', now());
      end if;
    else
      update public.parcelas
         set status = 'PAGO', pago_em = v_pag.data_pagamento,
             confirmado_por_email = coalesce(v_pag.operador_email,'extrato_santander'),
             origem_baixa = 'GATILHO_IMPORTACAO',
             origem_baixa_ref = v_pag.id::text,
             origem_baixa_em = now(),
             honorarios = case when coalesce(honorarios,0) = 0 and coalesce(v_pag.valor_honorario,0) > 0
                               then v_pag.valor_honorario else honorarios end,
             observacao = coalesce(observacao,'')
               || case when coalesce(observacao,'') = '' then '' else ' | ' end
               || 'baixa automatica na importacao: documento ' || v_chave
               || ' pago em ' || to_char(v_pag.data_pagamento,'DD/MM/YYYY')
               || case when v_venc is not null then ' (vencimento ' || to_char(v_venc,'DD/MM/YYYY') || ' conferido)' else '' end,
             atualizado_em = now()
       where id = v_parcela_id
         and upper(coalesce(status,'')) <> 'PAGO';

      if found then
        v_baixou := true;
        perform public.recalcular_situacao_aluno(v_parcela.aluno_id);
        v_status := 'BAIXADO';
        v_motivo := null;
      else
        -- Zero linhas com o lock na mao e estado inesperado. O que NAO se pode
        -- fazer e chamar isso de BAIXADO: nada foi escrito.
        v_status := 'PARCELA_JA_PAGA';
        v_motivo := 'o UPDATE da baixa nao alterou nenhuma linha mesmo com o lock da'
          || ' parcela ' || v_parcela_id::text || ': estado inesperado, nada foi escrito.';
      end if;
    end if;
  end if;

  if not p_aplicar then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'status', v_status, 'motivo', v_motivo,
      'parcela_id', v_parcela_id, 'acordo_id', v_acordo_id,
      'aplicou', false, 'baixou', false, 'evidencia', v_evid);
  end if;

  -- `conciliacao_em` SO ANDA QUANDO O ESTADO MUDA.
  --
  -- Antes gravava now() em toda escrita, e a rodada horaria reescreve o mesmo
  -- estado -- entao a coluna deslizava de hora em hora e nao cumpria o proprio
  -- comentario ("Quando a conciliacao foi decidida"). Ninguem a le hoje (nem
  -- tela nem funcao), e o segundo fim disto e dar ao disparador uma ancora
  -- estavel para a janela de segunda chance: sem ela, a janela nunca fecharia.
  update public.pagamentos
     set status_conciliacao = v_status,
         conciliacao_motivo = v_motivo,
         conciliacao_em     = case
           when status_conciliacao is distinct from v_status then now()
           else coalesce(conciliacao_em, now()) end
   where id = p_pagamento_id;

  if v_status = 'BAIXADO' then
    update public.fila_pagamento_sem_vinculo
       set decisao = 'RESOLVIDO_AUTOMATICO',
           decidido_por = 'conciliacao@sistema',
           decidido_em = now(),
           status_conciliacao = 'BAIXADO',
           observacao = coalesce(observacao,'')
             || case when coalesce(observacao,'') = '' then '' else ' | ' end
             || 'baixado automaticamente pela conciliacao'
     where pagamento_id = p_pagamento_id and decisao is null;

    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'status', v_status, 'motivo', null, 'parcela_id', v_parcela_id,
      'acordo_id', v_acordo_id, 'aplicou', true, 'baixou', v_baixou);
  end if;

  -- Pendente. Sugestoes por nome so quando o aluno ainda e desconhecido -- e
  -- continuam sendo SUGESTAO, nunca aplicadas.
  if v_pag.aluno_id is null and coalesce(trim(v_pag.aluno_nome),'') <> '' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'aluno_id', a.id, 'nome', a.nome, 'cpf_mascarado', a.cpf_mascarado,
             'matricula', a.matricula, 'tem_acordo_ativo',
             exists (select 1 from public.acordos ac where ac.aluno_id = a.id and ac.status='ATIVO'))), '[]'::jsonb)
      into v_sug
      from public.alunos a
     where coalesce(trim(a.nome),'') <> ''
       and translate(upper(regexp_replace(trim(a.nome), '\s+', ' ', 'g')),
                     'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
         = translate(upper(regexp_replace(trim(v_pag.aluno_nome), '\s+', ' ', 'g')),
                     'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC');
  end if;

  select i.arquivo_nome into v_arq from public.importacoes i where i.id = v_pag.importacao_id;

  insert into public.fila_pagamento_sem_vinculo
    (pagamento_id, importacao_id, arquivo_nome, boleto, data_pagamento, valor_pago,
     valor_honorario, nome_recebido, cpf_recebido, matricula_recebida, sugestoes,
     motivo, status_conciliacao, evidencia_origem, evidencia_em)
  values (v_pag.id, v_pag.importacao_id, v_arq, v_pag.numero_parcela_completo, v_pag.data_pagamento,
          v_pag.valor_pago, v_pag.valor_honorario, v_pag.aluno_nome, v_pag.cpf, v_pag.matricula, v_sug,
          v_motivo || case when jsonb_array_length(v_sug) > 0
                           then ' | ' || jsonb_array_length(v_sug)::text || ' sugestao(oes) por nome, para conferencia humana'
                           else '' end,
          v_status, v_ev_origem, v_ev_em)
  on conflict (pagamento_id) do update
     set status_conciliacao = excluded.status_conciliacao,
         motivo = excluded.motivo,
         boleto = excluded.boleto,
         valor_pago = excluded.valor_pago,
         valor_honorario = excluded.valor_honorario,
         -- PRECEDENCIA DA EVIDENCIA. A confirmacao ao vivo grava a linha no espelho
         -- ANTES de chamar o motor -- entao, na rodada seguinte, o motor acharia a
         -- linha e rebaixaria a proveniencia de PRIME_API_LIVE para
         -- PRIME_PORTADOR_MEMBRO, perdendo a informacao de que alguem confirmou
         -- pontualmente. LIVE e a origem mais forte e nunca e trocada.
         evidencia_origem = case
           when fila_pagamento_sem_vinculo.evidencia_origem = 'PRIME_API_LIVE'
             then 'PRIME_API_LIVE'
           else coalesce(excluded.evidencia_origem, fila_pagamento_sem_vinculo.evidencia_origem) end,
         evidencia_em = case
           when fila_pagamento_sem_vinculo.evidencia_origem = 'PRIME_API_LIVE'
             then fila_pagamento_sem_vinculo.evidencia_em
           else coalesce(excluded.evidencia_em, fila_pagamento_sem_vinculo.evidencia_em) end
   where fila_pagamento_sem_vinculo.decisao is null;

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
    'status', v_status, 'motivo', v_motivo,
    'parcela_id', v_parcela_id, 'acordo_id', v_acordo_id,
    'aplicou', true, 'baixou', false, 'evidencia', v_evid);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.confirmar_pagamento_solicitacao(p_confirmacao_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email      text := lower(coalesce(auth.jwt()->>'email',''));
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
  v_s          record;
  v_aluno_id   uuid;
  v_det        jsonb;
  v_tem_pend   boolean;
  v_agora      timestamptz := now();
  v_data       date;
  v_nome       text;
begin
  if not v_is_service then
    if not (public.usuario_e_gestao() and public.perfil_do_usuario_atual() is not null) then
      raise exception 'Acesso negado: confirmar_pagamento_solicitacao exige gestao financeira ativa (usuario=%).',
        coalesce(nullif(v_email,''),'(anonimo)') using errcode = '42501';
    end if;
  end if;

  select * into v_s
    from public.solicitacoes_confirmacao_pagamento
   where id = p_confirmacao_id
   for update;
  if not found then
    raise exception 'Solicitacao % nao encontrada.', p_confirmacao_id using errcode = 'P0002';
  end if;

  if v_s.status not in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO') then
    return jsonb_build_object(
      'ja_processado', true,
      'status', v_s.status,
      'quitou', (
        v_s.status = 'PAGAMENTO_CONFIRMADO'
        and v_s.aluno_id is not null
        and coalesce(
              (public.aluno_saldo_pendente_detalhe(nullif(v_s.aluno_id,'')::uuid, v_s.id) ->> 'tem_pendencia')::boolean,
              true) = false
      )
    );
  end if;

  v_aluno_id := nullif(v_s.aluno_id,'')::uuid;
  v_data     := coalesce(v_s.data_pagamento, v_agora::date);

  if v_aluno_id is not null then
    v_det      := public.aluno_saldo_pendente_detalhe(v_aluno_id, v_s.id);
    v_tem_pend := coalesce((v_det->>'tem_pendencia')::boolean, true);
  else
    v_det      := jsonb_build_object('erro','sem_aluno_id');
    v_tem_pend := true;
  end if;

  update public.solicitacoes_confirmacao_pagamento
     set status         = 'PAGAMENTO_CONFIRMADO',
         observacao_adm = nullif(btrim(
                            coalesce(observacao_adm,'') ||
                            case when coalesce(p_observacao,'') <> ''
                                 then ' — ' || p_observacao else '' end), ''),
         confirmado_por = coalesce(nullif(v_email,''), confirmado_por),
         confirmado_em  = v_agora,
         atualizado_em  = v_agora
   where id = p_confirmacao_id;

  if v_tem_pend then
    insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe)
    values (v_aluno_id, 'CONFIRMACAO_PAGAMENTO', (v_det->>'total')::numeric, v_det);
    return jsonb_build_object('quitou', false, 'motivo','SALDO_PENDENTE', 'detalhe', v_det);
  end if;

  select responsavel_atual_nome into v_nome from public.alunos where id = v_aluno_id;

  update public.casos
     set status_atual        = 'QUITADO',
         status_acionamento  = 'SEM_SALDO_EM_ABERTO',
         status_jornada      = 'SEM_SALDO_EM_ABERTO',
         status_financeiro   = 'QUITADO_CONFIRMACAO',
         total_em_aberto     = 0,
         quitado_em          = v_data,
         valor_quitado       = coalesce(v_s.valor_informado, valor_quitado, 0),
         origem_quitacao     = 'CONFIRMACAO_PAGAMENTO',
         caso_atualizado_por = coalesce(nullif(v_email,''),'sistema_confirmacao_pagamento'),
         caso_atualizado_em  = v_agora
   where aluno_id = v_aluno_id;

  update public.alunos
     set status_atual       = 'QUITADO',
         status_jornada     = 'QUITADO',
         status_acionamento = 'QUITADO',
         valor_em_aberto    = 0,
         fila_destino       = null,
         proxima_acao       = null
   where id = v_aluno_id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
  values
    (v_aluno_id::text, 'QUITACAO_CONFIRMADA',
     'Pagamento confirmado e saldo zerado (fonte canonica): caso encerrado e retirado das filas. Sem exclusao de registros financeiros.',
     'SEM_SALDO_EM_ABERTO', coalesce(v_nome, nullif(v_email,'')), v_email, v_agora);

  return jsonb_build_object('quitou', true, 'caso_encerrado', true, 'detalhe', v_det);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.perfil_do_usuario_atual()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  select u.perfil from public.usuarios u
  where lower(u.email) = lower(auth.email()) and u.ativo limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.casos_elegiveis_liberacao_fidelizacao()
 RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, operador_nome text, data_ultimo_acionamento date, fidelizado_ate date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, c.aluno_id, c.operador_email, c.operador_nome,
    c.data_ultimo_acionamento,
    case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate
  from public.casos c
  left join public.alunos a on a.id = c.aluno_id
  where c.operador_email is not null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
    and coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days') < now() - interval '1 day'
  order by c.data_ultimo_acionamento asc nulls first;
$function$
;

CREATE OR REPLACE FUNCTION public.contar_carteira_ativa(p_email text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::int FROM public.casos c
   WHERE (p_email IS NULL OR c.operador_email = p_email)
     AND (p_email IS NOT NULL OR c.operador_email IS NOT NULL)
     AND c.encerrado_operacional = false
     -- caso que so espera a Conferencia Prime nao ocupa vaga
     AND NOT public.caso_aguarda_confirmacao_financeira(c.aluno_id);
$function$
;

create role anon nologin; create role authenticated nologin; create role service_role nologin; grant usage on schema public to anon, authenticated, service_role, public;

-- prod 21/09/2026 (pg_get_functiondef)
CREATE OR REPLACE FUNCTION public.baixa_pelo_relatorio_pagamento(p_confirmar boolean DEFAULT false, p_desde date DEFAULT '2026-07-01'::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
declare v_r jsonb;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  v_r := public.conciliacao_reprocessar(coalesce(p_confirmar, false), 5000);
  return v_r || jsonb_build_object('delegado_para', 'pagamento_conciliar_um', 'desde', p_desde);
end;
$function$
;

CREATE OR REPLACE FUNCTION public._pagamento_conciliar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.pagamento_conciliar_um(new.id, true);
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._pagamentos_baixar_lote()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_res jsonb; v_liga boolean;
begin
  perform set_config('reativa.fluxo_pagamentos','on', true);
  begin
    v_res := public.baixa_pelo_relatorio_pagamento(true, (current_date - 180));
  exception when others then
    -- a baixa e melhoria, nao condicao: a importacao nao pode cair por causa
    -- dela. Fica o registro para alguem olhar.
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina','BAIXA_LOTE_FALHOU','pagamentos', null,
            jsonb_build_object('erro', SQLERRM));
    return null;
  end;

  -- PARCELA PAGA ANTES DA EXTRACAO (17/09/2026). So depois de o motor ter
  -- feito o que dava: o que sobrou sem parcela para o boleto, em acordo que ja
  -- existe, passa pela previa estrutural. Falha aqui tambem nao derruba a
  -- importacao.
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes';
  if coalesce(v_liga, false) then
    begin
      perform public.parcela_paga_antes_reconstruir_pendentes(50);
    exception when others then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'RECONSTRUCAO_PARCELA_LOTE_FALHOU', 'pagamentos', null,
              jsonb_build_object('erro', SQLERRM));
    end;
  end if;

  -- ACORDO A VISTA PAGO ANTES DE EXISTIR NO CRM (17/09/2026). Depois de tudo:
  -- o que sobrou em AGUARDANDO_ACORDO, com boleto de parcela unica e sem
  -- acordo no CRM, passa pela previa do botao. Falha aqui tambem nao derruba
  -- a importacao.
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista';
  if coalesce(v_liga, false) then
    begin
      perform public.acordo_avista_recuperar_pendentes(25);
    exception when others then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'RECUPERACAO_AVISTA_LOTE_FALHOU', 'pagamentos', null,
              jsonb_build_object('erro', SQLERRM));
    end;
  end if;
  return null;
end;
$function$;
;

CREATE OR REPLACE FUNCTION public.trg_pagamentos_gerar_confirmacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  with al as (
    select id, translate(upper(regexp_replace(trim(coalesce(nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm
    from public.alunos where coalesce(trim(nome),'')<>''),
  al_uni as (select nome_norm, (max(id::text))::uuid aluno_id from al group by nome_norm having count(*)=1),
  pag as (
    select translate(upper(regexp_replace(trim(coalesce(aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm,
      max(aluno_nome) aluno_nome, round(sum(coalesce(valor_pago,0)),2) valor,
      max(operador_email) op_email, max(operador_nome) op_nome, data_pagamento dt
    from new_rows
    where coalesce(trim(aluno_nome),'')<>'' and data_pagamento is not null
    group by 1, data_pagamento),
  elegivel as (
    select u.aluno_id, p.aluno_nome, p.valor, p.op_email, p.op_nome, p.dt
    from pag p join al_uni u using(nome_norm)
    -- Janela de 90 dias, nao "mes corrente" (Amanda, 02/09). O corte de mes
    -- fazia o arquivo do dia 1o perder tudo que era do mes anterior.
    where p.dt >= current_date - 90
  ),
  -- Reimportação do mesmo dia: atualiza o valor da que já está aguardando,
  -- em vez de criar outra linha para o mesmo pagamento.
  atualizadas as (
    update public.solicitacoes_confirmacao_pagamento s
       set valor_informado = e.valor,
           aluno_nome      = coalesce(s.aluno_nome, e.aluno_nome),
           operador_email  = coalesce(s.operador_email, e.op_email),
           operador_nome   = coalesce(s.operador_nome, e.op_nome),
           atualizado_em   = now()
      from elegivel e
     where s.aluno_id = e.aluno_id::text
       and s.data_pagamento = e.dt
       and s.status = 'AGUARDANDO_CONFIRMACAO'
    returning s.aluno_id, s.data_pagamento
  )
  insert into public.solicitacoes_confirmacao_pagamento
    (aluno_id, aluno_nome, valor_informado, operador_email, operador_nome, data_pagamento, tipo_pagamento, status, motivo)
  select e.aluno_id::text, e.aluno_nome, e.valor, e.op_email, e.op_nome, e.dt, null,
         'AGUARDANDO_CONFIRMACAO', 'Gerado do import de pagamentos Santander'
  from elegivel e
  where not exists (
    select 1 from public.solicitacoes_confirmacao_pagamento s
     where s.aluno_id = e.aluno_id::text
       and s.data_pagamento = e.dt
       and s.status = 'AGUARDANDO_CONFIRMACAO'
  );

  return null;
end;
$function$;
;
