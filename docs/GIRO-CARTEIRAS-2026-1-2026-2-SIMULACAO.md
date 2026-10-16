# Giro total das carteiras 2026/1 e 2026/2 — EXECUTADO (16/10/2026)

**Executado em produção** (`ahattpqrjmhkzsmnbdzs`, projeto Reativa One) em
16/10/2026, com autorização da gestão a cada etapa. Migration registrada na
versão `20261016115142`; simulação `437f434b-e781-4357-a5ef-3fcd8e9d4770`
aprovada e executada às 12:05:45 UTC em 27 lotes de 150.

Os números deste documento são os da **execução conferida**, não os da
simulação de leitura feita de manhã — a base andou entre uma e outra, e a
seção 7 registra a diferença.

Desenho e decisões: [`GIRO-CARTEIRAS-2026-1-2026-2-DESENHO.md`](GIRO-CARTEIRAS-2026-1-2026-2-DESENHO.md).
Consultas reproduzíveis: [`analises/2026-10-16-giro-carteiras-simulacao.sql`](analises/2026-10-16-giro-carteiras-simulacao.sql).
Conferência pós-execução: [`analises/2026-10-16-giro-conferencia-pos-execucao.sql`](analises/2026-10-16-giro-conferencia-pos-execucao.sql).

---

## 1. Relatório por operador (executado)

Distribuição em **duas passadas com prioridade 2026/2**, decidida pela gestão em
16/10 (o porquê e as alternativas descartadas estão na seção 4.5). A tabela
abaixo foi lida da base **depois** do giro, não da simulação.

| Operador | CPFs 2026/1 | CPFs 2026/2 | CPFs únicos | Títulos | Saldo 2026/1 | Saldo 2026/2 | Consolidado | Ativos / teto 700 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Allan | 285 | 268 | 544 | 1.311 | 993.042,73 | 642.411,21 | 1.635.453,94 | 624 |
| Diego | 285 | 268 | 544 | 1.323 | 998.015,42 | 638.626,80 | 1.636.642,22 | 639 |
| João | 282 | 269 | 544 | 1.258 | 992.836,61 | 642.133,46 | 1.634.970,07 | 602 |
| Luana | 281 | 269 | 544 | 1.323 | 1.009.824,38 | 648.107,24 | 1.657.931,62 | 570 |
| Mauricio | 283 | 269 | 544 | 1.305 | 1.002.997,50 | 647.321,63 | 1.650.319,13 | 605 |
| Nataly | 282 | 269 | 544 | 1.284 | 994.881,12 | 641.765,34 | 1.636.646,46 | 592 |
| Rafaella | 289 | 268 | 544 | 1.287 | 1.004.243,55 | 641.331,76 | 1.645.575,31 | 610 |
| **Total** | **1.987** | **1.880** | **3.808** | **9.091** | **6.995.841,31** | **4.501.697,44** | **11.497.538,75** | |

As colunas por semestre somam 3.867, e não 3.808, porque **59 CPFs devem nos
dois semestres** e contam nas duas colunas — continuando com **um** operador só.

A carteira lida da base depois do giro bate com a simulação aprovada operador a
operador, centavo a centavo. A última coluna é a carteira **ativa** — a conta
que o gatilho de teto faz —, toda ela abaixo dos 700.

## 2. Números pedidos

| | |
|---|---|
| CPFs únicos redistribuídos | **3.808** |
| Títulos | **9.091** |
| Saldo total da carteira redistribuída | **R$ 11.497.538,75** |
| Operadores | **7** |
| CPFs por operador | **544** — todos |
| Média de saldo por operador | **R$ 1.642.505,54** |
| Diferença entre maior e menor quantidade de CPFs | **0** |
| Diferença de CPFs de 2026/2 | **1** (269 × 268) |
| Diferença financeira de **2026/2** | **1,46%** |
| Diferença financeira de 2026/1 | **1,68%** |
| Diferença financeira **consolidada** | **R$ 22.961,55** — **1,38%** |
| CPFs vindos do pool (sem operador antes) | **2.646** |
| CPFs que trocaram de operador | **1.019** |
| CPFs que ficaram com o mesmo responsável | **143** |

O giro é menos uma redistribuição e mais uma ocupação: **2.646 dos 3.808 CPFs
não tinham operador nenhum**. Troca real entre operadores foram 1.019.

**Conferência de fechamento:** a soma das sete carteiras é exatamente
R$ 11.497.538,75 e 3.808 CPFs — igual ao total elegível. Nenhum CPF em dois
operadores (0), nenhum caso em duplicidade (0), `soma_fecha` verdadeiro. As
três somas (CPFs, títulos, saldo) fecham linha a linha.

## 3. O que NÃO é distribuído, e por quê

Universo total de mensalidades em aberto das competências 2026/1 e 2026/2, **no
instante da execução**: **5.566 alunos, 12.145 títulos, R$ 18.097.695,99.**

| Situação | Alunos/CPFs | Por quê |
|---|---:|---|
| **Distribuído** | **3.808** | — |
| Acordo ativo | 1.038 | tem parcela de acordo em aberto; mover entra em conflito com a regra "o dono do acordo é o responsável" e o pedido é não alterar acordos |
| Sem ficha no CRM | 512 | o título existe, o aluno não tem caso no CRM — não há responsável a atribuir |
| Caso protegido ou encerrado | 208 | negociação em curso, link vivo, termo, confirmação de pagamento, `nao_acionar`, Carteira Geral ou caso já encerrado |
| **Total fora** | **1.758** | |

3.808 + 1.038 + 512 + 208 = 5.566 ✓. Dos títulos, 9.091 foram distribuídos
(R$ 11.497.538,75); os 3.054 restantes, R$ 6.600.157,24, ficaram de fora.

A quebra de títulos e saldo **por motivo** não é dada aqui de propósito: a
simulação guarda só a contagem de alunos por motivo, e qualquer releitura
posterior já é outra foto. Uma leitura poucos minutos depois do giro, por
exemplo, devolveu 3.807 distribuídos e R$ 11.484.557,27 — a base de cobrança
anda o tempo todo. Vale a contagem do instante da execução, que é a que a
simulação registrou.

## 4. Três coisas que a medição mostrou e que mudam a leitura do giro

### 4.1. Dois terços da carteira 2026 não tinham dono

Dos 3.808 CPFs elegíveis, **2.646 (69,5%) estavam sem operador** —
o giro não os tirou de ninguém, ele os **colocou em alguém**. A conta se
decompõe assim:

* 2.646 saíram do pool para um operador (entrada, não troca);
* 1.019 trocaram de um operador ativo para outro;
* 143 permaneceram onde já estavam.

### 4.2. O semestre por Prime e por vencimento discordam em 1.232 títulos

Cobertura do `prime_titulo_semestre`: **97,2%** dos 40.789 títulos em aberto.
No recorte de 2026, cruzando os dois métodos:

| Vencimento diz | Prime diz | Títulos | Saldo R$ |
|---|---|---:|---:|
| 2026/1 | 2026/1 | 6.646 | 9.199.824,70 |
| 2026/2 | 2026/2 | 4.128 | 7.961.198,68 |
| 2026/1 | 2026/2 | 147 | 264.938,67 |
| 2026/2 | 2026/1 | 194 | 52.023,95 |
| 2026/1 | 2025/2 | 540 | 129.122,01 |
| 2026/1 | 2025/1 | 154 | 24.954,19 |
| 2026/2 | 2025/2 | 101 | 25.539,52 |
| fora de 2026 | 2026/1 | 302 | 468.196,23 |
| 2026/1 | sem Prime | 528 | 116.759,17 |
| 2026/2 | sem Prime | 202 | 36.203,59 |

Pelo método **híbrido adotado** (Prime quando existe, vencimento como
fallback): 12.147 títulos / R$ 18.099.144,99. Só por vencimento seriam 12.640 /
R$ 17.810.564,48. A diferença líquida é de −493 títulos e +R$ 288.580,51: saem
795 títulos que vencem em 2026 mas pertencem a contrato de 2025, e entram 302
títulos de matrícula antecipada (vencimento fora de 2026, contrato 2026/1).

**Isto é uma decisão sua, não um detalhe técnico.** Os números acima são o que
muda se você preferir o corte por vencimento puro.

### 4.3. Sem fidelização especial, 525 casos voltam ao pool na primeira manhã

O giro entrega **3.943 casos** (3.807 CPFs; alguns têm mais de uma ficha).
Desses, **525 já estão hoje fora da janela de 10 dias** — e 14 nunca tiveram
acionamento nenhum. O cron `fidelizacao_liberar_vencidos` está **ativo**
(`20 8 * * *`, sem limite de lote) e solta exatamente esse perfil. Não é
hipótese: na carteira inteira, 1.353 dos 5.119 casos com dono já estão fora da
janela hoje.

A cada dia seguinte o número cresce, porque a janela de cada caso vence sem
novo acionamento. Por isso a fidelização até 26/10 é condição do giro, não um
complemento dele.

### 4.4. O teto de 500 não comporta o giro

`trigger_impor_teto_operador` está **ativo** em `casos`. Dispara em toda troca
de dono e, se o operador passar do teto, **libera o excedente** — escolhendo os
casos de menor valor em aberto que estejam fora da janela de 10 dias. O teto de
todos os 7 é 500.

Carteira **ativa** (a conta que o teto usa: fora os protegidos e encerrados)
antes e depois do giro:

| Operador | Ativos hoje | Saem no giro | Entram no giro | Ativos depois | Acima do teto |
|---|---:|---:|---:|---:|---:|
| Allan | 400 | 333 | 559 | 626 | +126 |
| Diego | 177 | 104 | 561 | 634 | +134 |
| João | 284 | 240 | 569 | 613 | +113 |
| Luana | 35 | 24 | 557 | 568 | +68 |
| Mauricio | 102 | 60 | 557 | 599 | +99 |
| Nataly | 225 | 191 | 558 | 592 | +92 |
| Rafaella | 182 | 133 | 560 | 609 | +109 |

**Os sete ficam acima do teto.** A migration ensina o gatilho a nunca escolher
um caso dentro da fidelização do giro, mas o excedente não some: ele passa a
cair sobre os casos **não girados** do operador, que são poucos (de 11 a 67
cada). Na prática, manter 500 faz o gatilho limpar a carteira antiga do
operador na primeira troca de dono depois do giro.

**Decidido em 16/10: o teto sobe para 700** (folga de 66 sobre o maior caso,
634). A mudança está na migration, com o estado anterior declarado para
reversão: `limite_carteira` 500, gravado por migration em 30/07/2026. Se voltar
a 500 com a carteira nesse tamanho, o excedente volta a ser liberado — cerca de
740 casos de volta ao pool.

### 4.5. Como se chegou à distribuição em duas passadas

Quatro variantes medidas em produção, todas sobre o mesmo universo:

| Variante | CPFs únicos | CPFs 2026/2 | Saldo 2026/2 | Consolidado |
|---|---:|---:|---:|---:|
| 1. Serpentina única pelo saldo total | 543–544 | 258–274 | 13,6% | **0,24%** |
| 2. Duas passadas, B continuando a serpentina | 543–544 | 268–269 | 1,49% | 4,58% |
| 3. Duas passadas, B por cota, ordem fixa | 543–544 | 268–269 | 1,49% | 2,81% |
| 4. **Duas passadas, B por cota com alternância** | **543–544** | **268–269** | **1,49%** | **1,45%** |

A variante 1 equilibra o total e deixa 2026/2 abrir 13,6%. A 2 conserta a safra
e estraga o total. A 3 recupera a contagem de CPFs mas ainda deixa o
consolidado em 2,81%, porque as vagas da passada B eram servidas sempre na
mesma ordem. A **4** alterna a ordem das vagas a cada rodada — o operador que
recebeu primeiro numa rodada recebe por último na seguinte — e fecha as duas
dimensões ao mesmo tempo. É a implementada.

Uma observação que a medição impôs: na variante 2, ordenar as vagas por
contagem ou por saldo dava exatamente o mesmo resultado, porque os operadores
que ficam com 269 CPFs na passada A são justamente os que receberam os maiores
valores. Sem a cota explícita, os dois arredondamentos somam e a diferença de
CPFs únicos vira 2.

### 4.6. Registro da medição anterior (serpentina única)

Medido em 16/10, por operador:

| Operador | Saldo 2026/1 | Saldo 2026/2 | Consolidado | Desvio 2026/2 |
|---|---:|---:|---:|---:|
| Allan | 986.484,63 | 659.969,53 | 1.646.454,16 | +2,12% |
| Diego | 1.002.455,81 | 644.316,47 | 1.646.772,28 | −0,30% |
| João | 1.041.077,07 | 603.838,08 | 1.644.915,15 | −6,56% |
| Luana | 950.363,39 | 697.613,68 | 1.647.977,07 | +7,95% |
| Mauricio | 1.042.771,15 | 602.852,72 | 1.645.623,87 | −6,72% |
| Nataly | 949.411,54 | 694.579,17 | 1.643.990,71 | +7,48% |
| Rafaella | 1.024.392,87 | 620.660,44 | 1.645.053,31 | −3,96% |
| **Total** | **6.996.956,46** | **4.523.830,09** | **11.520.786,55** | |

A serpentina ordena pelo saldo **total** do CPF, então é o total que fica
equilibrado (0,24%). Cada safra isolada não é critério: 2026/2 varia de
R$ 602.852,72 a R$ 697.613,68 — **13,6%** —, e 2026/1 varia 9,0%.

**Alternativa medida** (duas passadas: primeiro os CPFs com dívida em 2026/2,
ordenados pelo saldo de 2026/2; depois os de 2026/1 apenas, continuando a
serpentina):

| | Atual | Duas passadas |
|---|---:|---:|
| Spread do saldo 2026/2 | 13,6% | **1,49%** |
| Spread do saldo 2026/1 | 9,0% | 7,95% |
| Spread do saldo consolidado | **0,24%** | 4,58% |
| CPFs 2026/2 (min–máx) | 258–274 | **268–269** |
| CPFs únicos (min–máx) | 543–544 | 543–544 |

Nenhuma das duas domina a outra: ou o total fica quase perfeito e a safra
oscila, ou a safra fica quase perfeita e o total oscila. Escolher é decisão de
gestão, não de algoritmo.

## 5. Estado de produção conferido nesta medição

* As duas portas do giro continuam **desativadas** (`GIRO_DESATIVADO` presente
  em `calibragem_simular_giro_2026` e `calibragem_executar_giro_lote_impl`).
* **`casos.fidelizacao_inicio` NÃO existe em produção** — a migration da
  fidelização v2 (30/09) nunca foi aplicada. A regra viva é só a v1,
  `data_ultimo_acionamento + 10 >= current_date`.
* Crons que podem reverter a titularidade: `fidelizacao_liberar_vencidos`
  (`20 8 * * *`, ativo) e `nivelamento_automatico_gestao` (`20 9 * * *`,
  ativo). `reposicao_carteira_minuto` está inativo.
* Operadores ativos com `perfil = 'operador'`: **7** — Luana, Mauricio, Nataly,
  João, Allan, Rafaella e Diego; todos com `recebe_novos_casos` verdadeiro
  (a Decisão 4 do desenho não altera nada na prática). O perfil exclui
  corretamente gerência, diretoria, supervisão, jurídico, administrativo e
  painel. Olga não aparece: está inativa.
* Carteira atual dos 7: 4.404 casos. Há 5.119 casos com dono no total — os
  outros 715 pertencem a e-mails fora dos 7 operadores (Carteira Geral,
  gestão), e o giro não os toca.

## 6. A execução, e os 104 casos que ficaram para trás

**Simulação `437f434b-e781-4357-a5ef-3fcd8e9d4770`**, gravada RASCUNHO às
11:55 UTC, aprovada por amanda.seibel@aelbra.com.br e executada às 12:05:45
UTC em 27 lotes de 150. Antes de aprovar, a revalidação mostrou as 3.922
movimentações ainda coerentes com a base: zero casos com dono diferente do
previsto, zero desaparecidos.

| | |
|---|---|
| Casos previstos | 3.922 |
| Movidos | **3.818** |
| Pulados | **104** |

**Por que 104 foram pulados.** Quando um aluno tem mais de uma ficha, mover a
primeira dispara `trg_sync_alunos_apos_casos` → a ficha recebe o responsável
novo → o gatilho de volta propaga esse responsável para as **outras fichas do
mesmo aluno**. Quando o lote chegava na ficha irmã, o executor comparava o dono
atual com o previsto, via que já era outro e pulava — corretamente, porque essa
comparação é justamente a trava contra mover caso que mudou de mão no meio do
caminho.

Conferido, caso a caso: os 104 **já estavam com o operador pretendido** (zero
com outro dono), todos com uma ficha irmã movida no mesmo aluno, 99 alunos
distintos. Nenhum ficou sem responsável.

**O que faltou neles, e a correção.** O responsável estava certo, mas a marca
`giro_fidelizacao_ate` não foi gravada — ela só é escrita pelo `UPDATE` do
executor, que não rodou para eles. Efeito medido: 3 dos 104 já estavam fora da
janela de 10 dias e poderiam voltar ao pool na manhã seguinte. O bloqueio de
ações massivas não era afetado, porque ele olha o **aluno** e todos os 104
tinham irmã marcada.

A correção, autorizada à parte, foi um `UPDATE` que gravou **só a marca** nos
104, com três condições: pertencer aos pulados daquela simulação, já estar com
o operador previsto e ainda não ter marca. Nenhum responsável foi tocado.
Depois dela: 3.922 de 3.922 casos protegidos até 26/10, 0 responsáveis
divergentes, 0 casos sem dono, 544 CPFs por operador, 0 acordos/parcelas/
títulos alterados e 0 divergências entre caso e ficha.

**Para um próximo giro:** vale o executor gravar a marca também nas fichas
irmãs do mesmo aluno, ou reconhecer que "dono já é o previsto" não é motivo
para pular — é motivo para completar. Hoje ele trata os dois casos como um só.

## 7. Limites declarados

* O saldo é o do título em aberto (`coalesce(saldo_corrigido, valor_em_aberto,
  valor_original)`), a mesma fórmula da view `calibragem_saldo_aluno`. Não é o
  saldo cobrável da norma, que segue sem implementação.
* 87 títulos em aberto têm `tipo_boleto` nulo e foram tratados como
  mensalidade. Se algum deles não for mensalidade, sai do universo — vale
  conferir se o número lhe parecer alto.
* A serpentina equilibra pelo saldo; a quantidade de **títulos** por operador
  varia de 1.256 a 1.320, porque ela não é critério de equilíbrio (CPFs e valor
  são). Se títulos passarem a importar, é outro algoritmo.
* `caso_protegido_redistribuicao` e `caso_encerrado_operacional` foram usadas
  como estão em produção. Elas têm vazamentos conhecidos já documentados; esta
  simulação não os corrige nem depende deles.
