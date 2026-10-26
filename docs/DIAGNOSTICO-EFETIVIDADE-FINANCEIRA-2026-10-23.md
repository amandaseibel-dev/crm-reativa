# Diagnóstico — Efetividade Financeira e Saldo Real

**Data:** 2026-10-23 · **Natureza:** SOMENTE LEITURA · **Projeto PROD:** `ahattpqrjmhkzsmnbdzs`

Nada foi aplicado, alterado, mesclado ou corrigido. Nenhuma migration, nenhum
cron, nenhum saldo, pagamento, acordo ou baixa foi tocado. Os números abaixo
foram medidos em produção nesta data; o código foi lido de `origin/main`
(a árvore local está **492 commits atrás** da main e não serve de fonte).

Fontes oficiais consultadas antes de qualquer medição, conforme `CLAUDE.md`:
[`docs/integracoes/README.md`](integracoes/README.md) e
[`prime-mapa-fontes-verdade.md`](integracoes/prime-mapa-fontes-verdade.md).

---

## 1. Resposta direta às duas perguntas centrais

> **"Conseguimos fechar matematicamente o saldo de cada semestre?"**

**Sim, e isso é exatamente o problema.** As quatro réguas fecham com
`diferença = 0,00` em todos os recortes — mas fecham por **identidade
algébrica**, não por conferência financeira. O fechamento é uma tautologia
embutida na própria fórmula e **não prova nada sobre dinheiro**.

> **"De onde saiu cada real recuperado?"**

**Hoje, de lugar nenhum rastreável, na maior parte.** O valor que a
Efetividade chama de "recuperado" **nunca é lido da tabela `pagamentos`**. Ele
é calculado como **rateio do status das parcelas**. Medido em produção:

| | Valor | |
|---|---:|---|
| Recuperado **declarado** pelas réguas (2024+2025+2026/1+2026/2) | **R$ 7.536.194,00** | soma dos snapshots + 2026/2 ao vivo |
| Caixa em `pagamentos` que **alcança um semestre de origem** | **R$ 4.772.446,60** | 2.712 de 10.715 pagamentos |
| Caixa em `pagamentos` **sem semestre de origem determinável** | **R$ 8.924.736,38** | 65,2% do caixa |

As duas colunas **não se reconciliam e nunca foram reconciliadas** — medem
coisas diferentes, por caminhos independentes, e ninguém cruza as duas.

---

## 2. Como a Efetividade calcula hoje (pergunta 1)

Existem **quatro réguas distintas**, com metodologias diferentes, para a mesma
pergunta financeira:

| Recorte | Função | Natureza declarada | Base |
|---|---|---|---|
| 2024 | `carteira_safra_situacoes('2024')` | `COBERTURA_HISTORICA` | `acordos_titulos` ao vivo |
| 2025 | `carteira_safra_situacoes('2025')` | `COBERTURA_HISTORICA` | `acordos_titulos` ao vivo |
| 2026/1 | `carteira_2026_1_classificar()` | `CARTEIRA_CONSOLIDADA` | **base congelada** |
| 2026/2 | `carteira_2026_2_classificar()` | por competência de vencimento | `acordos_titulos` ao vivo |

### 2.1 A fórmula do "recuperado" — a descoberta central

Nas **quatro** réguas, para um título ligado a um acordo:

```sql
recuperado = valor_original * ratio
ratio      = Σ parcelas.valor (status='PAGO')
             / (Σ PAGO + Σ status in ('A_VENCER','VENCIDA'))
```

E para um título `PAGO` sem acordo: `recuperado = valor_original − saldo_crm`.

Consequências, todas verificáveis no corpo das funções em PROD:

1. **`pagamentos` não entra na conta.** Em toda a pilha da Efetividade,
   `pagamentos` aparece **uma única vez**, na CTE `caixa_fora`, e apenas como
   *booleano/data* (`min(data_pagamento)`) para classificar origem — **nunca
   como valor**. Nenhum real declarado como recuperado vem de um pagamento.
2. **É um rateio proporcional, não um valor recebido.** Um acordo com 10
   parcelas iguais e 3 marcadas `PAGO` atribui 30% do valor original de
   *cada* mensalidade daquele acordo como recuperado — independentemente de
   quanto entrou, quando entrou, ou se entrou.
3. **`parcelas.status='PAGO'` é a única prova aceita.** E `PAGO` não é prova
   de caixa: **4.939 das 6.250 parcelas `PAGO` (R$ 8.591.907,69 — 89,5% do
   valor) não têm `origem_baixa_ref`**, isto é, não apontam para nenhum
   pagamento. Só 1.312 parcelas (R$ 1.007.114,93) têm essa ligação.
4. **Nenhuma baixa tem comprovante.** `baixas_pagamento` tem 3.836 linhas
   (R$ 6.282.820,91) e **`comprovante_url` preenchido em 0 delas**.

### 2.2 Por que "fecha" sempre — a tautologia

Para 2024/2025 as linhas são, na própria fórmula:

```
pago      = recuperado
negociado = resto   (quando acordo ativo)      resto = valor_original − recuperado
em_aberto = resto   (quando sem acordo ativo)
cancelado = valor_original  (situação CANCELADA)
pendente  = valor_original  (EM_CONFIRMACAO ou pago sem lastro)
```

Logo `pago + negociado + em_aberto = recuperado + (vo − recuperado) = vo`, e as
demais linhas também somam `vo`. A soma **é** `Σ valor_original` por
construção. `conferencia.fecha = true` significa apenas **"a partição está
completa"** — é um teste de integridade de rateio, útil e legítimo nesse papel,
mas **não é conferência de caixa** e não deve ser apresentado à gestão como se
fosse. O mesmo vale para 2026/2, onde `saldo = valor_original − recuperado`.

Snapshots medidos hoje (gerados 2026-10-23 10:03 UTC), todos com
`diferenca: 0,00` e `fecha: true`:

| Recorte | Entrou | Pago | Negociado | Em aberto | Cancelado | Pendente |
|---|---:|---:|---:|---:|---:|---:|
| 2024 | 5.159.080,84 | 33.978,35 | 36.558,23 | 5.001.219,64 | 57.550,10 | 29.774,52 |
| 2025 | 15.243.972,57 | 261.037,83 | 293.236,72 | 12.875.350,32 | 1.567.845,12 | 246.502,58 |
| 2026/1 | 21.710.447,29 | 6.160.518,93 | 4.584.570,82 | 9.070.297,09 | 126.764,92 | 1.768.295,53 |
| 2026/2 | 9.963.084,01 | 1.080.658,89 | — | 8.534.744,41 (saldo) | 347.680,71 | 2.703.847,48 (em conferência) |

---

## 3. Semestre de origem e mês de recebimento (pergunta 2)

**Semestre de origem — fonte oficial existe e é boa.** `prime_titulo_semestre`
tem **412.238 boletos distintos** (1 linha por boleto, sem duplicidade de
chave), cobrindo **2023/2 a 2027/1**. A chave é o boleto da mensalidade
(`acordos_titulos.documento`, 7 dígitos — 40.583 títulos; 9.834 têm 6).
As réguas usam exatamente isso. Quando falta, 2026/2 cai para
`vencimento` e **marca a linha** (`fonte_semestre = 'vencimento (sem série no
Prime)'`, 223 títulos) — esse é o padrão correto, e as outras réguas não o têm.

**Mês de recebimento — existe só em `pagamentos.data_pagamento`**, e essa
tabela **começa em 2026-07-01**. São 10.715 pagamentos, R$ 13.697.182,98,
`retroativo = false` em 100%, sem nenhum registro anterior a julho/2026.

> **Consequência dura:** para 2024, 2025 e os seis primeiros meses de 2026/1
> **não existe registro de pagamento no CRM**. Qualquer "recuperação mensal"
> desses períodos é, necessariamente, rateio de status — não caixa. Não há
> fonte interna para reconstruir o mês de recebimento desses semestres.

---

## 4. Rastreabilidade até aluno/título/acordo/parcela/pagamento (pergunta 3)

A cadeia real, com as chaves exatas que existem:

```
pagamentos
  ├─ titulo_numero (5 díg.)            = acordos.numero_ulbra      ← é o nº do ACORDO
  └─ numero_parcela_completo (11 díg.) = parcelas.boleto            ← casamento 1:1
       └─ parcelas.acordo_id → acordos
            └─ acordos_titulos.acordo_id  (direto)   2.274 acordos
               acordo_titulo_vinculo      (mutirão)  2.325 acordos
                 └─ acordos_titulos.documento → prime_titulo_semestre.semestre
```

Dois achados de forma, medidos:

- **`pagamentos.titulo_numero` é o número do ACORDO, não do título.** São 5
  dígitos (`60012`, `73939`) e casam com `acordos.numero_ulbra`, nunca com
  `acordos_titulos.documento`. Testei a rota direta título→semestre: **0 de
  10.715**. Não existe pagamento apontando para uma mensalidade.
- **`numero_parcela_completo` → `parcelas.boleto` é exato e sem ambiguidade:**
  11 dígitos em 14.488/14.488 parcelas, e **0 casos** de um boleto casando
  mais de uma parcela.

### Censo da cadeia, pagamento por pagamento (PROD, 2026-10-23)

| Situação | Pagamentos | Valor | % do caixa |
|---|---:|---:|---:|
| **Total** | 10.715 | 13.697.182,98 | 100,0% |
| 1. Não alcança acordo por nenhuma chave exata | 6.293 | 6.787.372,32 | 49,6% |
| 2. Acordo encontrado, **sem título vinculado** | 1.352 | 1.746.194,97 | 12,7% |
| 3. Título encontrado, sem série no Prime | 317 | 235.568,37 | 1,7% |
| 4. **Semestre único — rastreável** | 2.712 | **4.772.446,60** | **34,8%** |
| 5. Semestre múltiplo — exigiria rateio | 41 | 155.600,72 | 1,1% |
| (dos quais) pagamento casa mais de um acordo | 168 | 510.457,90 | 3,7% |

As três causas da perda, em ordem de tamanho:

1. **Os 6.293 do item 1 são `tipo_pagamento = 'SANTANDER'`** (ou nulo) — ou
   seja, vêm do **extrato bancário, que é a fonte oficial de caixa** segundo o
   mapa de fontes de verdade. O acordo que eles pagam **não existe na tabela
   `acordos` do CRM**. É dinheiro comprovado sem contrapartida interna.
   Globalmente: 10.002 pagamentos (R$ 12.635.725,08 — 92,3%) são SANTANDER, e
   só 2.640 deles chegam a um semestre.
2. **Metade dos acordos não tem título vinculado.** 2.274 de 4.838 acordos
   (47,0%) têm título direto; 2.325 têm por `acordo_titulo_vinculo`. O vínculo
   nasce de mutirão, não do fluxo — já documentado, e é o gargalo estrutural.
3. **Quando o acordo cobre mensalidades de semestres diferentes** (41
   pagamentos, R$ 155.600,72), não há como atribuir sem ratear. São poucos:
   dá para tratar por exceção declarada, sem presunção.

---

## 5. Duplicidade entre mensalidades e acordos (pergunta 4)

O desenho atual **já evita a dupla contagem de valor**, e evita bem: a unidade
de conta é sempre a **mensalidade** (`acordos_titulos`), nunca a parcela do
acordo. O acordo entra só como `ratio`. Os títulos com `tipo_boleto = 'Acordo'`
são explicitamente excluídos em todas as réguas, e `situacao = 'DUPLICADA'`
também.

Os riscos de duplicidade que **restam**, medidos:

- **Aluno e título são contados por `count(distinct)`, nunca por soma** — e o
  comentário no código diz por quê: o mesmo título pode ter valor em `pago` e
  em `negociado` ao mesmo tempo. Então **somar as linhas de "alunos" entre
  buckets infla**, e a tela precisa deixar isso explícito.
- **168 pagamentos (R$ 510.457,90) casam mais de um acordo** pelas duas
  portas. Ao construir a matriz, isso duplicaria o valor se não houver regra de
  precedência. A precedência correta é a porta provada
  (`parcelas.origem_baixa_ref`) antes da porta por chave.
- **2026/1 e 2026/2 podem contar o mesmo título duas vezes**: 2026/1 lê a base
  congelada; 2026/2 lê `acordos_titulos` ao vivo com fallback por vencimento.
  Um título sem série no Prime e com vencimento em 2026/2 entra em 2026/2 por
  fallback, e pode já estar na base congelada de 2026/1. **Não medi a
  interseção** — fica como verificação obrigatória da Etapa 1.

---

## 6. Fórmulas de saldo divergentes entre telas, views e RPCs (pergunta 5)

Medido sobre a mesma população (`acordos_titulos`, excluindo `DUPLICADA` e
`CANCELADA` — 50.440 títulos):

| # | Fórmula | Total | Onde é usada |
|---|---|---:|---|
| S1 | `saldo_corrigido` | 47.387.588,61 | campo cru |
| S2 | `valor_em_aberto` | **430.966,49** | campo **praticamente vazio** |
| S3 | `valor_original` | 50.899.384,62 | "entrou" das réguas |
| S4 | `coalesce(saldo_corrigido, valor_em_aberto, valor_original, 0)` | **47.740.819,82** | **as 4 réguas** |
| S5 | `acordos.saldo` (status ATIVO) | 11.962.515,08 | ficha do acordo |
| S6 | `parcelas` abertas (`A_VENCER`+`VENCIDA`) | 11.240.509,64 | fila/alertas |

Divergências que importam:

- **S5 − S6 = R$ 722.005,44** no lado do acordo. Dois números para "quanto o
  aluno ainda deve do acordo", ambos exibidos, nenhum conciliado.
- **S2 é um campo morto em segunda posição de um `coalesce`.** Com R$ 430 mil
  em 50 mil títulos, `valor_em_aberto` está vazio quase sempre; quando não
  está, ele **vence** `valor_original` e muda o saldo. É uma fonte silenciosa
  de divergência (S4 ≠ S1 em R$ 353.231,21).
- Além dessas, há **funções de saldo por aluno** com recortes próprios
  (`saldo_cobravel_aluno`, `caso_saldo_operacional`, `aluno_saldo_pendente_detalhe`,
  `saude_carteira_saldo_por_origem`, `saldo_titulos_aberto`,
  `carteira_saldo_historico_recalcular`) — não as comparei linha a linha nesta
  passada, mas nenhuma delas é derivada das outras, e o diagnóstico estrutural
  de 23/09 já havia apontado o mesmo padrão.

**Armadilha de nome, para a gestão:** a página chamada **`Efetividade.jsx`**
*não* é a Efetividade Financeira — ela chama `calibragem_efetividade` e
`calibragem_funil`, que medem **produtividade de operador**. A Efetividade
Financeira vive em **`CarteiraEfetividade.jsx`** (`carteira_efetividade_ler`,
`carteira_saldo_historico_por_ano`) e em `EfetividadeCompetencias.jsx`
(2026/2). Dois assuntos diferentes com o mesmo nome na interface.

---

## 7. Recuperação comprovada, sem conciliação, honorários, cancelamentos, suspensões (pergunta 6)

### Honorários — quatro fontes, nenhuma concorda

| Fonte | Total | Linhas > 0 |
|---|---:|---:|
| `pagamentos.valor_honorario` | **1.001.295,73** | 10.641 |
| `parcelas.honorarios` (status `PAGO`) | 356.001,83 | 3.478 |
| `parcelas.honorarios` (todas) | 392.137,71 | 3.806 |
| `baixas_pagamento.honorarios_recebidos` | 58.031,49 | 638 |
| `acordos.honorarios_valor` | 35.996,74 | 91 |

Razão de **17:1** entre a maior e a menor. Para "honorários recebidos" a única
fonte defensável é `pagamentos.valor_honorario`, porque é a única amarrada a um
pagamento datado — as outras são expectativa, não recebimento.

### Conciliação

`status_conciliacao` está **nulo em 8.955 de 10.715 pagamentos
(R$ 12.306.066,08 — 89,8%)**. Só 1.760 pagamentos passaram por conciliação, e
todos são SANTANDER. Não há como separar "comprovado" de "não conciliado" pelo
campo que existe para isso.

### Cancelamentos e suspensões

- **Cancelamento** tem tratamento próprio e correto: `situacao = 'CANCELADA'`
  sai da base (`FORA_DA_BASE` / `CANCELADO`) e **nunca vira inadimplência**;
  2026/2 ainda registra o motivo (`origem_encerramento`).
- **Suspensão** não aparece em nenhuma das quatro réguas. Existe
  `parcelas.efeito_sem_pagamento` (DEVOLVE/SUSPENDE_PARCELA) e a migration
  `suspensao_fora_do_saldo_cobravel`, mas o efeito **não é refletido na
  Efetividade** — nem como linha, nem como ajuste.
- **Ajustes** existem em campo (`valor_cobranca_ajustado`, `motivo_ajuste_valor`,
  `titulo_valor_ajuste_historico`) e **não entram** no "entrou" das réguas, que
  usa `valor_original` cru. Um ajuste aprovado pela gestão hoje não muda o
  saldo inicial exibido.

---

## 8. Títulos sem competência e pagamentos sem vínculo (pergunta 7)

O que o sistema **já faz certo** e deve ser preservado como padrão:

- 2026/2 **marca** o título cuja competência veio de fallback
  (`fonte_semestre`), em vez de fingir que veio do Prime. 223 títulos.
- 2026/1 e 2026/2 têm faixas explícitas de não-conhecimento:
  `EM_VALIDACAO` / `EM_CONFERENCIA`, `Liquidado no Prime, origem não
  comprovada`, `Sem confirmação do Prime (título não encontrado)`.
- Nas 2024/2025 existe `pago_sem_lastro` — título `PAGO` sem acordo, sem
  liquidação Prime e sem pagamento: **R$ 26.783,08 (2024)** e
  **R$ 225.130,29 (2025)**. É exatamente o alerta "PAGO não comprova
  recebimento", já instrumentado.

O que **falta**: as réguas 2024/2025 não têm `fonte_semestre` nem base
congelada — elas recomputam "entrou" ao vivo a cada leitura, então o saldo
inicial de 2024 e 2025 **muda sozinho** quando um título é importado,
cancelado ou reclassificado. Não há registro de qual era o saldo inicial
ontem.

---

## 9. A matriz semestre × mês — o que já dá e o que falta (pergunta 8)

**A matriz é construtível hoje**, com os dados que existem, sem nenhuma
presunção. Esta é ela, medida em PROD (`valor_pago` por semestre de origem
rastreado × mês de `data_pagamento`):

| Semestre de origem | 2026-07 | 2026-08 | 2026-09 | 2026-10 | **Total** |
|---|---:|---:|---:|---:|---:|
| 2024/1 | 11.417,55 | 5.059,01 | 3.363,56 | 264,03 | 20.104,15 |
| 2024/2 | 1.626,79 | 9.876,24 | 1.447,15 | 2.258,05 | 15.208,23 |
| 2025/1 | 9.930,04 | 37.066,68 | 9.060,88 | 2.476,92 | 58.534,52 |
| 2025/2 | 62.721,17 | 69.083,99 | 22.664,88 | 16.356,49 | 170.826,53 |
| 2026/1 | 1.988.923,88 | 1.396.985,82 | 419.487,54 | 144.024,06 | 3.949.421,30 |
| 2026/2 | 26.842,11 | 33.141,08 | 242.585,08 | 255.783,60 | 558.351,87 |
| **(indeterminado)** | **5.504.581,06** | **2.723.334,13** | **421.052,13** | **275.769,06** | **8.924.736,38** |
| **Total** | 7.606.042,60 | 4.274.546,95 | 1.119.661,22 | 696.932,21 | **13.697.182,98** |

Honorários pela mesma chave: R$ 349.729,08 rastreáveis, R$ 651.566,65
indeterminados (de R$ 1.001.295,73).

### O confronto com o declarado

| Semestre | Declarado "pago" pela régua | Caixa rastreado | Diferença |
|---|---:|---:|---:|
| 2024 | 33.978,35 | 35.312,38 | +1.334,03 |
| 2025 | 261.037,83 | 229.361,05 | −31.676,78 |
| 2026/1 | 6.160.518,93 | 3.949.421,30 | **−2.211.097,63** |
| 2026/2 | 1.080.658,89 | 558.351,87 | **−522.307,02** |

**Leitura honesta desta tabela:** as duas colunas **não são comparáveis termo a
termo** e eu não as apresento como reconciliação. Três motivos medidos: (a) a
régua limita a graduação/pós e exclui `DUPLICADA`, a matriz não filtra; (b) a
régua tem **teto no `valor_original`** e o caixa inclui juros, multa e
honorários; (c) 65% do caixa está em `(indeterminado)` e parte dele pertence a
esses semestres. O que a tabela **prova** é que a ordem de grandeza da lacuna
em 2026/1 — **R$ 2,2 milhões, 36% do declarado** — é grande demais para ser
resíduo de escopo, e que **ninguém hoje sabe de onde saiu esse valor**.

### As três lacunas que impedem fechamento confiável

| # | Lacuna | Tamanho medido | Bloqueia |
|---|---|---:|---|
| **L1** | Pagamento SANTANDER cujo acordo não existe no CRM | 6.293 pag. / R$ 6,79 mi | atribuir caixa a semestre |
| **L2** | Acordo sem título vinculado (vínculo de mutirão) | 2.564 de 4.838 acordos / R$ 1,75 mi de caixa | atribuir caixa a semestre |
| **L3** | Sem registro de pagamento antes de 01/07/2026 | 2024, 2025, 1º sem. de 2026 | recuperação mensal histórica |

**L1 e L2 são recuperáveis por trabalho de vínculo** — são as mesmas frentes já
abertas (Central de Pagamentos, Conferência Prime). **L3 é irrecuperável por
fonte interna**: o mês de recebimento desses períodos não existe no CRM e não
deve ser inventado por aproximação.

---

## 10. Proposta de implementação em etapas pequenas

Princípios, derivados do que foi medido:

1. **Não substituir as réguas.** Elas respondem "qual a cobertura da safra" e
   fazem isso com partição completa. O que falta é uma **segunda camada**, de
   caixa, ao lado — não em vez.
2. **Rateio e caixa nunca na mesma coluna.** Toda tela passa a mostrar as duas
   e a diferença, nomeada.
3. **`(indeterminado)` é linha de primeira classe**, nunca distribuída por
   proporção, data próxima ou valor parecido.
4. **Nada de novo motor financeiro.** Nenhuma etapa escreve em `pagamentos`,
   `parcelas`, `acordos`, `acordos_titulos` ou `baixas_pagamento`.

### Etapa 0 — Verificação (só leitura, nenhum objeto novo)

Fechar as duas dúvidas que deixei abertas, porque elas mudam o desenho:

- Interseção entre a base congelada de 2026/1 e o fallback por vencimento de
  2026/2 (risco de contar o mesmo título em dois semestres).
- Comparação linha a linha das 6 funções de saldo por aluno, para decidir qual
  é candidata a canônica. **Não** criar view canônica nesta etapa.

Entrega: um anexo a este documento. Nenhuma migration.

### Etapa 1 — `efetividade_caixa_origem`: a cadeia auditável (1 migration, read-only)

Uma **view** (sem tabela, sem gatilho, sem cron) que devolve, uma linha por
pagamento:

```
pagamento_id, data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
aluno_id, acordo_id, acordo_numero_ulbra, titulo_id, titulo_documento,
semestre_origem, porta_vinculo, confianca, motivo_indeterminado
```

- `porta_vinculo` ∈ {`origem_baixa_ref`, `boleto_parcela`, `numero_ulbra`} —
  nessa ordem de precedência, para não duplicar os 168 pagamentos que casam
  mais de um acordo.
- `confianca` ∈ {`PROVADA`, `CHAVE_EXATA`, `INDETERMINADA`}. Nunca
  `ALTA_CONFIANCA` por proximidade — proximidade não entra.
- `motivo_indeterminado` ∈ {`ACORDO_FORA_DO_CRM`, `ACORDO_SEM_TITULO`,
  `TITULO_SEM_SERIE_PRIME`, `SEMESTRE_MULTIPLO`}.

Teste de aceitação: `Σ valor_pago` da view = R$ 13.697.182,98 (o total de
`pagamentos`), com **zero pagamento fora** — a view classifica todos,
inclusive os que não resolve. É a garantia de que nada é escondido.

### Etapa 2 — A matriz e o detalhamento auditável (1 migration)

`efetividade_matriz_semestre_mes(p_semestre, p_mes)`: a tabela da seção 9,
sobre a view da Etapa 1, com drill-down até `pagamento_id`. Cada total da tela
abre na lista de pagamentos que o compõem. `(indeterminado)` abre na lista com
o motivo.

### Etapa 3 — Base congelada para 2024, 2025 e 2026/2 (1 migration)

Replicar o padrão que **já funciona** em `carteira_2026_1_base`
(`origem_semestre`, `congelado_em`) para os outros três recortes, para que o
"saldo inicial por semestre" pare de mudar sozinho.

**Ressalva obrigatória, que precisa da decisão da gestão:** a base de 2026/1
foi congelada em **2026-09-11 16:40 UTC** — ela é uma **fotografia de
setembro**, não o saldo de abertura do semestre. O mesmo valeria para as novas.
"Saldo inicial" passa a significar **"carteira na data do congelamento"**, e a
tela tem de dizer a data. Não há fonte para o saldo de abertura real de 2024 e
2025.

### Etapa 4 — Painel: duas colunas e a diferença nomeada (sem migration)

Estender `CarteiraEfetividade.jsx` com, por semestre: saldo inicial (+ data do
congelamento), recuperado por rateio, **caixa rastreado**, indeterminado,
honorários recebidos, cancelamentos, saldo atual, % de efetividade — e a
diferença entre rateio e caixa, com nome e explicação.

### Etapa 5 — Suspensões e ajustes como linhas (1 migration)

Levar `parcelas.efeito_sem_pagamento` e `valor_cobranca_ajustado` para dentro
das réguas como **linhas próprias** (`suspenso`, `ajuste`), preservando a
partição completa. Hoje saem do saldo sem aparecer.

---

## 11. Atualização diária automática (complemento)

### Rotina: reaproveitar, não criar

**Não é preciso cron novo.** Já existem, ativos em PROD:

| Job | Horário | O que faz |
|---|---|---|
| **70** `carteira_efetividade_hora` | `3 * * * *` (de hora em hora) | `carteira_efetividade_recalcular()` |
| **69** `carteira_efetividade_dreno` | `*/5 * * * *` | `carteira_efetividade_recalcular_pendentes()` |
| **7** `saude_carteira_snapshot_diario` | `5 8 * * *` (05:05 BRT) | snapshot diário com histórico |
| **12** `relatorio_2026_1_snapshot_diario` | `50 2 * * *` | snapshot diário por `dia` |
| **53** `carteira_saldo_historico_hora` | `25 * * * *` | `carteira_saldo_historico_recalcular()` |
| **73/74/75** `fluxo_pag_*` | 08h–20h BRT | `fluxo_pagamentos_incremental` |

### O problema real: o snapshot atual NÃO guarda histórico

`carteira_efetividade_snapshot` tem chave `(bloco, recorte)` e o recálculo faz
`on conflict ... do update`. São **9 linhas** (3 blocos × 3 recortes) e cada
hora **sobrescreve** a anterior. **Não existe o dia anterior.** Comparar dias,
hoje, é impossível — não por falta de cron, por falta de tabela.

### Desenho proposto

- **Tabela nova `efetividade_dia`**, chave `(dia, semestre)`, nos moldes de
  `relatorio_mens_2026_1_snapshot` e `projecao_historico_diario` (que já usam
  `dia` e preservam histórico). Colunas: saldo inicial, saldo do dia anterior,
  saldo atual, recuperado no dia / no mês / acumulado, honorários recebidos,
  entradas, cancelamentos, suspensões, ajustes, indeterminado, diferença de
  conciliação, % de recuperação, `fonte`, `gerado_em`.
- **Gravação append-only**, uma linha por dia por semestre. `on conflict (dia,
  semestre) do update` apenas para o **dia corrente** (reprocessamento do dia
  em curso); dias fechados nunca são reescritos.
- **Horário:** pendurar na rotina das **03:00 BRT (06:00 UTC)**, depois do job
  1 (`atualizar_parcelas_vencidas`, 03:05 UTC) e do job 3 (virada, 06:00 UTC),
  para que o dia feche com as parcelas já viradas. Em vez de um cron novo,
  estender o comando do **job 70** com um `select efetividade_dia_gravar()`
  guardado por "só grava o dia se ainda não houver linha fechada", ou usar a
  janela já livre do **job 12**. A escolha é de 1 linha de `cron.alter_job` e
  fica para a gestão decidir — não a tomo aqui.
- **Fonte oficial de cada campo**, fixada:

| Campo | Fonte oficial |
|---|---|
| Saldo inicial | base congelada do semestre (Etapa 3) + data |
| Saldo atual | `coalesce(saldo_corrigido, valor_em_aberto, valor_original)` (S4) |
| Recuperado no dia (caixa) | `pagamentos.valor_pago` via view da Etapa 1, `data_pagamento = dia` |
| Recuperado por rateio | régua do semestre (rotulado como rateio) |
| Honorários recebidos | `pagamentos.valor_honorario` — **só esta** |
| Cancelamentos | `situacao='CANCELADA'` + `origem_encerramento` |
| Suspensões | `parcelas.efeito_sem_pagamento` |
| Ajustes | `titulo_valor_ajuste_historico` |
| Diferença de conciliação | rateio − caixa, por semestre, **sempre exibida** |

- **Dados atrasados:** `pagamentos.data_pagamento` é a data do **banco**, e o
  pagamento entra no CRM depois (fluxo incremental com janela de 24 h). Então
  um dia já fechado **recebe pagamento novo**. Tratamento: a linha de
  `efetividade_dia` registra `gerado_em` e um campo
  `caixa_lancado_apos_fechamento`, e a variação aparece como **ajuste
  retroativo identificado**, no dia em que chegou, com ponteiro para o dia a
  que pertence. **Nunca reescrever o dia fechado em silêncio.**
- **Reconciliação:** a cada gravação, conferir
  `saldo_anterior − recuperado_dia − cancelado_dia − suspenso_dia ± ajuste_dia
  = saldo_atual`. Se não fechar, **gravar a linha com a diferença explícita** e
  marcar `reconciliado = false` — nunca descartar o dia nem forçar o número. É
  a correção do que hoje é feito pelo `conferencia.fecha` (que descarta o
  recálculo quando não fecha, e fecha sempre por tautologia).

---

## 12. O que está preservado

Nada neste documento toca as frentes em andamento: **Central de Pagamentos
(#737, #738)**, **Santander**, **Criticidade** e **Revisão Cadastral**. As
etapas 1 e 2 são somente leitura e se **beneficiam** do avanço da Central de
Pagamentos e da Conferência Prime: cada vínculo que elas criam reduz L1 e L2 e
move valor de `(indeterminado)` para rastreado, automaticamente, sem mudar uma
linha da proposta.

Os jobs financeiros existentes ficam intocados — inclusive os que estão
**inativos por decisão** (38 `fluxo_pagamentos_horario`, 47
`baixa_automatica_por_titulo`, 57 `acordo_vinculo_automatico`, 43
`reposicao_carteira_minuto`, 46 `fluxo_acordos_diario`). Nenhuma etapa
pressupõe religar nenhum deles.

---

# Anexo A — Etapa 0 (verificação, somente leitura)

**Data:** 2026-10-23 · **PROD:** `ahattpqrjmhkzsmnbdzs` · nenhum objeto criado ou alterado.

As duas dúvidas que a seção 10 deixou abertas estão fechadas. **Uma das duas
mudou o desenho da proposta; a outra o simplificou.**

## A.1 Interseção 2026/1 congelada × 2026/2 — risco descartado, outro achado no lugar

| | Títulos | Valor |
|---|---:|---:|
| `carteira_2026_1_base` (congelada) | 14.988 | 21.752.304,72 |
| `carteira_2026_2_classificar()` | 5.320 | 9.963.084,01 |
| **Interseção (mesmo `titulo_id` nos dois)** | **1** | **4.549,84** |
| …da qual veio do fallback por vencimento de 2026/2 | 0 | — |
| …com `recuperado > 0` (dupla contagem de recuperação) | **0** | **0,00** |

**O risco que eu levantei não existe.** Um único título aparece nos dois
recortes, e ele tem `recuperado = 0` — então **zero real de recuperação é
contado duas vezes**. A Etapa 2 não precisa de regra de desempate entre 2026/1
e 2026/2.

E a causa é o **inverso** do que eu supus: o fallback que produziu o caso está
em **2026/1**, não em 2026/2. O título `4372383` (venc. 2026-06-05) entrou na
base congelada com `origem_semestre = 'vencimento'`; a série do Prime, que
chegou depois, diz **2026/2**, e 2026/2 o pega corretamente pela série.

### O achado que sobra: 673 títulos de fallback invisíveis em 2026/1

| `origem_semestre` | Títulos | Valor | % do recorte |
|---|---:|---:|---:|
| `serie_prime` | 14.315 | 21.545.748,70 | 99,05% |
| **`vencimento`** (fallback) | **673** | **206.556,02** | **0,95%** |

Dois problemas, nenhum grave em valor, ambos de método:

1. **O fallback de 2026/1 não é exposto.** A base guarda `origem_semestre`, mas
   `carteira_2026_1_classificar()` **não devolve esse campo** — então a tela de
   2026/1 não tem como marcar os 673 títulos cuja competência é inferida.
   2026/2 faz isso certo (`fonte_semestre`). **É 2026/1 que deve copiar 2026/2**,
   e não o contrário.
2. **Base congelada não aprende.** Desde o congelamento (2026-09-11 16:40 UTC)
   a série do Prime chegou para apenas 6 dos 673: 4 confirmam 2026/1, **1 diz
   2026/2 e 1 diz 2025/2**. Ou seja **2 títulos (R$ 4.726,24) estão hoje no
   semestre errado e congelados assim**. Os outros 667 (R$ 201.144,55) seguem
   sem série nenhuma.

**Consequência para a Etapa 3:** congelar não basta. Cada base congelada
precisa de uma **reconferência registrada** — não reescrever o congelado, mas
gravar ao lado "a série do Prime chegou depois e discorda", com o título e o
valor. Sem isso o erro vira permanente e silencioso.

## A.2 As funções de saldo por aluno — são 2, não 6

O censo encontrou 7 nomes. **Três são apenas invólucros** que delegam:
`aluno_tem_saldo_pendente` → F1; `caso_saldo_operacional` → F1 (+ baixas
pendentes); `caso_saldo_zerado_real` → `caso_saldo_operacional`. Restam quatro
corpos próprios, e só **dois** respondem "quanto o aluno deve":

| | F1 `aluno_saldo_pendente_detalhe` | F2 `saldo_cobravel_aluno` | F3 `saude_carteira_saldo_por_origem` | F4 `saldo_titulos_aberto` |
|---|---|---|---|---|
| Chave | `aluno_id` | `aluno_id` | `aluno_id[]` | **`cpf`** |
| Pergunta | quanto **deve** | quanto é **cobrável** | saúde da carteira | — |
| `coalesce` do título | vca, sc, **vea**, vo | vca, sc, vo | sc, vo | **só `sc`** |
| Situação do título | ABERTO + NEGOCIADO | ABERTO + NEGOCIADO | só ABERTO + `status='em_aberto'` + `acordo_id is null` | **só ABERTO** |
| Exclui por vínculo | se acordo não cancelado | se acordo não cancelado | qualquer vínculo ativo | **qualquer vínculo, ativo ou não** |
| Parcelas: acordo | **não CANCELADO** (inclui QUITADO) | **só ATIVO** | só ATIVO | não conta parcelas |
| Parcelas: status | `parcela_viva` | `parcela_viva` **e ≠ RENEGOCIADA** | só VENCIDA + A_VENCER | — |
| Suspensão de cobrança | ignora (mostra a dívida) | **zera o aluno** | ignora | ignora |
| Exclui `tipo_boleto='Acordo'` | sim | sim | n/a | **não** |

### F1 × F2 — população INTEIRA (16.090 alunos, não amostra)

| | Valor |
|---|---:|
| F1 — total devido | **47.209.713,10** |
| F2 — total cobrável | **46.686.338,11** |
| Diferença | **523.374,99** |
| Alunos em que divergem | **71** de 16.090 (0,44%) |
| …por **suspensão de cobrança** (intencional, documentada no código) | **69** — R$ 520.955,63 |
| …por **outra causa** | **2** — R$ 2.419,36 |

**F1 e F2 são a mesma fórmula.** A divergência é 99,5% a guarda de suspensão,
que é uma decisão de 08/10/2026 escrita no corpo da função: a dívida continua
registrada em F1 e sai apenas da cobrabilidade em F2. Isso **não é divergência
de fórmula, é separação correta de dois conceitos.**

### Os 2 casos restantes — as duas divergências que o próprio código previa

O comentário em `saldo_cobravel_aluno` diz: *"RENEGOCIADA segue excluída aqui
porque esta função sempre a excluiu — é uma das 2 divergências preservadas na
fundação."* **As duas estão em produção, uma cada:**

| Aluno | F1 | F2 | Diferença | Causa |
|---|---:|---:|---:|---|
| `60f72962…` | 2.470,23 | 628,99 | 1.841,24 | parcela **RENEGOCIADA em acordo ATIVO** — F1 conta (`parcela_viva`), F2 exclui |
| `c38727b0…` | 5.261,00 | 4.682,88 | 578,12 | parcela **viva em acordo QUITADO** — F1 aceita (acordo "não CANCELADO"), F2 exige ATIVO |

O segundo caso é também uma **inconsistência de dado**, não só de fórmula: uma
parcela viva dentro de um acordo QUITADO. Existem funções em PROD exatamente
para isso (`sair_quitacao_total_com_saldo`, `corrigir_quitado_com_saldo`) — não
as executei.

### F3 e F4 não são saldo do aluno (amostra de 1.500 alunos)

| Medida na mesma amostra | Valor |
|---|---:|
| F1 — total | 4.515.752,55 |
| …componente `titulos_abertos` | 3.279.154,31 |
| …componente `titulos_negociados_orfaos` | **0,00** |
| …componente `parcelas_abertas_valor` | 1.236.598,24 |
| F2 | 4.465.829,00 |
| **F3** `saude_carteira_saldo_por_origem` | 4.526.970,43 (+11.217,88 vs F1) |
| **F4** `saldo_titulos_aberto` (por CPF) | 3.292.209,53 (**−1.223.543,02** vs F1) |

- **F4 não é o saldo do aluno** — é só a perna de mensalidade, e nem essa ela
  reproduz: dá R$ 13.055,22 **acima** do componente `titulos_abertos` de F1,
  porque ignora `valor_cobranca_ajustado`, exclui título com vínculo **inativo**
  e agrega **por CPF**, somando outras fichas da mesma pessoa. Usá-la como
  saldo subestima em 27%. Confirmada na amostra a armadilha já conhecida do CPF
  vazio: **1 aluno** sem CPF cai no balde `00000000000`.
- **F3** é saúde de carteira, com recorte próprio e legítimo; difere de F1 em
  +R$ 11,2 mil na amostra por contar só VENCIDA/A_VENCER e só mensalidade sem
  acordo.
- **`titulos_negociados_orfaos = 0,00`** em toda a amostra: a perna de
  "NEGOCIADO órfão" está vazia — consistente com a regularização de
  mensalidade-segue-o-acordo já em produção.

## A.3 O que isto muda na proposta

| | Antes da Etapa 0 | Depois |
|---|---|---|
| Desempate 2026/1 × 2026/2 (Etapa 2) | risco aberto | **descartado** — 1 título, R$ 0 de recuperação |
| View canônica de saldo | "7 fórmulas, canônica bloqueada" | **F1 é a canônica**; F2 = F1 + guarda de cobrabilidade. Nada a unificar |
| Etapa 3 (congelar 2024/2025/2026-2) | congelar e pronto | congelar **+ reconferência registrada**, senão o erro de competência vira permanente |
| Novo (Etapa 3) | — | expor `origem_semestre` em `carteira_2026_1_classificar()`, como 2026/2 já faz |
| Latente, fora do escopo | — | 2 títulos em semestre errado (R$ 4.726,24); 1 parcela viva em acordo QUITADO (R$ 578,12); 1 parcela RENEGOCIADA contada como dívida (R$ 1.841,24) |

**Nada foi corrigido.** Os três latentes acima ficam registrados, não tratados.

---

# Anexo B — Etapa 1 construída: o que ela corrigiu no diagnóstico

**Data:** 2026-10-23 · migration escrita e testada, **NÃO aplicada em produção**.

## B.1 Correção de um número da seção 9

A seção 9 afirma **R$ 4.772.446,60 / 2.712 pagamentos** rastreáveis a um
semestre. Esse cálculo usava a **união** das portas de vínculo: quando duas
portas apontavam para acordos diferentes, ele aceitava a que tivesse título —
isto é, escolhia a mais conveniente. A view da Etapa 1 aplica **precedência**
(porta provada > chave exata) e recusa esse atalho. O número correto é:

| | Pagamentos | Valor |
|---|---:|---:|
| **PROVADA** (`origem_baixa_ref`) | 1.071 | 843.876,06 |
| **CHAVE_EXATA** (`boleto_parcela` + `numero_ulbra`) | 1.547 | 3.597.969,22 |
| **Resolvido a um semestre único** | **2.618** | **4.441.845,28** |

Por que a diferença, medido: em **4.051 de 4.212** pagamentos alcançados por
mais de uma porta as portas **concordam** sobre o acordo — a precedência não
muda nada. Em **161** elas **discordam** (R$ 488.896,40), e aí a porta provada
vence; eram esses que o cálculo anterior resolvia pelo lado conveniente. Outros
**7** (R$ 21.561,50) são ambíguos *dentro* de uma porta só (`numero_ulbra`
repetido em dois acordos) e saem como `ACORDO_AMBIGUO`, sem acordo escolhido.

**A lacuna do diagnóstico não diminuiu — aumentou.** O caixa rastreável é
**32,4%**, não 34,8%. As conclusões da seção 1 e das lacunas L1–L3 seguem
válidas, e a de 2026/1 fica maior.

## B.2 Distribuição completa que a view produz (PROD, 23/10/2026)

| Confiança | Motivo | Porta | Pagamentos | Valor |
|---|---|---|---:|---:|
| INDETERMINADA | ACORDO_FORA_DO_CRM | — | 6.295 | 6.800.076,79 |
| CHAVE_EXATA | resolvido | boleto_parcela | 1.520 | 3.549.956,11 |
| INDETERMINADA | ACORDO_SEM_TITULO | boleto_parcela | 1.253 | 1.934.418,84 |
| PROVADA | resolvido | origem_baixa_ref | 1.071 | 843.876,06 |
| INDETERMINADA | TITULO_SEM_SERIE_PRIME | boleto_parcela | 232 | 184.313,10 |
| INDETERMINADA | ACORDO_SEM_TITULO | origem_baixa_ref | 162 | 122.665,47 |
| INDETERMINADA | SEMESTRE_MULTIPLO | boleto_parcela | 27 | 124.849,85 |
| INDETERMINADA | TITULO_SEM_SERIE_PRIME | origem_baixa_ref | 82 | 50.688,47 |
| CHAVE_EXATA | resolvido | numero_ulbra | 27 | 48.013,11 |
| INDETERMINADA | ACORDO_SEM_TITULO | numero_ulbra | 41 | 31.549,83 |
| INDETERMINADA | ACORDO_AMBIGUO | numero_ulbra | 7 | 21.561,50 |
| INDETERMINADA | SEMESTRE_MULTIPLO | origem_baixa_ref | 6 | 8.891,48 |
| INDETERMINADA | TITULO_SEM_SERIE_PRIME | numero_ulbra | 4 | 1.680,09 |

`ACORDO_SEM_TITULO` somado (1.456 pagamentos, R$ 2.088.634,14) é a **lacuna L2**
vista do lado do caixa: é o que o trabalho de vínculo da Central de Pagamentos
e da Conferência Prime converte em rastreado, sem mudar uma linha da view.

## B.3 Dois achados que a construção produziu

1. **O gatilho `titulo_situacao_por_vinculo` copia o acordo do vínculo para
   `acordos_titulos.acordo_id`.** Descoberto porque meu primeiro teste da perna
   do mutirão **passava mesmo com a perna removida** — ele não provava nada.
   Mas a perna **é** necessária: produção tem **154 títulos (R$ 325.422,97)**
   com vínculo ATIVO e `acordo_id` NULO (vínculos anteriores ao gatilho). O
   teste agora reproduz essa forma real.
2. **Latente, não tratado:** 1 título (R$ 428,72) tem vínculo ativo para um
   acordo e `acordo_id` apontando para **outro**. A view usa as duas pernas com
   `union`, então ele alcança os dois acordos e sai como `ACORDO_AMBIGUO` em vez
   de escolher — comportamento correto, inconsistência de dado preservada e
   visível.

## B.4 Observação para a Etapa 5 (atualização diária)

Entre a primeira medição desta sessão e esta, `pagamentos` passou de **10.715 /
R$ 13.697.182,98** para **10.727 / R$ 13.722.540,70** — 12 pagamentos, R$
25.357,72, em poucas horas. É a demonstração ao vivo do problema dos **dados
atrasados** da seção 11: qualquer número de Efetividade precisa carregar o
instante em que foi apurado, e dia fechado precisa registrar o que chegou
depois em vez de ser reescrito.

## B.5 Arquivos (branch `feat/efetividade-caixa-origem`, nada aplicado)

- `supabase/migrations/20261023131709_efetividade_caixa_origem.sql`
- `supabase/rollbacks/20261023131709_efetividade_caixa_origem.rollback.sql`
- `supabase/tests/efetividade_caixa_origem.test.js` — 14 testes
