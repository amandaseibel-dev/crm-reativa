# `crm_usuario_pode_quitar_baixar` — linha do tempo, recuperada de produção

**30/09/2026 · recuperação histórica · nada reexecutado, nada alterado.**

Este documento existe porque o portão de quitar/baixar é a autorização em que
outras frentes se apoiam — inclusive a RPC de reconciliação
`mensalidade_reconciliar_negociado_quitado` (versão `20260930153601`) — e as três
versões que o definiram **não estavam representadas no repositório**.

Varredura em todos os **1.465** registros de `supabase_migrations.schema_migrations`
por `create or replace function public.crm_usuario_pode_quitar_baixar`: casam
exatamente **três** versões, e nenhuma delas é de 24/09.

## As três versões

| ordem | versão | nome | bytes | md5 dos statements |
|---|---|---|---|---|
| 1 | `20260716092749` | `habilitar_quitar_baixa_fernanda_amanda_adm` | 1.989 | `5c5bc784c3b087e481a2330be3e3ea26` |
| 2 | `20260826111319` | `quitar_baixar_nao_confia_no_current_user` | 2.795 | `d7bbaff2dc04105ee08ced397e87409b` |
| 3 | `20260921230022` | `vinculo_automatico_guarda_quitar` | 5.798 | `bac0004dc5667181591ead5ad50bc54a` |

### 1 · `20260716092749`

Primeira da sequência. Cria o portão e dois gatilhos que passam a consultá-lo
(`bloquear_aprovacao_quitacao`, `bloquear_baixa_pagamento`). Decide nesta ordem:
papel do banco em `(postgres, supabase_admin, service_role)` → libera; executor
de responsável → nega; senão, lista de três e-mails do JWT.

### 2 · `20260826111319` — supersede a anterior

O passo 1 de 16/07 era um furo: **dentro de `SECURITY DEFINER`, `current_user` é
o dono da função (`postgres`), não quem chamou**. Qualquer RPC `SECURITY DEFINER`
que perguntasse "esta pessoa pode?" recebia sim. Descoberto escrevendo o teste de
permissão do honorário por parcela — o operador comum passou — e já valia em
produção: `acordo_definir_honorarios` deixava um operador comum mexer no próprio
honorário.

A correção inverte a ordem: **com JWT, só a lista de e-mails decide**;
`current_user` só volta a valer quando `auth.jwt()` é `NULL` (cron, `pg_net`,
`service_role`). Ganha `set search_path to 'public'`.

### 3 · `20260921230022` — supersede a anterior, e é a vigente

Acrescenta a **porta do vínculo automático**, que só abre com três condições
simultâneas: e-mail exato do ator, GUC `reativa.vinculo_automatico = 'on'` e a
função `acordo_vinculo_automatico_processar(integer)` na pilha do PL/pgSQL
(`get diagnostics pg_context`). A terceira é o que a torna não-forjável:
`authenticated` não tem `CREATE` em schema.

## Prova de que a sequência explica o estado atual

O `prosrc` vigente — md5 `ff446aeb564db3b9e20bbd2d20c8c7a4`, 1.498 bytes —
**aparece verbatim dentro dos statements de `20260921230022`**, e nenhuma versão
posterior redefine a função. O estado de hoje é integralmente explicado pela
sequência registrada.

## A regra vigente, medida somente leitura

| cenário | papel | JWT | resultado |
|---|---|---|---|
| gestão autorizada | `authenticated` | e-mail da lista | **pode** |
| operador comum | `authenticated` | fora da lista | não pode |
| e-mail desconhecido | `authenticated` | desconhecido | não pode |
| sem JWT | `authenticated` | ausente | **não pode** |
| backend | `service_role` | ausente | **pode** |
| backend | `postgres` | ausente | **pode** |
| ator do vínculo automático, fora da pilha | `authenticated` | e-mail do ator + GUC `on` | **não pode** |

A última linha confirma que as três condições da porta de 21/09 são cumulativas.

## Divergência real × repositório

| produção | repositório | número | conteúdo |
|---|---|---|---|
| `20260716092749` | **nada** | — | — |
| `20260826111319` | `supabase/migrations/20260826160000_quitar_baixar_nao_confia_no_current_user.sql` | fictício | difere (2.710 × 2.795 bytes) |
| `20260921230022` | `supabase/migrations/20260922190000_vinculo_automatico_guarda_quitar.sql` | fictício | difere (6.652 × 5.798 bytes) |

Os dois números `…0000` **não existem** em `schema_migrations`. O arquivo de
21/09, apesar de divergir em bytes, documenta o mesmo estado funcional vigente —
o problema é de rastreabilidade, não de conteúdo perdido.

**Nada foi alterado, renomeado ou movido.** A decisão sobre a numeração fictícia
é uma etapa separada, ainda não executada.

## Pendente

As três versões de 24/09 (`20260924145031`, `20260924150453`, `20260924151348`)
**apenas chamam** o portão — não o redefinem. Seguem na lista de versões cegas
para reconciliação posterior, fora desta frente.
