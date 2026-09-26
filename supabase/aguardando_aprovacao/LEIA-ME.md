# Aguardando aprovação — NÃO mover para migrations/

Arquivos aqui foram escritos, revisados e **retirados de produção**. Não são
migrations: a extensão `.pendente` existe justamente para o Supabase CLI não
aplicá-los em deploy.

## 20260912001000_caso_faltando_para_aluno_com_divida.sql.pendente

Cria ficha (`casos`) para aluno que tem dívida e nenhuma ficha — o ponto cego
de `casos_reabrir_com_divida`, que varre `casos` e por isso nunca vê quem não
tem caso.

Histórico, para não se perder:

- 11/09/2026 ~21:30 UTC — aplicado em produção.
- 11/09/2026 21:35 UTC — o cron horário `casos_reabrir_com_divida_horario`
  disparou e **criou 513 fichas** (R$ 1.037.377,16 em `total_em_aberto`).
  As travas seguraram: 0 aluno e 0 CPF com duas fichas ativas.
- 11/09/2026 ~22:30 UTC — a função foi **restaurada à definição anterior**
  (md5 idêntico ao backup `_backup_fn_casos_reabrir_com_divida_20260912`),
  a pedido da Amanda, que quer aprovar a prévia antes da escrita.

As 513 fichas criadas **seguem em produção**, rastreáveis por
`casos.origem = 'SISTEMA_CASO_FALTANDO'` e por
`aluno_movimentacoes.tipo = 'CASO_CRIADO_DIVIDA'`.

Só voltar para `migrations/` com aprovação explícita.

---

## ROLLBACK_excecao_conciliacao_3_casos.sql

Desfaz o `nao_acionar = true` aplicado em 11/09/2026 nos casos 17138, 17148 e
17155. Restaura de `_backup_excecao_conciliacao_20260912`.

## ROLLBACK_vinculo_por_identificador_financeiro.sql

Desfaz **só o mecanismo novo de vínculo de pagamento** (migration
`20260912121224`): remove os dois gatilhos novos e recria
`trg_pagamento_vincula_aluno` com a definição exata da `20260831092623`.

Não toca em nenhuma linha de `pagamentos` — os dois gatilhos novos são
INSERT-only, então removê-los não pode reescrever o que já está gravado.
A tabela e as linhas de `fila_pagamento_sem_vinculo` ficam (são evidência), e
`parcelas.origem_baixa` / `pagamentos.origem_vinculo` também.

**Consequência de executar:** o nome volta a poder preencher
`pagamentos.aluno_id`. Medido em produção: 54 dos 8.999 pagamentos históricos
mudariam de aluno sob a regra nova — são 54 atribuições que o nome fez errado.

## ROLLBACK_protecao_20260912.sql

Reverte a etapa de proteção de 12/09/2026 (migration `20260912130752`), em três
blocos independentes. **Só o bloco 1 está ativo**; os blocos 2 e 3 vêm
comentados de propósito, porque reabrir `fluxo_pagamentos_rodar` para
`authenticated` devolve a qualquer usuário logado o poder de disparar o fluxo
financeiro inteiro.

- bloco 1 — religa a etapa `vinculo_por_negociacao` do fluxo horário;
- bloco 2 (comentado) — devolve `EXECUTE` de `fluxo_pagamentos_rodar`;
- bloco 3 (comentado) — volta `pagamentos_sem_aluno` à assinatura antiga.

## MEDICAO_teste_importacao.sql

Foto global em 8 pontos, 100% SELECT, com digest md5 de `pagamentos`,
`parcelas`, `alunos` e `casos`. Rodar **antes e depois** do canário: prova que
nada fora do lote mudou. Baseline de 12/09 13:05 registrada em
`../migrations/LEIA-ME-20260912.md`.

## MEDICAO_canario_por_lote.sql

Os mesmos fatos, mas atribuídos ao `importacao_id` do canário — 11 pontos,
incluindo a etapa que vinculou cada linha, a fila com valor e motivo, as
parcelas baixadas pelo lote (rastreáveis por `origem_baixa_ref`) e os casos
alterados. Substitua `:LOTE` pelo `importacao_id`.

Traz também a **janela limpa**: começar o canário por volta de hh:45 e fechar a
medição antes de hh:28, em dia de semana entre 10h e 17h, evitando o bloco de
crons de :30 a :41.

---

## 20260924_1..5 — mensalidade vinculada: QUITADO ou NEGOCIADO

> **REBASEADO SOBRE O #523 EM 25/09/2026.** O arquivo 1 (e o rollback dele)
> partem agora de producao na versao `20260925123852` (#523): `titulo_reavaliar`
> carrega a guarda do #523 byte a byte (NEGOCIADO orfao so fica NEGOCIADO se
> algum acordo da cadeia recebeu dinheiro; sem pagamento volta para ABERTO) e
> acrescenta so a proveniencia e a porta PAGO -> NEGOCIADO. O rollback devolve
> `titulo_reavaliar` ao corpo do #523 (`efdf3fd1...`), nao ao de 24/09. Prova:
> `supabase/tests/mensalidade_segue_status_do_acordo_sobre_523.test.js`.
> Arquivos 2, 3 e 4 nao redefinem funcao e nao mudaram.

Pacote de 24/09/2026, **nada aplicado**. Diagnóstico completo, com IDs e prova
título a título, em
[`docs/DIAGNOSTICO-MENSALIDADE-STATUS-ACORDO-2026-09-24.md`](../../docs/DIAGNOSTICO-MENSALIDADE-STATUS-ACORDO-2026-09-24.md).

Regra permanente e saneamento de dado ficam **em arquivos separados**, de
propósito: cada população pode ser validada antes de ser tocada.

| ordem | arquivo | o que faz |
|---|---|---|
| 1 | `20260924_1_estrutural_mensalidade_segue_status_do_acordo.sql.pendente` | proveniência da quitação (`quitacao_origem`) + porta de volta em `titulo_reavaliar` + guardas que faltavam em `titulos_por_status_acordo`. **Inerte para o histórico.** |
| 2 | `20260924_2_saneamento_g1_65_negociado_em_acordo_quitado.sql.pendente` | 65 títulos / R$ 41.642,41 → PAGO/quitada, pelo motor `titulo_reavaliar` |
| 3 | `20260924_3_saneamento_g2a_492_pago_por_acordo_ativo.sql.pendente` | 492 títulos / R$ 830.042,13 → NEGOCIADO/vinculada. Exige o arquivo 1 aplicado. |
| 4 | `20260924_4_suelen_titulo_050701930003.sql.pendente` | caso isolado; **duas opções, nenhuma escolhida, nenhuma executável** — só o bloco de conferência roda |
| — | `20260924_5_VALIDACAO_antes_depois.sql` | 100% SELECT, rodar inteiro antes e depois |
| — | `20260924_*.rollback.sql` | reversão determinística por ID, a partir das tabelas `_backup_saneamento_*_20260924` |

**Os 538 "PAGO em acordo ATIVO", por prova de causalidade:** A1 = 173 (o motivo
do título nomeia este acordo), A2 = 319 (assinatura exata de
`titulos_por_status_acordo`), **A = 492 / R$ 830.042,13 — só esse entra**;
B = 0; C = 17 boletos do próprio acordo; D = 21 quitados pela liquidação Prime
portador 195; E1 = 5 quitação manual que zerou o valor; E2 = 3 com intervenção
posterior no valor. **46 exceções, nenhuma tocada.**

**Timestamp igual não é prova de causa.** `audit_log.criado_em` tem
`default now()` (timestamp da transação): prova mesma transação, não quem causou
o quê. Por isso cada título do grupo A exige **quatro** evidências simultâneas,
todas recalculadas como guard na execução: (1) a assinatura de campos alterados
casa com uma função conhecida — e no caso A1 o motivo grava o número **deste**
acordo; (2) o `audit_log.id` do título cai **dentro da janela** do seu acordo,
entre o evento dele e o do próximo acordo quitado na mesma transação, o que
descarta backfill em bloco (houve transações quitando 78, 111 e 140 acordos de
uma vez); (3) nenhum valor tocado no evento nem depois — é o que separa a
quitação manual; (4) nenhum registro independente de liquidação. Aplicar só o
teste de timestamp teria levado junto 8 títulos (E1 + E2).

**Efeito no saldo: nenhum.** O que muda é a efetividade da carteira, que hoje
conta R$ 830 mil como "pago" em acordo que ainda está sendo pago.
