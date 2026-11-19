# Evidência: schema, RLS, grants, policies e triggers reais (produção, só SELECT)

Projeto `ahattpqrjmhkzsmnbdzs`. Leitura feita nesta sessão, sem gravação. Resultado transcrito do SQL executado (catálogos `pg_class`, `pg_policy`, `pg_trigger`, `pg_constraint`, `information_schema.role_table_grants` e `information_schema.columns`).

## RLS
- `aluno_movimentacoes`: RLS ligada, sem FORCE.
- `tabulacoes`: RLS ligada, sem FORCE.

## Policies de `aluno_movimentacoes`
- `aluno_mov_painel_elogios` (SELECT, authenticated): `eh_painel() AND status_novo = 'ELOGIO_ATENDIMENTO' AND elogio_aprovado_tv = true`.
- `aluno_movimentacoes_insert` (INSERT, authenticated): `app_usuario_ativo() AND (usuario_e_gestao() OR lower(coalesce(registrado_por_email,'')) = app_email())`. **O operador pode gravar a própria linha.**
- `aluno_movimentacoes_insert_executor` (INSERT, `reativa_responsavel_executor`): `check = true`.
- `aluno_movimentacoes_select` (SELECT, authenticated): `NOT eh_painel()`.
- **Não há policy de UPDATE nem de DELETE.** Com RLS ligada e sem policy, esses comandos afetam zero linhas para authenticated.

## Policies de `tabulacoes`
- `tabulacoes_leitura_autenticado` (SELECT, sem role explícito): `NOT somente_gestao OR usuario_e_gestao() OR auth.role() = 'service_role'`. Esconde do operador as linhas só-gestão.

## Grants (tabela, papel, privilégios)
- `aluno_movimentacoes` / `authenticated`: DELETE, INSERT, SELECT, UPDATE (sem policy que permita, ver acima).
- `aluno_movimentacoes` / `service_role`: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE.
- `tabulacoes` / `authenticated`: SELECT.
- `tabulacoes` / `service_role`: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE.
- Nenhum grant listado para `anon` nem `public` nessas duas tabelas.

## Triggers de `aluno_movimentacoes` (todas habilitadas, origem `O`)
- `trg_atualizar_ultimo_acionamento`
- `trg_sincronizar_elogio_da_movimentacao`
- `trg_zz_desfazer_cartao_tabulacao`
- A trigger `aluno_mov_tabulacao_so_gestao` **ainda não existe** (é criada pela migração).

## `tabulacoes`
- Chave primária: `tabulacoes_pkey PRIMARY KEY (codigo)`.
- Nenhuma foreign key aponta para `tabulacoes`.
- Colunas (tipo, nulabilidade, default): `codigo text NOT NULL`; `rotulo text NOT NULL`; `ativa boolean NOT NULL default true`; `ordem integer NOT NULL default 500`; `grupo text NOT NULL default 'CONTATO'`; `retorno_modo text NOT NULL default 'NENHUM'`; `retorno_dias_uteis integer NULL`; `proxima_acao text NOT NULL default 'CONTATAR'`; `bloco_ficha text NULL`; `exige_processo boolean NOT NULL default false`; `bloqueia_acionamento boolean NOT NULL default false`; `sistema boolean NOT NULL default false`; `criado_em timestamptz NOT NULL default now()`; `criado_por text NULL`; `atualizado_em timestamptz NULL`; `atualizado_por text NULL`; `desativada_em timestamptz NULL`; `desativada_por text NULL`; `somente_gestao boolean NOT NULL default false`; `redireciona_para_email text NULL`; `efeito_desfecho text NULL`.

## `aluno_movimentacoes` (colunas)
`id bigint, aluno_id text, tipo text, descricao text, status_anterior text, status_novo text, registrado_por_nome text, registrado_por_email text, registrado_em timestamptz, operador_anterior_nome text, operador_anterior_email text, operador_novo_nome text, operador_novo_email text, data_retorno timestamptz, solicitacao_link_id uuid, baixa_pagamento_id uuid, link_pagamento text, motivo_devolucao text, valor_movimentacao numeric, elogio_print_path text, elogio_print_nome text, elogio_aprovado_tv boolean, elogio_aprovado_por text, elogio_aprovado_em timestamptz, elogio_rejeitado_tv boolean, elogio_rejeitado_por text, elogio_rejeitado_em timestamptz, lote_id uuid`.

**Divergência em relação à simulação:** em produção `id` é `bigint`; na simulação de teste é `uuid`. Os testes não inserem `id`, então o resultado não muda, mas a simulação deve ser corrigida.
