# A mensalidade quando o acordo muda de status

**25/09/2026 · leitura de produção + testes em PostgreSQL real · NADA APLICADO**

Depois do saneamento, os 492 títulos do grupo A ficam `NEGOCIADO` com
`quitacao_origem = 'ACORDO'` gravada. A pergunta desta página: **quando aquele
acordo muda de status de novo, o que acontece com a mensalidade?**

As duas falhas que não podem acontecer:

- a mensalidade **voltar à cobrança** quando a dívida já está no acordo;
- a mensalidade **ficar PAGO** quando a regra exige NEGOCIADO.

Testes: [`supabase/tests/titulo_reavaliar_por_status_do_acordo.test.js`](../supabase/tests/titulo_reavaliar_por_status_do_acordo.test.js)
— 22 casos, PostgreSQL real, com a migration estrutural lida do próprio arquivo
pendente (se ela mudar, os testes acusam).

---

## 1. Primeiro, os status que existem de verdade

Medido em produção, 25/09/2026:

| `acordos.status` | acordos |
|---|---:|
| ATIVO | 2.345 |
| QUITADO | 1.296 |
| CANCELADO | 597 |

**Não existe `QUEBRADO` e não existe `INATIVO` em `acordos.status`.** Não há
`CHECK` na coluna, então qualquer texto é gravável — mas nenhum dos dois foi
gravado nunca.

- **QUEBRADO** existe, mas é outra coisa: é valor de `acordo_situacao`, um estado
  **derivado** que a Saúde da Carteira calcula a partir de parcela vencida
  (`src/utils/acordoDono.js`, `exportarSaudeCarteira.js`,
  `SaudeCompletaCarteira.jsx`). Um acordo "quebrado" é, na tabela,
  `status = 'ATIVO'` com parcela vencida.
- **INATIVO** não aparece em lugar nenhum — nem no dado, nem no front. Aparece
  apenas dentro de uma guarda defensiva de `titulo_reavaliar`, junto com
  QUEBRADO, no ramo que preserva NEGOCIADO quando o acordo cai.

## 2. A matriz

`v_acordo` é o acordo vivo do vínculo — lido com
`where upper(status) not in ('CANCELADO','CANCELADA')`. É esse detalhe que
governa quase toda a tabela.

| transição do acordo | proveniência do título | estado esperado da mensalidade | por quê |
|---|---|---|---|
| **QUITADO → ATIVO** | `ACORDO` + este acordo | **NEGOCIADO / vinculada**, proveniência limpa | a quitação era consequência do acordo, e o acordo deixou de estar quitado |
| **QUITADO → ATIVO** | **nula** (todo o histórico antes de 24/09) | **PAGO / quitada** | ausência de prova não abre a porta — PAGO segue terminal |
| **QUITADO → ATIVO** | `ACORDO` + **outro** acordo | **PAGO / quitada** | a proveniência não aponta este acordo |
| **QUITADO → CANCELADO** | `ACORDO` + este acordo | **PAGO / quitada**, proveniência **preservada** | ver §3 — é decisão conhecida, com efeito colateral |
| **ATIVO (parcela vencida) = "QUEBRADO"** | `ACORDO` + este acordo | **NEGOCIADO / vinculada** | para o motor é ATIVO; a dívida vive nas parcelas |
| **status desconhecido** (ex.: `INATIVO`) | `ACORDO` + este acordo | **NEGOCIADO / vinculada** | não é QUITADO nem CANCELADO → lido como acordo vivo não quitado |
| **ATIVO → QUITADO**, sem parcela viva | — | **PAGO / quitada** + proveniência gravada | é a regra oficial de 02/09 |
| **ATIVO → QUITADO**, com parcela viva | — | **NEGOCIADO / vinculada** | guarda de 31/08: acordo "quitado" com parcela viva não quita nada |
| **qualquer transição**, título `tipo_boleto = 'Acordo'` | — | **NEGOCIADO / vinculada** | nunca foi dívida: é o número do documento |
| **qualquer transição**, título `CANCELADA` | — | **CANCELADA** | cancelar é decisão deliberada; a reavaliação não a desfaz |
| **QUITADO → ATIVO**, com liquidação independente | `ACORDO` + este acordo | **PAGO / quitada** | `origem_liquidacao`/`origem_encerramento`, `pagamentos`, `conferencia_pagamentos` ou `solicitacoes` — pagamento próprio fecha a porta |

Em nenhuma linha da matriz a mensalidade vai para **ABERTO**. Isso importa:
`ABERTO` entra na conta de saldo, `NEGOCIADO` com vínculo vivo não. Voltar para
ABERTO seria cobrar de novo o que está no acordo.

## 3. QUITADO → CANCELADO: a decisão, e o preço dela

Quando o acordo é cancelado, o `SELECT` do acordo vivo o exclui, então não há
acordo para a porta de reabertura comparar: **PAGO segue terminal.**

Isso respeita a regra de 22/09 — *"acordo cancelado não reabre mensalidade"* — e
é o comportamento certo para o **saldo**: a mensalidade não volta a ser cobrada.

**O preço:** a **efetividade** continua contando aquele valor como
"Pago / Quitado" (`carteira_2026_1_classificar` lê `situacao = 'PAGO'`), num
acordo que foi cancelado. É a mesma inflação que este pacote está corrigindo —
em escala menor e por outro caminho.

Por que não resolvemos aqui: o estado que descreveria a verdade seria
`NEGOCIADO` **sem** vínculo vivo — e é exatamente isso que
`saude_carteira_panorama` **conta** como dívida (é o "negociado órfão", a mesma
mecânica do caso Suelen). Ou seja, as duas saídas disponíveis hoje erram para
lados opostos:

| saída | saldo | efetividade |
|---|---|---|
| **PAGO** (atual) | correto — não cobra de novo | **errado** — conta como recuperado |
| NEGOCIADO sem vínculo vivo | **errado** — volta à cobrança | correto |

Resolver de verdade exige um terceiro estado (ou um filtro de efetividade que
olhe o status do acordo), e isso **muda número de carteira** — fora do escopo
deste pacote, que promete saldo inalterado. Fica registrado como decisão
consciente, com teste que fixa o comportamento atual para que uma mudança futura
seja deliberada e não acidental.

## 4. Achado da revisão: o motor desfazia o filtro das irmãs

Os três gatilhos de `acordos` disparam na **mesma** transição de status. Duas das
três funções excluem o boleto do próprio acordo:

| função | excluía `tipo_boleto = 'Acordo'`? |
|---|---|
| `_titulo_quita_com_o_acordo` | sim, desde `20260831140000` |
| `titulos_por_status_acordo` | não — **passa a excluir** no arquivo 1 |
| `titulo_reavaliar` (o motor) | **não, e continuava não excluindo** |

O motor, chamado pelo terceiro gatilho, marcava `situacao = 'PAGO'` no boleto do
próprio acordo **depois** de as irmãs o terem poupado. Resultado: o arquivo 1
corrigia uma das duas portas dos 17 títulos do grupo C, e **a outra continuaria
aberta** — o defeito voltaria a produzir casos novos.

**Corrigido no arquivo 1:** `v_quitado` passa a exigir
`coalesce(v_tipo,'') <> 'Acordo'`. Sem quitar, o caminho de baixo deixa o boleto
em `NEGOCIADO / vinculada` — exatamente onde as irmãs o deixam. Há teste para os
dois lados.

## 5. Os 22 testes, e o que cada grupo fixa

| grupo | casos | fixa |
|---|---:|---|
| a migration aplica e é inerte | 2 | as três colunas nascem; título sem proveniência não reabre |
| QUITADO → ATIVO | 3 | volta a NEGOCIADO, não a ABERTO, e o valor não é tocado |
| QUITADO → CANCELADO | 2 | não volta à cobrança; fica PAGO e a proveniência é preservada |
| "QUEBRADO" (ATIVO com parcela vencida) | 1 | é tratado como ATIVO |
| status desconhecido | 1 | abre para NEGOCIADO, nunca para ABERTO |
| a porta recusa sem prova | 7 | outro acordo, boleto do acordo, liquidação, pagamento, conferência, solicitação, título CANCELADA |
| ATIVO → QUITADO | 4 | quita sem parcela viva; não quita com parcela viva; não quita o boleto do acordo; grava a proveniência |
| ida e volta | 2 | o ciclo completo não passa por ABERTO, e reavaliar de novo é idempotente |

## 6. O que continua em aberto

1. **A efetividade do acordo cancelado** (§3) — decisão pendente, fora deste
   pacote.
2. **`INATIVO` não existe.** O comportamento está fixado por teste (vira
   NEGOCIADO), mas se alguém introduzir esse status com outro significado, a
   regra precisa ser revisada de propósito.
3. **Não há `CHECK` em `acordos.status`.** Nada impede um texto novo entrar sem
   que ninguém decida o que ele significa para a mensalidade.
