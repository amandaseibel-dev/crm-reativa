# Giro total das carteiras 2026/1 e 2026/2 — SIMULAÇÃO (16/10/2026)

**Somente leitura.** Medido em produção (`ahattpqrjmhkzsmnbdzs`, projeto Reativa
One) pelo SQL Editor, em 16/10/2026. **Nada foi escrito: nenhuma migration,
nenhum caso movido, nenhuma simulação gravada em `calibragem_simulacoes`.**

Desenho e decisões: [`GIRO-CARTEIRAS-2026-1-2026-2-DESENHO.md`](GIRO-CARTEIRAS-2026-1-2026-2-DESENHO.md).
Consultas reproduzíveis: [`analises/2026-10-16-giro-carteiras-simulacao.sql`](analises/2026-10-16-giro-carteiras-simulacao.sql).

---

## 1. Relatório por operador

Distribuição em **duas passadas com prioridade 2026/2**, decidida pela gestão em
16/10 (o porquê e as alternativas descartadas estão na seção 4.5).

| Operador | CPFs 2026/1 | CPFs 2026/2 | CPFs únicos | Títulos | Saldo 2026/1 | Saldo 2026/2 | Consolidado | Desvio 2026/2 | Desvio total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Allan | 286 | 268 | 544 | 1.266 | 1.004.109,69 | 645.540,95 | 1.649.650,64 | −0,11% | +0,23% |
| Diego | 285 | 268 | 544 | 1.300 | 995.568,03 | 641.981,82 | 1.637.549,85 | −0,66% | −0,50% |
| João | 286 | 268 | 544 | 1.318 | 993.145,47 | 645.018,31 | 1.638.163,78 | −0,19% | −0,47% |
| Luana | 282 | 269 | 544 | 1.329 | 1.002.821,01 | 650.664,12 | 1.653.485,13 | +0,68% | +0,47% |
| Mauricio | 280 | 269 | 543 | 1.318 | 1.009.855,18 | 651.709,59 | 1.661.564,77 | +0,84% | +0,96% |
| Nataly | 284 | 268 | 544 | 1.255 | 993.181,47 | 644.830,13 | 1.638.011,60 | −0,22% | −0,47% |
| Rafaella | 285 | 268 | 544 | 1.305 | 998.275,61 | 644.085,17 | 1.642.360,78 | −0,34% | −0,21% |
| **Total** | **1.988** | **1.878** | **3.807** | **9.091** | **6.996.956,46** | **4.523.830,09** | **11.520.786,55** | | |

As colunas por semestre somam 3.866, e não 3.807, porque **59 CPFs devem nos
dois semestres** e contam nas duas colunas — continuando com **um** operador só.

## 2. Números pedidos

| | |
|---|---|
| CPFs únicos redistribuídos | **3.807** |
| Títulos | **9.091** |
| Saldo total da carteira redistribuída | **R$ 11.520.786,55** |
| Operadores | **7** |
| Média de CPFs por operador | **543,9** |
| Média de saldo por operador | **R$ 1.645.826,65** |
| Diferença entre maior e menor quantidade de CPFs | **1** (544 × 543) |
| Diferença de CPFs de 2026/2 | **1** (269 × 268) |
| Diferença financeira de **2026/2** | **R$ 9.727,77** — **1,49%** |
| Diferença financeira de 2026/1 | **R$ 16.709,71** — **1,65%** |
| Diferença financeira **consolidada** | **R$ 24.014,92** — **1,45%** |
| CPFs que mudam de operador | 3.660 — **a re-medir** |
| CPFs que permanecem com o mesmo responsável | 147 — **a re-medir** |

Os dois últimos foram medidos na distribuição anterior (serpentina única). A
troca para duas passadas muda quem recebe o quê, então esses dois números
precisam sair da simulação definitiva, gravada por `giro_2026_10_simular`. Os
demais já são da distribuição nova. 2.644 dos 3.807 CPFs não têm operador hoje,
então a maior parte do "muda de operador" continua sendo entrada de pool, não
troca entre operadores.

**Conferência de fechamento:** a soma das sete carteiras é exatamente
R$ 11.520.786,55 e 3.807 CPFs — igual ao total elegível. Nenhum CPF aparece em
dois operadores (0). As três somas (CPFs, títulos, saldo) fecham linha a linha.

## 3. O que NÃO é distribuído, e por quê

Universo total de mensalidades em aberto das competências 2026/1 e 2026/2:
**5.568 alunos, 12.147 títulos, R$ 18.099.144,99.**

| Situação | Alunos/CPFs | Títulos | Saldo R$ | Por quê |
|---|---:|---:|---:|---|
| **Distribuído** | 3.807 | 9.091 | 11.520.786,55 | — |
| Acordo ativo | 1.040 | 1.961 | 4.724.081,83 | tem parcela de acordo em aberto; mover entra em conflito com a regra "o dono do acordo é o responsável" e o pedido é não alterar acordos |
| Sem ficha no CRM | 513 | 540 | 741.082,78 | o título existe, o aluno não tem caso no CRM — não há responsável a atribuir |
| Caso protegido ou encerrado | 208 | 555 | 1.113.193,83 | negociação em curso, link vivo, termo, confirmação de pagamento, `nao_acionar`, Carteira Geral ou caso já encerrado |
| **Total fora** | **1.761** | **3.056** | **6.578.358,44** | |

3.807 + 1.040 + 513 + 208 = 5.568 ✓ · 9.091 + 1.961 + 540 + 555 = 12.147 ✓ ·
11.520.786,55 + 4.724.081,83 + 741.082,78 + 1.113.193,83 = 18.099.144,99 ✓

## 4. Três coisas que a medição mostrou e que mudam a leitura do giro

### 4.1. Dois terços da carteira 2026 hoje não têm dono

Dos 3.807 CPFs elegíveis, **2.644 (69,5%) estão sem operador neste momento** —
o giro não os tira de ninguém, ele os **coloca em alguém**. A conta dos 3.660
que "mudam de operador" se decompõe assim:

* 2.644 saem do pool para um operador (entrada, não troca);
* 1.016 trocam de um operador ativo para outro;
* 147 permanecem onde já estavam.

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

## 6. Limites declarados desta simulação

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
