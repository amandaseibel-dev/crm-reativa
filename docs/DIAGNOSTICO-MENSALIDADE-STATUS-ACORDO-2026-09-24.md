# Mensalidade vinculada: QUITADO ou NEGOCIADO — diagnóstico e desenho da correção

**24/09/2026 · leitura de produção · NADA APLICADO**

Pergunta da Amanda: *"por que tem mensalidades vinculadas como QUITADO ou
NEGOCIADO? Os acordos foram quitados, o status da mensalidade deve virar
QUITADO; e quando a negociação ainda está em andamento a mensalidade precisa
ficar como NEGOCIADA — lembrando que não deve contabilizar o valor negociado +
acordo, apenas o acordo soma na base."*

**Resposta curta.** A regra que ela descreve já existe e está escrita
exatamente assim desde 02/09. O que falha é que ela só é aplicada **no instante
da virada** — e nada reconfere depois. Duas populações ficaram fora do lugar.
Sobre a base: **não há dupla contagem** (só um caso, R$ 428,72), mas as
mensalidades marcadas "quitada" indevidamente **inflam a efetividade**.

---

## 1. A regra oficial e onde ela vive

`supabase/migrations/20260902114613_mensalidade_segue_o_acordo_quitado.sql`:

| status do acordo | mensalidade vinculada |
|---|---|
| QUITADO (sem parcela viva) | `situacao = PAGO` / `status = quitada` |
| ATIVO | `situacao = NEGOCIADO` / `status = vinculada` |
| CANCELADO | não reabre a mensalidade (regra de 22/09) |

Três gatilhos em `acordos` disparam em `after update of status`:
`_titulo_quita_com_o_acordo`, `titulos_por_status_acordo` e
`_acordo_status_reavalia_titulos` → `titulo_reavaliar` (o motor único).

## 2. Por que existe o desencontro

**`titulo_reavaliar` trata PAGO como estado terminal** (desde
`20260914081816`). Quando o acordo sai de QUITADO e volta para ATIVO, o gatilho
`trg_acordo_status_reavalia_titulos` dispara, chama o motor — e o motor desiste
na primeira linha ("já paga: nada aqui reabre mensalidade quitada"). A
mensalidade fica "quitada" para sempre.

Ser terminal está certo: é o que protege mensalidade paga de verdade. O que
falta é **saber por que ela virou PAGO** — hoje não existe esse campo.

No outro sentido: os 65 títulos NEGOCIADO em acordo QUITADO têm vínculo criado
**depois** de o acordo já ter virado quitado (09/09 e 12/09; 42 dos 44 acordos
viraram QUITADO entre 31/08 e 09/09). Sem uma nova virada de status, nenhum
gatilho dispara de novo.

## 3. As populações, medidas título a título

### 3.1 G1 — NEGOCIADO com acordo QUITADO → deveria estar quitada

| | |
|---|---|
| títulos | **65** |
| acordos / alunos | 44 / 44 |
| valor | **R$ 41.642,41** |
| estado atual | `NEGOCIADO` / `vinculada` (65 de 65) |
| estado esperado | `PAGO` / `quitada`, mesmo `acordo_id` |

Os 44 acordos estão quitados **de verdade**: 58 parcelas, **todas PAGO**, zero
parcela fora de (PAGO, CANCELADA, RENEGOCIADA) — que é exatamente o predicado
que `titulo_reavaliar` usa. Aqui não há causalidade a provar: é a regra de hoje
aplicada a um registro que o motor nunca visitou.

Lista completa de IDs: [`20260924_2_saneamento_g1_65_...`](../supabase/aguardando_aprovacao/20260924_2_saneamento_g1_65_negociado_em_acordo_quitado.sql.pendente), bloco 0.

### 3.2 G2 — PAGO com acordo ATIVO: 538 títulos, separados por prova de causalidade

| grupo | o que é | títulos | acordos | valor | destino |
|---|---|---|---|---|---|
| **A1** | motivo do título **nomeia este acordo** | 173 | 57 | R$ 173.773,28 | volta para NEGOCIADO |
| **A2** | assinatura exata de `titulos_por_status_acordo` | 319 | 88 | R$ 656.268,85 | volta para NEGOCIADO |
| | **A = A1 + A2** | **492** | **145** | **R$ 830.042,13** | |
| **B** | pagamento/baixa própria | **0** | — | — | — |
| **C** | boleto do próprio acordo | 17 | 14 | R$ 6.030,79 | fica de fora |
| **D** | quitado pela liquidação Prime (portador 195) | 21 | 10 | R$ 8.181,97 | fica de fora |
| **E1** | quitação manual que zerou o valor | 5 | 1 | R$ 0,00 | fica de fora |
| **E2** | intervenção posterior mexeu no valor | 3 | 1 | R$ 0,00 | fica de fora |
| | **total** | **538** | | **R$ 844.254,89** | |

> **Correção de dois números meus.** Primeiro falei em "521 = 538 − 17"; depois
> em 500. Os dois estavam errados. **A conta final é 492 + 46.** O que derrubou
> os 8 a mais foi justamente refazer a prova de causalidade — ver a seção 4.

## 4. A prova de que o PAGO veio do acordo

### 4.1 Por que "mesma transação" não bastava

`audit_log.criado_em` tem `DEFAULT now()`, que em Postgres é o timestamp da
**transação**. Timestamp igual prova que os dois UPDATEs estão na mesma
transação — **e só isso**. Não diz qual causou qual, e não exclui um terceiro
processo que tenha escrito os dois. A primeira versão desta correção parava aí
e teria levado junto **8 títulos que não foram quitados pelo acordo**.

### 4.2 As quatro evidências exigidas, todas ao mesmo tempo

**(1) Conteúdo — a assinatura da função que escreveu.** O conjunto exato de
campos alterados naquele UPDATE casa com uma função conhecida, e só uma:

- **A1** → `(atualizado_em, motivo_ajuste, situacao, status)` **e** o motivo
  ganhou o texto `quitada junto com o acordo <N>`, com `<N>` sendo o número
  **deste** acordo. A função grava o número do acordo que disparou: a própria
  linha diz quem a causou.
- **A2** → `(atualizado_em, situacao, status)` ou `(atualizado_em, situacao)`,
  com o motivo **inalterado**. É a assinatura de `titulos_por_status_acordo`, a
  única função que quita título escrevendo só `situacao` (o `status` vem do
  gatilho de coerência `_titulo_situacao_e_status_coerentes`; nas linhas de
  agosto, anteriores a esse gatilho, o `status` nem mudou). E o `WHERE` dela é
  literalmente `v.acordo_id = new.id`: ela só toca título vinculado **ao acordo
  que acabou de virar QUITADO**.

**(2) Ordem / identificadores — a janela do gatilho.** `audit_log.id` é
sequencial. O evento do título está **depois** do evento do seu acordo e
**antes** do evento do próximo acordo quitado na mesma transação. É o padrão de
gatilho: o UPDATE do título roda dentro dos AFTER triggers do UPDATE daquele
acordo. Um backfill em bloco (`update acordos…; update acordos_titulos…`) poria
todos os títulos depois de todos os acordos.

Isso importou de verdade: várias dessas transações quitaram **78, 111 e 140
acordos de uma vez** — são lotes de rotina, não baixas individuais. Medido:
**0 título fora da janela, 0 título escrito antes do seu acordo.**

**(3) Nenhum valor tocado — nem no evento, nem depois.** A quitação manual pela
tela (`quitar_e_encerrar_caso`) zera `saldo_corrigido` e `valor_em_aberto` no
mesmo UPDATE — assinatura inconfundível. Quem tem qualquer mexida em valor, no
evento ou em qualquer evento posterior, está fora (E1 e E2).

**(4) Nenhum registro independente de liquidação.** `origem_liquidacao` e
`origem_encerramento` nulas, nenhum casamento em `pagamentos.titulo_numero` nem
em `conferencia_pagamentos.titulo_numero`, nenhuma linha em
`solicitacoes_confirmacao_pagamento.titulo_id`. Vale para os 538 — por isso o
grupo B é vazio.

**Não sobrou nenhum título com assinatura desconhecida:** 538 = 492 + 46, sem
resto. Se sobrasse, estaria listado como exceção, não dentro do lote.

Confirmação independente pelo outro lado: os 145 acordos **todos** têm no
`audit_log` a transição QUITADO → ATIVO, entre 31/08 e 09/09.

### 4.3 As exceções, nomeadas

**C — 17 títulos, `tipo_boleto = 'Acordo'`.** Não é mensalidade. Razão técnica,
não estética: `_titulo_quita_com_o_acordo` já os exclui desde `20260831140000`
(`and coalesce(t.tipo_boleto,'') <> 'Acordo'`), e `titulos_por_status_acordo`
diz no comentário — *"Ele nunca foi dívida: é o número do documento"*. Entraram
porque essa segunda função **não tinha o filtro** (corrigido no arquivo 1).
Documentos todos no padrão `05xxxxxxxxxx`, `saldo_corrigido = 0,00`.

| título | acordo | doc | valor |
|---|---|---|---|
| 03b09cbc-50c6-4b5a-954b-1adf36d7bcec | 2295 | 050650980003 | 497,60 |
| 058b4d87-7689-48a5-80d3-52ba944db56c | 593 | 050637840003 | 461,72 |
| 0df2d7ef-3d87-42fa-b2c6-c9902ef36f09 | 793 | 050641990003 | 187,44 |
| 1d2a22ba-624d-4a1a-9d7a-f95020318ea1 | 477 | 050613430004 | 538,09 |
| 31f0486d-ee00-4a4d-9fa2-796f43ce7dfe | 1642 | 050638600004 | 170,92 |
| 637811a3-c305-4468-92b2-02a3c21ae49d | 2353 | 050624030004 | 462,99 |
| 78218f45-8c44-4456-83c7-aa9693a60158 | 277 | 050452620006 | 720,25 |
| 87e59401-74ec-46d6-9de3-a2ecef785ac7 | 2003 | 050644050006 | 175,17 |
| 99d1e025-def1-4930-bb35-6ff1694e3817 | 2098 | 050643690003 | 399,55 |
| a1e554d3-dbd0-418b-81b7-ebaf8730c256 | 2175 | 050491660006 | 513,85 |
| a86bad79-3449-40b4-a902-69a8a3cbedf8 | 735 | 050663980007 | 338,72 |
| aeb3a814-5388-40c5-b8a2-e522634b7c5a | 2175 | 050491660005 | 513,83 |
| bcd6ccea-6946-40b0-b308-1cc1c16238ec | 599 | 050648250003 | 186,15 |
| e74ebd97-a267-4fb4-afb0-a9c69b8aa7fd | 2003 | 050644050005 | 175,17 |
| f36bc35c-1af2-45c0-bd19-4633b96ac992 | 319 | 050614420004 | 208,68 |
| f8fdb715-31cc-44fa-8cf4-2041ee14c9f6 | 1755 | 050608170005 | 309,73 |
| ff927460-672a-46cb-96ac-06022f52cf6e | 1642 | 050638600005 | 170,93 |

**D — 21 títulos, evidência independente de pagamento.** Todos quitados em
**09/09/2026 12:44:23.75972 UTC**, na mesma transação, com `acordo_id` sendo
**gravado no mesmo UPDATE** e motivo *"vinculado pelo Prime: liquidado no
portador 195 junto com as outras mensalidades"*. **Não existe evento de
acordo→QUITADO nessa transação**: não foi o acordo que os quitou, foi a regra
de liquidação da Prime.

Observação para decisão futura, fora deste pacote: a premissa do portador 195
foi revista em 18/09 ("a lista é por CPF, não por título"), então esses 21
merecem conferência própria, na Conferência Prime, não aqui. 4 deles (docs
4093469, 4093471, 4093472, 4093473 — acordo 1522) nem têm linha em
`acordo_titulo_vinculo`: só `acordo_id`.

| título | acordo | doc | valor |
|---|---|---|---|
| 06ba15bb-b40a-403a-ba58-7d64eaa0514a | 597 | 1164419 | 467,13 |
| 0745ec7c-8836-4116-ba5a-291bb6d1ceb0 | 1522 | 4093469 | 203,85 |
| 12e45ef8-4eef-41ed-9c73-a811e44c06ef | 776 | 500626 | 840,68 |
| 14cfe202-275b-46a7-8a8d-3c0b190daec3 | 2113 | 4098674 | 436,80 |
| 237cf96c-181d-4793-a562-afa33e67c6d2 | 2664 | 4191334 | 311,88 |
| 2918773a-c056-4719-a915-2a8a88591ce9 | 1522 | 4093472 | 203,85 |
| 2d72e4eb-aa87-44c8-85a2-2f0960953804 | 597 | 1164420 | 467,13 |
| 3c9a1f2b-d779-42e7-a3d4-4f81d5425190 | 2223 | 4262736 | 568,40 |
| 5a520d2d-eab7-4205-9781-445172ae3313 | 2223 | 4262737 | 568,41 |
| 73fe24e9-2b76-4d8c-8409-77d8d1ffec6a | 349 | 4177123 | 144,69 |
| 88cebd85-ab56-4238-a990-3236a9643983 | 349 | 4177126 | 144,72 |
| 8bd5d2c2-9704-4fd9-beed-924ab59be7ca | 1102 | 3919471 | 378,75 |
| 8e0460bb-bf9d-4261-8ce1-ae0088cb9707 | 1522 | 4093473 | 203,85 |
| 9644f4f1-5985-455c-a406-51b21e44ff10 | 349 | 4177125 | 144,69 |
| b31efa83-2d82-4b23-b534-b554da7a1b52 | 2223 | 4262735 | 568,40 |
| b7efc5c0-41f8-4ed4-9f92-8ea0b1b95979 | 2113 | 4098673 | 436,80 |
| c477a43a-c9aa-4536-bca2-cc3f1788c048 | 1522 | 4093471 | 203,85 |
| dade739a-5ef7-43ec-a9f0-f7d24f69cb15 | 2609 | 4210232 | 780,18 |
| dbb8bb1f-aca2-481c-adcf-cc6965f1fa7e | 2664 | 4191332 | 311,94 |
| e4a6a05c-3196-4d3f-a81b-2517c0774c29 | 1102 | 3919470 | 378,73 |
| f963f705-a48f-4135-83a1-3ebfa4331263 | 2198 | 4135361 | 417,24 |

**E1 — 5 títulos, quitação manual.** Sandra Thalyta Barros de Melo, acordo
2922, 24/08/2026 13:09:05. O UPDATE zerou `saldo_corrigido` (de R$ 1.409,30 /
1.409,32 / 1.043,94 para 0,00) e o motivo termina em *"(reconciliação 24/08:
quitar tudo havia falhado por timeout) por amanda.seibel@aelbra.com.br"*. Foi
decisão de reconciliação, não consequência do acordo.

| título | doc |
|---|---|
| e375b5f2-ed46-471a-8e32-722112955878 | 4206257 |
| 3db898c6-4b07-413c-b0bf-73bd350ed9b9 | 4206258 |
| 79fc2b94-c0e5-442a-b3f3-2afc4713a68d | 4206259 |
| caa68f25-17c9-4f49-a50e-1111ee7ceb08 | 4206260 |
| 5bc36b6c-199f-4ab7-a51e-922ee9d56642 | 4206261 |

**E2 — 3 títulos, intervenção posterior.** Gabriel Rocha Mota, acordo 2681. O
título virou PAGO pelo acordo, mas em 31/08/2026 um evento **posterior**
(amanda.seibel) gravou `status = 'quitada'` zerando `saldo_corrigido` e
`valor_em_aberto`. O estado de hoje tem duas causas sobrepostas; reabrir
devolveria uma mensalidade negociada com valor zero.

| título | doc |
|---|---|
| e1127398-25c3-43b7-b588-61baadf0691f | 4302176 |
| 6e05eb54-089e-4be7-b8a2-644a7cf2d33b | 4302177 |
| 9c78e1e8-0da7-42ec-b0b5-61032e8b475c | 4302178 |

## 5. A base: dupla contagem

As duas funções que mandam no saldo — `aluno_saldo_pendente_detalhe` e
`saude_carteira_panorama` — **já respeitam a regra**: excluem a mensalidade
NEGOCIADA que tem vínculo vivo e contam só a parcela do acordo.

Medido: **0** título ABERTO com acordo. Só **17** NEGOCIADO órfãos somam
(R$ 3.841,62), e **16** são de acordo CANCELADO — a dívida volta de propósito,
regra de 22/09.

**Sobra um caso de dobra real: R$ 428,72** (Suelen, seção 7).

**Mas** em `carteira_2026_1_classificar`, `situacao = 'PAGO'` entra como
EFETIVIDADE "Pago / Quitado". As 492 do grupo A estão contando como dinheiro
recuperado em acordo que ainda está sendo pago: **R$ 830.042,13 no balde
errado**. É esse o efeito real do problema.

## 6. Desenho da correção estrutural

**Proveniência gravada, não inferida.** Três colunas novas em
`acordos_titulos`:

```
quitacao_origem            text        -- 'ACORDO' (único valor hoje)
quitacao_origem_acordo_id  uuid        -- qual acordo
quitacao_origem_em         timestamptz -- quando
```

Escritas **no mesmo UPDATE** que marca a mensalidade como paga por causa do
acordo, nos três caminhos. A porta de reabertura em `titulo_reavaliar` lê esse
campo — nunca data, valor ou ausência de evidência contrária — e exige,
cumulativamente:

- `quitacao_origem = 'ACORDO'` **e** `quitacao_origem_acordo_id` = o acordo vivo do vínculo hoje;
- esse acordo **não** está QUITADO agora;
- `tipo_boleto <> 'Acordo'`;
- `origem_liquidacao` nula e `origem_encerramento` nula;
- zero pagamento próprio em `pagamentos`, `conferencia_pagamentos` e `solicitacoes_confirmacao_pagamento`.

Qualquer uma falhando, **PAGO continua terminal**, como hoje. Ausência de prova
não abre a porta.

**A migration estrutural é inerte para o histórico:** as 492 linhas de hoje têm
`quitacao_origem` NULA, então ela sozinha não reabre nenhuma.

Vai junto a correção de `titulos_por_status_acordo`, que estava mais frouxa que
as irmãs (sem guarda de parcela viva, sem excluir o boleto do próprio acordo) —
a origem dos 17 do grupo C.

> **Revisão de 25/09 — eram DUAS portas, não uma.** Os três gatilhos de `acordos`
> disparam na mesma transição de status, e o **motor** (`titulo_reavaliar`)
> também não excluía `tipo_boleto = 'Acordo'`: ele remarcava como "quitada" o
> boleto que as irmãs acabavam de poupar. Corrigir só
> `titulos_por_status_acordo` deixaria o defeito do grupo C produzindo casos
> novos. O arquivo 1 passou a exigir `coalesce(v_tipo,'') <> 'Acordo'` também em
> `v_quitado`, e há teste para os dois lados. Matriz completa por status do
> acordo: [`REGRA-TITULO-REAVALIAR-POR-STATUS-DO-ACORDO.md`](REGRA-TITULO-REAVALIAR-POR-STATUS-DO-ACORDO.md).

## 7. Caso Suelen Rossi Machado — separado, e sem escolha feita

Título `050701930003` (`caa99e1e-4f70-48c6-9a37-0993e75fa306`), R$ 428,72,
vencimento 28/10/2026, `tipo_boleto = 'Acordo'`, NEGOCIADO/vinculada.

As duas representações discordam: `acordos_titulos.acordo_id` → **3528
(ATIVO)**; `acordo_titulo_vinculo` → **3609 (CANCELADO)**.

**A fonte oficial é o 3528**, e a prova não depende de data nem de valor
isolado:

1. O documento `050701930003` é `'0' + 50701930003`, e `50701930003` é o
   `parcelas.boleto` da **parcela 2 do acordo 3528** — R$ 428,72, vencimento
   28/10/2026, A_VENCER. Número, valor e vencimento batem os três.
2. O 3609 é **duplicata** do 3528: mesmo `valor_total` (R$ 1.714,89), mesmas 4
   parcelas; criado 27/08 13:31 e **cancelado 27/08 14:47**, 1h16 depois, todas
   as parcelas CANCELADA.
3. O dinheiro está no 3528: entrada de R$ 1.000,00 paga em 25/08 e parcela 1 de
   R$ 428,72 paga em 08/09. O 3609 nunca recebeu nada.

Como ficou preso (audit_log do título): 31/08 22:29 rotina vincula ao 3609 (já
cancelado) → 01/09 00:07 volta a ABERTO → 01/09 17:24 rotina vincula ao 3528
**pela coluna** → 09/09 12:26 volta a ABERTO → 10/09 14:44 Amanda vincula de
novo ao 3528. A linha de vínculo nunca saiu do 3609.

**Efeito hoje:** o título é "negociado órfão" (soma R$ 428,72) **e** a parcela 2
soma R$ 428,72 — a mesma dívida duas vezes na ficha da aluna.

### As duas opções, lado a lado

| | **Opção 1** — mover o vínculo para o 3528 | **Opção 2** — marcar `DUPLICADA` |
|---|---|---|
| **parcela** | nenhuma alterada; a parcela 2 segue A_VENCER, R$ 428,72, venc 28/10 | idêntico: nenhuma alterada |
| **saldo** | −R$ 428,72: o título deixa de ser órfão (passa a ter vínculo vivo) e sai da conta; a dívida fica só na parcela | −R$ 428,72: `DUPLICADA` não entra no filtro `situacao in (ABERTO, NEGOCIADO)` das duas funções de saldo |
| **vínculo** | a linha passa a apontar para o 3528; coluna e tabela ficam iguais | a linha **continua** no 3609 cancelado; a divergência permanece |
| **exibição no CRM** | tag "Negociado" + linha "Vinculada ao acordo R$ 1.714,89 em 4x — não somada de novo no total"; segue na lista de mensalidades | tag "Fora da conta", fundo neutro; sai da leitura de dívida da ficha |
| **composição do acordo** | o boleto da parcela aparece ao lado das parcelas do mesmo acordo — que é exatamente o que a rotina de 01/09 registrou como problema | o título sai da composição; quem lê o acordo vê só as 5 parcelas |
| **o que fica sem resolver** | o título segue `tipo_boleto = 'Acordo'` dentro da lista de mensalidades | a divergência de vínculo fica de pé e pode reaparecer em outra rotina |
| **reversão** | trivial, rollback pronto | trivial, rollback pronto |

As duas podem ser **combinadas** (mover o vínculo *e* marcar DUPLICADA), o que
resolve os dois resíduos. No arquivo 4, as duas estão escritas e **as duas estão
comentadas** — só o bloco de conferência (100% SELECT) é executável.

## 8. O que muda e o que não muda

| | efeito |
|---|---|
| saldo em aberto (global e por aluno) | **nenhum**, exceto −R$ 428,72 se a Suelen for tratada |
| saldo vencido | **nenhum**, mesma exceção |
| pagamentos / parcelas / baixas / vínculos | **nada é tocado** |
| efetividade "Pago / Quitado" | −R$ 830.042,13 (G2-A) e +R$ 41.642,41 (G1) |
| efetividade "Negociado" | o caminho inverso |

Por que o saldo não muda: PAGO e NEGOCIADO-com-vínculo-vivo estão **os dois
fora** da conta, nas duas funções de saldo. Só o rótulo e o balde da carteira
mudam.

Baseline global medido em 24/09/2026 para comparação:
`saldo_total = R$ 43.137.668,05`, `saldo_vencido = R$ 37.435.537,87`,
12.896 alunos com saldo. Alunos afetados: 212, `saldo_total = R$ 619.926,08`,
`saldo_vencido = R$ 188.911,73`.

## 9. Os arquivos, e a ordem

Todos em `supabase/aguardando_aprovacao/`, com extensão `.pendente` para o CLI
não aplicar em deploy.

| ordem | arquivo | o que é |
|---|---|---|
| 1 | `20260924_1_estrutural_...sql.pendente` | regra permanente; não toca em dado histórico |
| 2 | `20260924_2_saneamento_g1_65_...sql.pendente` | os 65, pelo motor `titulo_reavaliar` |
| 3 | `20260924_3_saneamento_g2a_492_...sql.pendente` | os 492, grava a prova e deixa o motor decidir |
| 4 | `20260924_4_suelen_...sql.pendente` | o caso isolado, sem execução |
| — | `20260924_5_VALIDACAO_antes_depois.sql` | 100% SELECT, rodar antes e depois |
| — | `*.rollback.sql` (4) | reversão determinística por ID |

**Guards (abortam a transação):** quantidade, soma financeira, valor por título,
estado anterior esperado, vínculo vivo único para o acordo esperado, acordo
ainda no status esperado, ausência de pagamento próprio e — no arquivo 3 — as
quatro evidências de causalidade recalculadas, mais a conferência de que as 46
exceções continuam fora.

**Backup por ID** (sem PITR, é a única volta): `_backup_saneamento_g1_20260924`,
`_backup_saneamento_g2a_20260924`, `_backup_saneamento_suelen_20260924` —
agora com **fotografia do estado posterior** (`*_pos`) e a **marca-d'água do
`audit_log`**, que é o que permite ao rollback comparar campo a campo com o que a
correção deixou, em vez de aceitar qualquer linha que pareça estar no estado
esperado (ver o `LEIA-ME.md` da pasta) —
guardam `to_jsonb(titulo)` inteiro, os vínculos, o acordo e seu status,
situação, status, `acordo_id`, `origem_liquidacao` (+ref/em),
`origem_encerramento`, proveniência, `motivo_ajuste`, o `audit_log.id` e o
instante do evento que provou a causalidade, a assinatura de campos alterados,
o motivo da correção e o timestamp.

## 10. Resultado esperado da validação antes/depois

> **Baseline relido em 25/09.** A base é viva: os contadores globais andaram em
> um dia. As **populações do saneamento não** — ver
> [`REVISAO-PROVENIENCIA-GRUPO-A-2026-09-25.md`](REVISAO-PROVENIENCIA-GRUPO-A-2026-09-25.md), §7.
> A coluna "antes" abaixo traz as duas leituras; **nenhum guard depende dos
> contadores globais**, só da lista e da soma dos grupos, que estão idênticas.

| medida | antes (24/09) | antes (25/09) | depois |
|---|---|---|---|
| NEGOCIADO × acordo QUITADO | 65 | **65** | **0** |
| PAGO × acordo ATIVO | 538 | **538** | **46** (C 17 + D 21 + E1 5 + E2 3) |
| NEGOCIADO × acordo ATIVO | 3.059 | 3.057 | 3.549 |
| PAGO × acordo QUITADO | 1.081 | 1.160 | 1.225 |
| títulos PAGO (total) | 5.341 | 5.421 | 4.994 |
| títulos NEGOCIADO (total) | 3.140 | 3.122 | 3.549 |
| `saldo_total` global | R$ 43.137.668,05 | R$ 43.150.942,10 | igual ao de antes |
| `saldo_vencido` global | R$ 37.435.537,87 | R$ 37.557.324,44 | igual ao de antes |
| negociado órfão (dobra) | 17 / R$ 3.841,62 | 16 / R$ 3.412,90 *(só se a Suelen for tratada)* |
| pagamentos, parcelas, vínculos, acordos | — | **iguais, item a item** |

## 11. O que este pacote NÃO faz

- Não aplica nada: tudo em `aguardando_aprovacao/` com `.pendente`.
- Não toca nos 17 do grupo C, nos 21 do D, nos 5 do E1 nem nos 3 do E2.
- Não mexe em pagamento, parcela, baixa, acordo ou vínculo.
- Não cria rotina nem cron.
- Não decide o caso Suelen: entrega o diagnóstico e as duas opções, nenhuma
  executável.
