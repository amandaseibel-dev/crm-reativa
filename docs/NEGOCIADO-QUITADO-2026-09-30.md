# NEGOCIADO → QUITADO — aplicado em produção em 30/09/2026

**Estado: EM PRODUÇÃO.** Três migrations aplicadas em `ahattpqrjmhkzsmnbdzs`,
com md5 conferido byte a byte contra `supabase_migrations.schema_migrations`.

| versão | nome | md5 |
|---|---|---|
| `20260930153112` | `negociado_quitado_regra_definitiva` | `d586650723437610628c90d3e2f6cdfb` |
| `20260930153601` | `negociado_quitado_portao_canonico` | `56e938eb70b134835ab5e23cfb5c5b36` |
| `20260930153740` | `negociado_quitado_execucao_64` | `1134e05184e7f154afcdb296174b18e2` |

## A regra oficial (descoberta, não presumida)

Fonte de verdade: `public.titulo_reavaliar` — o motor único. Os três gatilhos de
`acordos` e o de `acordo_titulo_vinculo` todos chamam essa função.

QUITADO é **par de colunas**, não duas nomenclaturas: `situacao = 'PAGO'` **e**
`status = 'quitada'`, mantidos coerentes por `_titulo_situacao_e_status_coerentes`.
NEGOCIADO é `situacao = 'NEGOCIADO'` / `status = 'vinculada'`.

Vira QUITADO quando, **cumulativamente**: vínculo `ativo` para acordo não
cancelado + esse acordo `QUITADO` + **zero parcela viva** (nenhuma fora de
`PAGO`, `CANCELADA`, `RENEGOCIADA`).

**Não existe alocação por mensalidade.** O sistema não sabe qual parcela paga
qual mensalidade: só quita quando o **acordo inteiro** está liquidado.

## A causa raiz

`prime_vincular_por_negociacao` (portador 195), na mesma transação:

1. insere o vínculo → dispara `titulo_reavaliar` → o motor decide **certo**;
2. logo depois roda `update ... set situacao='NEGOCIADO', status='vinculada'`
   **incondicional**, desfazendo a decisão do motor.

Prova no `audit_log` (título `0006089c-…`, mesmo `criado_em`):

| id | antes | depois | motivo |
|---|---|---|---|
| 181656 | ABERTO | **PAGO** | `quitada junto com o acordo 188…` |
| 181684 | PAGO | **NEGOCIADO** | (o UPDATE da rotina) |

Todas as 64 tinham `acordo_titulo_vinculo.origem = 'EXATO_PRIME_195'`, criadas
em 09/09 (61) e 12/09 (3), e carregavam até hoje o texto que o motor escreveu
antes de ser sobrescrito.

## O que foi corrigido

**Causa.** O `UPDATE` da rotina passou a gravar **só** `motivo_ajuste` e
`atualizado_em`. Quem decide o estado é o motor. Patch **ancorado** no corpo de
produção (lê `pg_get_functiondef`, troca o trecho, reexecuta): **−67 caracteres,
e nada mais**. A função não foi retypada — ela tem `regexp_replace(…,'\D',…)`,
cujo reescape pelo MCP é inseguro.

**Estoque.** 64 mensalidades reconciliadas por
`mensalidade_reconciliar_negociado_quitado(true)`, que **não tem UPDATE de
status próprio**: chama `titulo_reavaliar` título a título.

## O portão (correção de rota durante a execução)

A RPC nasceu com portão próprio (`auth.role()='service_role' or usuario_e_gestao()`).
A primeira tentativa de execução **abortou inteira** nessa cadeia:

```
titulo_reavaliar → _trg_auto_quitar_titulo → _talvez_quitar_aluno
  → sincronizar_alunos_unificados → bloquear_alteracoes_restritas_aluno
```

Motivo: `crm_usuario_pode_quitar_baixar()` libera backend **só quando
`auth.jwt()` é null**. Setar `request.jwt.claims` para passar no portão próprio
tornava `auth.jwt()` não-nulo e fazia cair no ramo de e-mail, vazio.

A RPC passou a usar `crm_usuario_pode_quitar_baixar()` — **o** portão de
quitar/baixar deste CRM, e esta operação é exatamente uma quitação. Não afrouxa
nada: com JWT, só as três pessoas da gestão; sem JWT, só papéis de backend.
E evita forjar identidade de pessoa para rodar rotina — o log registra
`executado_por = 'service_role'`.

## Resultado medido

| medida | antes | depois |
|---|---|---|
| mensalidades NEGOCIADO | 3.151 | **3.087** (−64) |
| mensalidades PAGO | 5.585 | **5.649** (+64) |
| mensalidades ABERTO | 38.199 | 38.199 |
| acordos / parcelas / parcelas pagas | 4.342 / 15.768 / 5.282 | **iguais** |
| vínculos / vínculos ativos | 5.185 / 5.150 | **iguais** |
| pagamentos / baixas vivas | 9.673 / 3.149 | **iguais** |
| Σ `valor_original` | 48.935.976,47 | **igual** |
| Σ `saldo_corrigido` | 45.565.897,81 | **igual** |
| `saldo_total` global | 42.865.845,82 | **igual** |
| `saldo_vencido` global | 37.510.479,22 | **igual** |
| acordos QUITADO | 1.379 | **igual** |

Das 64: **64/64** com vínculo ativo no mesmo acordo, **64/64** com `acordo_id`
preservado, **64/64** com o motivo dizendo que a origem foi o acordo, **0** com
valor alterado. A consulta proibida (NEGOCIADO + quitação integral comprovada)
devolve **0**.

### Efeito colateral legítimo, medido

`alunos` com `status_jornada='QUITADO'`: **1.515 → 1.532 (+17)**. É a cascata
normal de qualquer quitação (`_talvez_quitar_aluno`), a mesma que vale para as
1.414 mensalidades do grupo de controle: 17 alunos deixaram de ter dívida
aberta. `sum(valor_em_aberto)` da tabela **não mudou** (R$ 511.175,97), e o
total de alunos também não (17.913).

## Permaneceram NEGOCIADO — 3.087, com motivo

| motivo | mensalidades | alunos | valor |
|---|---|---|---|
| acordo ATIVO, pago em parte: ainda há saldo | 2.273 | 740 | R$ 5.246.310,92 |
| acordo ATIVO, nada pago ainda | 813 | 330 | R$ 1.571.129,09 |
| sem acordo vivo (caso Suelen) | 1 | 1 | R$ 428,72 |

Zero na faixa "acordo QUITADO sem parcela viva".

## Rollback

`supabase/rollbacks/20260930153740_negociado_quitado_execucao_64.rollback.sql`
devolve as 64 ao estado exato de `_backup_negociado_quitado_20260930` (guarda
`to_jsonb(titulo)` inteiro + vínculos + parcelas + o aluno antes).
`…20260930153112_negociado_quitado_regra_definitiva.rollback.sql` devolve o
corpo antigo da rotina, **com o defeito**.

## Testes

`supabase/tests/negociado_quitado_reconciliacao.test.js` — **18 testes, verdes**,
em PGlite, com os corpos reais de produção (`supabase/audits/
negociado_quitado_producao_20260930.sql`) e a bancada nascendo **com o defeito**,
para provar que o patch ancorado morde o corpo real. Cobre os 10 cenários
exigidos, as duas exclusões deliberadas, a auditoria e duas mutações.

## Fora de escopo, em aberto

- **G2** — 538 mensalidades PAGO com acordo ATIVO (problema **inverso**), pacote
  de 24/09 em `supabase/aguardando_aprovacao/20260924_3_…`.
- **Caso Suelen** — R$ 428,72, diagnóstico em
  `DIAGNOSTICO-MENSALIDADE-STATUS-ACORDO-2026-09-24.md` §7, duas opções, nenhuma
  executada.
- **Divergência repo × produção** — o repositório está ~63 migrations atrás
  (23/09→30/09); `20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade`
  está em produção e **não existe no repo**, e foi ela que alterou
  `titulo_reavaliar`. Para a regra aplicada aqui é inócua (só tocou o ramo do
  acordo CANCELADO-sem-pagamento), mas segue de pé. Efeito visível: 61 arquivos
  de teste não carregam por apontarem para migrations renumeradas.
