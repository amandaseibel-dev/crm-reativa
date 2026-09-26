# Aguardando aprovação — NÃO mover para `migrations/`

Arquivos aqui foram escritos e revisados, e **não estão aplicados**. Não são
migrations: a extensão `.pendente` existe justamente para o Supabase CLI não
aplicá-los em deploy.

> Este diretório também guarda, **na árvore de trabalho**, artefatos de outras
> frentes (canário de importação de 12–14/09, rollbacks de proteção,
> `caso_faltando`). Eles **não estão versionados neste branch** de propósito —
> pertencem a outro assunto e devem ir num PR próprio.

---

## Pacote de 24/09/2026 — mensalidade vinculada: QUITADO ou NEGOCIADO

**Nada aplicado.** Diagnóstico completo, com IDs e prova título a título:
[`docs/DIAGNOSTICO-MENSALIDADE-STATUS-ACORDO-2026-09-24.md`](../../docs/DIAGNOSTICO-MENSALIDADE-STATUS-ACORDO-2026-09-24.md).

Revisão independente da prova de proveniência (25/09):
[`docs/REVISAO-PROVENIENCIA-GRUPO-A-2026-09-25.md`](../../docs/REVISAO-PROVENIENCIA-GRUPO-A-2026-09-25.md).

Regra da mensalidade por status do acordo, com a matriz completa:
[`docs/REGRA-TITULO-REAVALIAR-POR-STATUS-DO-ACORDO.md`](../../docs/REGRA-TITULO-REAVALIAR-POR-STATUS-DO-ACORDO.md).

Caso isolado, separado e sem decisão:
[`docs/CASO-SUELEN-TITULO-050701930003.md`](../../docs/CASO-SUELEN-TITULO-050701930003.md).

Regra permanente e saneamento de dado ficam **em arquivos separados**, de
propósito: cada população pode ser validada antes de ser tocada.

| ordem | arquivo | o que faz |
|---|---|---|
| 1 | `20260924_1_estrutural_mensalidade_segue_status_do_acordo.sql.pendente` | proveniência da quitação (`quitacao_origem`) + porta de volta em `titulo_reavaliar` + guardas que faltavam em `titulos_por_status_acordo`. **Inerte para o histórico.** |
| 2 | `20260924_2_saneamento_g1_65_negociado_em_acordo_quitado.sql.pendente` | 65 títulos / R$ 41.642,41 → PAGO/quitada, pelo motor `titulo_reavaliar` |
| 3 | `20260924_3_saneamento_g2a_492_pago_por_acordo_ativo.sql.pendente` | 492 títulos / R$ 830.042,13 → NEGOCIADO/vinculada. Exige o arquivo 1 aplicado. |
| 4 | `20260924_4_suelen_titulo_050701930003.sql.pendente` | caso isolado; **duas opções, nenhuma escolhida, nenhuma executável** — só o bloco de conferência roda |
| — | `20260924_5_VALIDACAO_antes_depois.sql` | 100% SELECT, rodar inteiro antes e depois |
| — | `20260924_*.rollback.sql` | reversão por ID, **contra o estado exato que o saneamento deixou** — ver abaixo |

### Os 538 "PAGO em acordo ATIVO", por prova de causalidade

A1 = 173 (o motivo do título nomeia este acordo), A2 = 319 (assinatura exata de
`titulos_por_status_acordo`), **A = 492 / R$ 830.042,13 — só esse entra**;
B = 0; C = 17 boletos do próprio acordo; D = 21 quitados pela liquidação Prime
portador 195; E1 = 5 quitação manual que zerou o valor; E2 = 3 com intervenção
posterior no valor. **46 exceções, nenhuma tocada.**

**Timestamp igual não é prova de causa.** `audit_log.criado_em` tem
`default now()` (timestamp da transação): prova mesma transação, não quem causou
o quê. Cada título do grupo A exige **quatro** evidências simultâneas, todas
recalculadas como guard na execução: (1) a assinatura de campos alterados exclui
o caminho de vínculo e o de quitação manual; (2) o `audit_log.id` do título cai
**dentro da janela** do seu acordo, entre o evento dele e o do próximo acordo
quitado na mesma transação, o que descarta backfill em bloco (houve transações
quitando 78, 111 e 140 acordos de uma vez); (3) nenhum valor tocado no evento
nem depois — é o que separa a quitação manual; (4) nenhum registro independente
de liquidação. Aplicar só o teste de timestamp teria levado junto 8 títulos
(E1 + E2).

> A revisão de 25/09 corrigiu a redação de (1): **três** funções gravam o motivo
> "quitada junto com o acordo", não uma. A causalidade se sustenta porque a
> assinatura exclui o caminho de vínculo (que grava `acordo_id` no mesmo UPDATE)
> e o de quitação manual (que zera valor), e porque a janela prende o evento
> dentro dos AFTER triggers daquele `UPDATE` de acordo.

**Efeito no saldo: nenhum.** O que muda é a efetividade da carteira, que hoje
conta R$ 830 mil como "pago" em acordo que ainda está sendo pago.

---

## Reversão: comparada com o estado deixado, não com um estado plausível

Os três rollbacks (`_2_`, `_3_`, `_4_`) **não** se contentam em ver o título no
estado que o saneamento deveria ter deixado. Antes de sobrescrever qualquer
campo, cada um compara **campo por campo** com a fotografia gravada no momento
da correção, e recusa o título divergente — só ele, nominalmente, com o motivo.

Como isso é possível: cada arquivo de saneamento, ainda dentro da própria
transação, grava no backup **o estado posterior** (`*_pos`), o `to_jsonb` da
linha depois da correção e a **marca-d'água do `audit_log`**
(`audit_log_id_pos` = o maior `audit_log.id` daquele título no fim da correção).

O rollback então exige, por título:

1. `situacao`, `status`, `acordo_id`, `motivo_ajuste`, `quitacao_origem`,
   `quitacao_origem_acordo_id` e `quitacao_origem_em` **idênticos** ao `*_pos`;
2. **nenhum evento em `audit_log` com `id > audit_log_id_pos`** que tenha tocado
   campo relevante (situação, status, `acordo_id`, motivo, proveniência, valor,
   `origem_liquidacao`, `origem_encerramento`);
3. nenhuma marca de liquidação independente que tenha aparecido depois —
   `origem_liquidacao`/`origem_encerramento` ainda nulas e zero pagamento
   próprio em `pagamentos`, `conferencia_pagamentos` e
   `solicitacoes_confirmacao_pagamento`.

Falhando qualquer uma, o título é **recusado** e sai na lista com o motivo
exato. Os demais voltam.

Se o backup não tiver a fotografia posterior (`audit_log_id_pos` nulo — saneamento
rodado por uma versão antiga do arquivo), o rollback **aborta inteiro** em vez de
cair no teste fraco.

**Backups por ID** (sem PITR, é a única volta):
`_backup_saneamento_g1_20260924`, `_backup_saneamento_g2a_20260924`,
`_backup_saneamento_suelen_20260924`. Guardam o registro inteiro antes e depois,
os vínculos, o acordo e seu status, a proveniência, o `audit_log.id` e o instante
do evento que provou a causalidade, a assinatura de campos alterados, o motivo da
correção e o timestamp. **Não são derrubados pelo rollback** — são a prova do que
foi feito.
