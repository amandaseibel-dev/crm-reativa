# Evidência de produção — carteira_prioridade_bordero (18/11/2026)

Leitura somente (`SELECT`), projeto `ahattpqrjmhkzsmnbdzs`. Nenhuma alteração. Sem PII: só metadados de catálogo.

Esta é a saída bruta que sustenta `docs/seguranca/propostas/carteira-prioridade-dependencias.md`.

## 1. Colunas e fuso da sessão

Consulta:

```sql
select c.table_name, c.column_name, c.data_type, c.column_default,
       current_setting('TimeZone') as tz_sessao
  from information_schema.columns c
 where c.table_schema = 'public'
   and (c.table_name, c.column_name) in (
     ('importacoes','created_at'), ('importacoes','tipo'),
     ('acordos_titulos','aluno_id'), ('acordos_titulos','importacao_id'),
     ('acordos_titulos','situacao'), ('acordos_titulos','vencimento'),
     ('acordos_titulos','valor_em_aberto'), ('acordos_titulos','saldo_corrigido'),
     ('aluno_movimentacoes','registrado_em'), ('aluno_movimentacoes','tipo'),
     ('alunos','responsavel_atual_email'),
     ('whatsapp_conversas','aluno_id'),
     ('whatsapp_mensagens','conversa_id'), ('whatsapp_mensagens','direcao'),
     ('whatsapp_mensagens','status'), ('whatsapp_mensagens','timestamp_wa'),
     ('solicitacoes_confirmacao_pagamento','status'),
     ('acoes_massivas_lotes','confirmado_em'), ('acoes_massivas_lotes','descartado_em'),
     ('usuarios','ativo'))
 order by 1, 2;
```

Saída (20 linhas, ordenadas):

| tabela | coluna | tipo | default | tz_sessao |
|---|---|---|---|---|
| acoes_massivas_lotes | confirmado_em | timestamp with time zone | — | UTC |
| acoes_massivas_lotes | descartado_em | timestamp with time zone | — | UTC |
| acordos_titulos | aluno_id | uuid | — | UTC |
| acordos_titulos | importacao_id | uuid | — | UTC |
| acordos_titulos | saldo_corrigido | numeric | — | UTC |
| acordos_titulos | situacao | text | — | UTC |
| acordos_titulos | valor_em_aberto | numeric | — | UTC |
| acordos_titulos | vencimento | date | — | UTC |
| aluno_movimentacoes | registrado_em | timestamp with time zone | now() | UTC |
| aluno_movimentacoes | tipo | text | — | UTC |
| alunos | responsavel_atual_email | text | — | UTC |
| importacoes | created_at | timestamp without time zone | now() | UTC |
| importacoes | tipo | text | — | UTC |
| solicitacoes_confirmacao_pagamento | status | text | 'AGUARDANDO_CONFIRMACAO'::text | UTC |
| usuarios | ativo | boolean | true | UTC |
| whatsapp_conversas | aluno_id | uuid | — | UTC |
| whatsapp_mensagens | conversa_id | uuid | — | UTC |
| whatsapp_mensagens | direcao | text | — | UTC |
| whatsapp_mensagens | status | text | — | UTC |
| whatsapp_mensagens | timestamp_wa | timestamp with time zone | — | UTC |

Leitura: `importacoes.created_at` é timestamp **sem** fuso, e o fuso da sessão é UTC. A conversão `at time zone 'UTC'` da migration está correta.

Cobertura: só as colunas que a migration referencia. Não é inventário completo.

## 2. Corpos das funções de dependência (md5 de `pg_get_functiondef`)

Consulta:

```sql
select p.oid::regprocedure::text as funcao, md5(pg_get_functiondef(p.oid)) as md5_corpo
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.oid::regprocedure::text in (
     'aluno_elegibilidade_cobranca(uuid)','usuario_e_gestao()',
     'saldo_cobravel_aluno(uuid)','aluno_bloqueio_administrativo(uuid)',
     'aluno_pendencia_operacional(uuid)','normalizar_status_acionamento(text)',
     'parcela_viva(text)')
 order by 1;
```

Saída:

| funcao | md5_corpo |
|---|---|
| aluno_bloqueio_administrativo(uuid) | 8ef9b6b7454d78af0e22f344362506c8 |
| aluno_elegibilidade_cobranca(uuid) | d87c10aac1d733bbf2bdd4683265f3e3 |
| aluno_pendencia_operacional(uuid) | f1389aa0ce8e017f7ffec5297925b909 |
| normalizar_status_acionamento(text) | 5e37ad78f61f9d1853819de6ce18b65c |
| parcela_viva(text) | 21d1dd16ff680c8bf0d13523d5780202 |
| saldo_cobravel_aluno(uuid) | e2c732946181aa7ad258798503dd7209 |
| usuario_e_gestao() | af3d391f4234e6a352585777897568e4 |

Conferência: `usuario_e_gestao` e `aluno_elegibilidade_cobranca` batem com o md5 da tabela de dependências; `parcela_viva` bate com o md5 citado na fixture. Os demais md5 ficam registrados aqui pela primeira vez.

Reconferir antes de aplicar a migration: o md5 pode mudar se a função for alterada em produção.
