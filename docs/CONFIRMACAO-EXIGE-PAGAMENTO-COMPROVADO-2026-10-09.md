# Confirmação de pagamento exige pagamento comprovado — 09/10/2026

**Modo: MEDIÇÃO EM PRODUÇÃO (somente leitura) + ARTEFATOS PRONTOS.**
Nenhuma migration aplicada em produção, nenhum `INSERT`/`UPDATE`/`DELETE`,
nenhum saneamento executado. Leituras no projeto `ahattpqrjmhkzsmnbdzs`.

**Pedido da gestão (09/10/2026), em cinco regras:**

1. importação de títulos, saldo atualizado ou `liquidado_em` sem comprovação não
   podem, isoladamente, gerar confirmação de pagamento;
2. títulos com pagamento efetivamente comprovado devem permanecer protegidos
   contra cobrança indevida;
3. preservar a Rota B dos acordos ativos comprovados;
4. reavaliar os 22 títulos de 08/10 e os casos anteriores, separando pagamentos
   comprovados de entradas indevidas — **sem devolver títulos à cobrança sem
   validar as evidências**;
5. corrigir a interpretação de `valor_pago` e das datas futuras da Prime.

---

## 1. A fonte oficial já tinha a resposta (CLAUDE.md, passo obrigatório)

`docs/integracoes/README.md` → `prime-mapa-fontes-verdade.md` → `prime-api.md`.
O que elas registram, medido em **28/09/2026**, e que a regra de entrada de
18/09 não usava:

| Campo da Prime | No CRM | O que a fonte oficial diz |
|---|---|---|
| `financialStatement[].paymentDate` | `prime_extrato.liquidado_em` | "preenchido em ~100% das linhas do portador 195, **inclusive em títulos que o CRM mantém ABERTO**" — 0 de 302.477 nulos no portador 95. "**Não inferir: presença de `paymentDate` = pagamento**" |
| `paidAmount` | `prime_extrato.valor_pago` | "**dívida corrigida** na data da consulta — NÃO é caixa; pode superar o valor pago real" (no portador 95 aparece como o dobro exato do principal) |
| caixa recebido | `public.pagamentos` | "**Santander**, NUNCA `paidAmount` da Prime" |
| mensalidade liquidada (195) | — | "CONDICIONAL — nunca `paymentDate` isolado" |

**É a causa raiz.** A Rota C da regra de 18/09 tratava "liquidado na Prime sem
prova" como motivo para tirar o título da cobrança e abrir pendência. Como
`liquidado_em` vem preenchido até em parcela em aberto, a importação de títulos
passou a empurrar parcela em aberto para a confirmação.

Evidência direta nos 22 de 08/10: o `valor_pago` da Prime é muito maior que o
título e varia parcela a parcela — título `3363521` de R$ 253,75 com
`valor_pago` R$ 773,47; `761248` de R$ 597,07 com R$ 1.973,80; `4405025` de
R$ 3.227,67 com R$ 11.771,50. É saldo atualizado, não caixa.

---

## 2. As duas filas — e qual foi tocada

| | Fila Confirmação de Pagamento | Confirmação do título (Conferência Prime) |
|---|---|---|
| Onde | `solicitacoes_confirmacao_pagamento` | `acordos_titulos.situacao='EM_CONFIRMACAO'` + `prime_conferencia_decisao` |
| Quem escreve | `trg_pagamentos_gerar_confirmacao` e o botão do operador | `prime_liquidacao_classificar_novas` (cron `:50`) |
| Entrou algo em 08/10? | **não** | **sim: 22 títulos** |

A Fila Confirmação de Pagamento **não recebeu nada** da importação de 08/10: as
4 importações de borderô de 08/10 19:18 UTC (2.956 títulos, **todos `INSERT`
novo** — 0 reaproveitado, 0 `NEGOCIADO`/`PAGO` reaberto) geraram **zero**
solicitação, e nenhum desses títulos está em `EM_CONFIRMACAO`. Das 238
solicitações abertas, 233 têm pagamento do mesmo aluno na mesma data.

---

## 3. A triagem dos retroativos, caso a caso (regra 4)

Universo: `PENDENTE` + `C_SEM_PROVA` + título hoje em `EM_CONFIRMACAO` =
**301 títulos** (22 na janela de 08/10, 279 anteriores).

A evidência **não é reinventada**: vem de `prime_liquidacao_evidencias`, a
função oficial do projeto, com **uma correção medida** — o rateio.

### 3.1 O rateio: a correção que muda o resultado

`pagamento_cobre_o_titulo` da função oficial é **por título**. Em produção, o
pagamento `9e6de3ff` (base R$ 950,16) aparecia como prova dos **quatro** títulos
`761248`–`761251`, que somam R$ 2.388,27. Um pagamento não paga quatro parcelas.

Com o rateio — a base do pagamento tem de cobrir ≥95% da **soma** dos títulos
que reivindicam o mesmo pagamento — só o pagamento `6f4bf6a3` (base R$ 492,93
contra dois títulos de R$ 445,25) prova de fato. Os quatro do `9e6de3ff` caem
para "a validar".

### 3.2 As quatro classes, precedência fixa

| Classe | Critério | Destino |
|---|---|---|
| **1 PAGAMENTO_COMPROVADO** | pagamento `BAIXADO` em `public.pagamentos` (fonte Santander), ±10 dias da liquidação, cobrindo ≥95% da **soma** dos títulos que o reivindicam | **fica protegido**, e é promovido a `A_PAGAMENTO_COMPROVADO` |
| **2 ACORDO_COMPROVADO** | composição documental de acordo ATIVO/QUITADO, ou vínculo ativo | fica (Rota B preservada) |
| **3 EVIDENCIA_A_VALIDAR** | pagamento próximo que não cobre ou compartilhado; acordo candidato ±30 dias sem composição; CPF do extrato divergente; acordo cancelado no histórico; `liquidado_em` posterior à coleta | **fica na fila**, decisão humana. Nunca devolvido por script |
| **4 SEM_EVIDENCIA** | nada do acima | única classe devolvível |

### 3.3 O resultado medido (09/10/2026)

| janela | classe | qtd | valor | alunos |
|---|---|---:|---:|---:|
| **08/10 (22)** | 1 PAGAMENTO_COMPROVADO | **2** | R$ 445,25 | 1 |
| **08/10 (22)** | 3 EVIDENCIA_A_VALIDAR | **20** | R$ 12.777,84 | 8 |
| **08/10 (22)** | 4 SEM_EVIDENCIA | **0** | — | — |
| anteriores (279) | 1 PAGAMENTO_COMPROVADO | 1 | R$ 329,28 | 1 |
| anteriores (279) | 3 EVIDENCIA_A_VALIDAR | 111 | R$ 71.584,47 | 61 |
| anteriores (279) | 4 SEM_EVIDENCIA | 167 | R$ 218.308,72 | 123 |

> **Nenhum dos 22 de 08/10 pode ser devolvido à cobrança.** Zero estão sem
> evidência: 2 têm pagamento comprovado e 20 têm evidência a validar.
>
> **Isto corrige a entrega anterior desta frente**, que devolvia os 22 em bloco.
> O arquivo `20261009_SANEAMENTO_retirar_da_confirmacao_0810.sql.pendente` foi
> substituído por este desenho e não existe mais.

---

## 4. O que a migration faz (regras 1, 2, 3 e 5)

[`supabase/migrations/20261009180000_confirmacao_exige_pagamento_comprovado.sql`](../supabase/migrations/20261009180000_confirmacao_exige_pagamento_comprovado.sql)
— só DDL, duas funções, com trava de `md5` na entrada e na saída.

| Regra | Mudança |
|---|---|
| 1 | `prime_liquidacao_classificar_novas`: o subgrupo `C_SEM_PROVA` deixa de chamar `prime_liquidacao_suspender`. A classificação continua gravada em `prime_liquidacao_classificacao` (a trilha não se perde) e o título continua `ABERTO`/`NEGOCIADO`, com o valor que tinha |
| 2 e 3 | Rotas A e B **byte a byte como antes**: pagamento comprovado e acordo comprovado continuam suspendendo e entrando na fila, protegidos da cobrança |
| 5 | **guarda de data** nos dois lugares que decidem — na elegibilidade da rotina e em `liquidacao_real` dentro de `prime_liquidacao_evidencias`: `liquidado_em` posterior a `coletado_em` ou no futuro não é pagamento ocorrido. A evidência passa a expor `liquidado_depois_da_coleta` e `valor_pago_e_divida_corrigida` |

Intocados: `prime_liquidacao_suspender`,
`prime_liquidacao_reavaliar_pendentes`, a Conferência Prime, a Fila Confirmação
de Pagamento, `trg_pagamentos_gerar_confirmacao`, saldo, parcela, acordo,
pagamento, baixa, honorário, responsável e reposição.

**Exposição da guarda de data, medida:** a coleta do extrato de 09/10 trouxe
20.838 linhas, 5 com `liquidado_em` no futuro (até 05/12/2026). Mas dos 3.058
títulos vivos que hoje casam com a forma "liquidação real", **0** seriam
barrados, e dos 301 `PENDENTE`, **0** têm `liquidado_em` depois da coleta. A
guarda é **preventiva** — não reclassifica nada hoje.

**Rollback:** [`supabase/rollbacks/20261009180000_….rollback.sql`](../supabase/rollbacks/20261009180000_confirmacao_exige_pagamento_comprovado.rollback.sql)
restaura as duas funções com o texto de produção (`md5(prosrc)`
`b614689e…` e `4840e523…`) e confere o `md5` no fim.

---

## 5. O que a triagem/saneamento faz (regra 4) — NÃO APLICADO

[`supabase/aguardando_aprovacao/20261009_TRIAGEM_E_SANEAMENTO_confirmacao.sql.pendente`](../supabase/aguardando_aprovacao/20261009_TRIAGEM_E_SANEAMENTO_confirmacao.sql.pendente)

**Prévia por default:** sem `set_config('saneamento.aplicar','on')` a transação
inteira aborta no fim, depois de imprimir a triagem e conferir as travas.

| Portão (GUC) | Default | O que liga |
|---|---|---|
| `saneamento.aplicar` | `off` | grava (senão desfaz tudo) |
| `saneamento.promover` | `on` | classe 1 → `A_PAGAMENTO_COMPROVADO`, **seguindo protegida** em `EM_CONFIRMACAO`/`PENDENTE` |
| `saneamento.devolver` | `off` | classe 4 volta à cobrança |
| `saneamento.janela_toda` | `off` | inclui os anteriores a 08/10 |

**Com os defaults e a janela de 08/10: 2 títulos promovidos, 0 devolvidos.**
Alcançar os 167 antigos sem evidência exige ligar `saneamento.janela_toda` e
`saneamento.devolver` explicitamente — decisão da gestão, com remedição.

Travas que recusam a transação inteira: **T1** título com marca de
pagamento/encerramento no universo; **T2** devolução alcançando classe 1, 2 ou
3; **T3** mudança em `pagamentos`, `baixas_pagamento`, `acordo_titulo_vinculo`,
`parcelas`, `acordos` ou na Fila Confirmação de Pagamento; **T4** soma de
honorários; **T5** quantidade de cada ação diferente da medição (as travas
conferem o que a rodada **vai fazer**, não o tamanho do universo); **T6** a
promoção tirando alguém de `EM_CONFIRMACAO`/`PENDENTE`.

Backup em `_backup_triagem_confirmacao_20261009` (linha inteira em `jsonb`,
lote `triagem_20261009180000`). PITR não está habilitado neste projeto: a tabela
de backup **é** o caminho de volta, e o desfazer está no fim do arquivo.

**Ordem obrigatória:** migration primeiro. Sem ela o cron `:50` segue mandando
título em aberto para a fila.

---

## 6. Consequência assumida e pontos abertos

**Consequência:** liquidação da Prime sem prova volta a ficar **dentro** do
saldo cobrável, das ações massivas e da cobrança — era o que a regra de 18/09
tirava, nascida da auditoria dos 407 A1 em que 371 foram revertidos. O risco
troca de lado: menos confirmação indevida, mais chance de cobrar quem pagou por
fora do extrato. É exatamente por isso que a regra 4 exige validar evidência
antes de devolver qualquer título que **já** está na fila.

Pontos abertos, decisão da gestão:

1. **os 167 antigos sem evidência** (R$ 218.308,72 / 123 alunos) — fora dos
   defaults;
2. **os 131 "a validar"** (20 de 08/10 + 111 antigos) precisam de olhar humano
   na Conferência Prime; nenhum script decide por eles;
3. **a causa a montante na origem:** por que o extrato da Prime traz
   `liquidado_em` em boleto que segue aberto — isso é limitação já documentada
   em `prime-gaps.md` (🔴 VERMELHO: "evento de pagamento da mensalidade
   corrente" não é exposto pela API). A guarda de data cobre o sintoma das datas
   impossíveis, não a limitação da fonte.

---

## 7. Testes

```
supabase/tests/confirmacao_exige_pagamento_comprovado.test.js   18 ✓
supabase/tests/triagem_e_saneamento_confirmacao.test.js         10 ✓
```

Ambos rodam as migrations **reais** em PostgreSQL real (PGlite) sobre a fixture
de produção do grupo A (50 funções com o texto exato de `pg_get_functiondef`,
cada corpo conferido por `md5`), e o segundo roda o **arquivo real** do
saneamento, nos dois modos. O teste do rateio reproduz em miniatura o caso dos
quatro títulos num pagamento.
