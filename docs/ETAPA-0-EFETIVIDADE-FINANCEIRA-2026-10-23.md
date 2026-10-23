# Etapa 0 — medição independente e complemento ao Anexo A

**Data:** 2026-10-23 · **Natureza:** SOMENTE LEITURA · **Projeto PROD:** `ahattpqrjmhkzsmnbdzs`

> **Leia o [Anexo A do diagnóstico](DIAGNOSTICO-EFETIVIDADE-FINANCEIRA-2026-10-23.md)
> primeiro.** Ele é a Etapa 0 canônica, e este arquivo **não a substitui.**
>
> As duas medições foram feitas em paralelo, sem se verem, e **convergem ao
> centavo em 14 números independentes** (tabela abaixo). Isso não é redundância:
> é a verificação cruzada que a Etapa 0 não tinha. Onde o Anexo A é melhor,
> este documento cede e aponta para ele; o que ele traz de novo está marcado
> **[NOVO]**.

Nada foi aplicado, alterado, mesclado ou corrigido. Nenhuma migration, nenhum
cron, nenhum saldo, pagamento, acordo ou baixa foi tocado. Nenhum objeto novo
foi criado — a Etapa 0 proíbe, inclusive a view canônica.

Fontes oficiais consultadas antes de qualquer medição, conforme `CLAUDE.md`:
[`docs/integracoes/README.md`](integracoes/README.md) e
[`prime-mapa-fontes-verdade.md`](integracoes/prime-mapa-fontes-verdade.md).

---

## Convergência com o Anexo A — 14 números, duas medições cegas

| Medida | Anexo A | Aqui | Confere |
|---|---:|---:|:--:|
| Interseção 2026/1 × 2026/2 | 1 título / 4.549,84 | 1 / 4.549,84 | ✔ |
| Base congelada 2026/1 | 14.988 / 21.752.304,72 | idem | ✔ |
| …por `serie_prime` | 14.315 / 21.545.748,70 | idem | ✔ |
| …por `vencimento` (palpite) | 673 / 206.556,02 | idem | ✔ |
| Palpites já resolvidos pelo Prime | 6 (4 ok, 1→2025/2, 1→2026/2) | idem | ✔ |
| Títulos hoje no semestre errado | 2 / 4.726,24 | idem | ✔ |
| Palpites ainda em aberto | 667 / 201.144,55 | idem | ✔ |
| O título do caso | `4372383`, venc. 2026-06-05 | idem | ✔ |
| `aluno_saldo_pendente_detalhe` (total devido) | 47.209.713,10 | idem | ✔ |
| `saldo_cobravel_aluno` (total cobrável) | 46.686.338,11 | idem | ✔ |
| Diferença entre as duas | 523.374,99 | idem | ✔ |
| Alunos em que divergem | 71 de 16.090 | idem | ✔ |
| …por suspensão de cobrança | 69 / 520.955,63 | idem | ✔ |
| …por outra causa | 2 / 2.419,36 | idem | ✔ |
| `titulos_negociados_orfaos` | 0,00 | 0,00 | ✔ |

**Onde o Anexo A é melhor, e este documento cede:**

1. **O censo das funções é dele.** Ele achou **7 nomes** e mostrou que **três
   são invólucros** (`aluno_tem_saldo_pendente` → F1, `caso_saldo_operacional`
   → F1, `caso_saldo_zerado_real` → `caso_saldo_operacional`). Eu parti da
   lista de 6 da seção 6 e achei só um invólucro. **A contagem certa é a dele.**
2. **O enquadramento é dele.** "São 2, não 6" — só `aluno_saldo_pendente_detalhe`
   e `saldo_cobravel_aluno` respondem "quanto o aluno deve". É melhor para a
   gestão do que a minha contagem de corpos distintos.
3. **Ele identificou os 2 alunos divergentes por id** e amarrou cada um ao
   comentário no próprio código que previa as duas exceções. Eu só classifiquei
   em agregado.

**O que este documento acrescenta** — e que não está no Anexo A:

| # | Achado | Seção |
|---|---|---|
| 1 | **A matriz completa das 4 réguas**: existe uma segunda dupla contagem, `2025 × 2026/1` (1 título / R$ 176,40), que o Anexo A registra como erro de competência mas **não** como título contado em duas réguas | §1 |
| 2 | **O congelamento não congela**: 9 títulos (R$ 41.857,43) sumiram de `acordos_titulos` e saíram do "entrou" de 2026/1 em silêncio, com prova aritmética | §1 |
| 3 | **F3 e F4 medidos na população INTEIRA** (16.090), não em amostra de 1.500 | §2.4, §2.5 |
| 4 | **A resposta ao item 4 do pedido**: quanto do saldo é apurável por semestre — 86,68%, com fechamento ao centavo | §3 |
| 5 | **Verificação dos crons e do histórico de snapshot** (item 7 do pedido) | §6 |

---

## 0. Validação do método (por que os números abaixo são confiáveis)

Antes de medir interseção, reconstruí a população de cada uma das quatro réguas
a partir do corpo das funções em PROD. As quatro reproduzem **exatamente** o
"entrou" que elas próprias declaram:

| Régua | Títulos | "Entrou" reconstruído | Declarado no diagnóstico | Confere |
|---|---:|---:|---:|:--:|
| 2024 | 8.469 | 5.159.080,84 | 5.159.080,84 | ✔ |
| 2025 | 20.883 | 15.243.972,57 | 15.243.972,57 | ✔ |
| 2026/1 | 14.979 | 21.710.447,29 | 21.710.447,29 | ✔ |
| 2026/2 | 5.320 | 9.963.084,01 | 9.963.084,01 | ✔ |
| **Total** | **49.651** | **52.076.584,71** | — | |

Coincidência exata nas quatro, ao centavo. É isso que autoriza tratar as
interseções da seção 1 como medida, não como estimativa.

---

## 1. Interseção entre a base congelada de 2026/1 e o fallback de 2026/2

### A resposta

**A sobreposição existe e é de 2 títulos / R$ 4.726,24** — 0,0091% dos
R$ 52,08 milhões de "entrou". Em valor é imaterial. **Em mecanismo, não é**, e
a causa não é a que o diagnóstico supôs.

**[NOVO frente ao Anexo A]** O Anexo A mediu a interseção `2026/1 × 2026/2`.
Medi **as seis** possíveis entre as quatro réguas, e há uma segunda: o título
que o Prime reclassificou para `2025/2` está hoje **na régua de 2025 e na base
congelada de 2026/1 ao mesmo tempo** — o Anexo A o registra como erro de
competência, mas não como dupla contagem. Matriz completa (por `titulo_id`,
não por documento):

| Par | Títulos em comum | Valor |
|---|---:|---:|
| 2024 × 2025 | 0 | — |
| 2024 × 2026/1 | 0 | — |
| 2024 × 2026/2 | 0 | — |
| **2025 × 2026/1** | **1** | **176,40** |
| 2025 × 2026/2 | 0 | — |
| **2026/1 × 2026/2** | **1** | **4.549,84** |

### A causa real: não é o fallback de 2026/2 — é o congelamento

**O fallback de 2026/2 é seguro por desenho.** Ele está dentro de um
`coalesce(s.semestre, case when vencimento in [2026-07-01, 2027-01-01) then
'2026/2' end)`: só dispara quando **não existe série nenhuma** no Prime. Um
título que o Prime já atribuiu a outro semestre nunca entra em 2026/2 por
vencimento. Ele não pode criar a sobreposição.

Quem cria é **a base congelada de 2026/1**, e por um motivo estrutural: ela
congelou palpites.

| `origem_semestre` em `carteira_2026_1_base` | Títulos | Valor |
|---|---:|---:|
| `serie_prime` (fonte oficial) | 14.315 | 21.545.748,70 |
| **`vencimento` (palpite)** | **673** | **206.556,02** |
| Total congelado em 2026-09-11 16:40 UTC | 14.988 | 21.752.304,72 |

Os 673 entraram por vencimento porque, **na data do congelamento**, não tinham
série no Prime. O congelamento é definitivo; a série do Prime não é — ela chega
depois. Desses 673, o Prime já respondeu sobre 6:

| O que o Prime diz hoje | Títulos | Valor | Veredito |
|---|---:|---:|---|
| ainda sem série | 667 | 201.144,55 | palpite não verificado |
| `2026/1` | 4 | 685,23 | confirma o palpite |
| **`2025/2`** | **1** | **176,40** | **contradiz → dupla contagem em 2025** |
| **`2026/2`** | **1** | **4.549,84** | **contradiz → dupla contagem em 2026/2** |

**Dos 6 palpites que o Prime já resolveu, 2 estavam errados — 33%.** Os outros
**667 (R$ 201.144,55) são apostas abertas**: cada série que a ULBRA publicar
pode virar uma nova dupla contagem, e a base congelada não tem como aprender.
O caso de R$ 4.549,84 é exemplar: documento `4372383`, vencimento 2026-06-05,
congelado como 2026/1 **por vencimento**, e hoje com 1 linha no Prime dizendo
`2026/2` — está nas duas réguas, pela fonte oficial em uma e pelo palpite na
outra.

### Achado não previsto: o congelamento não congela

`carteira_2026_1_classificar()` lê a base congelada com **`join` em
`acordos_titulos` ao vivo**. Quando um título desaparece da tabela viva, ele
sai do "entrou" de 2026/1 **em silêncio**:

```
9 títulos congelados não existem mais em acordos_titulos  →  R$ 41.857,43
```

Prova aritmética: `21.752.304,72 − 41.857,43 = 21.710.447,29`, que é exatamente
o "entrou" declarado de 2026/1. **O saldo inicial de 2026/1 já encolheu
R$ 41.857,43 desde o congelamento, e nenhuma tela registra isso.** A promessa
de "base congelada" vale para a lista de títulos, não para o valor declarado.

### Consequência para o desenho (Etapa 3)

Replicar o congelamento para 2024, 2025 e 2026/2 **sem corrigir estes dois
pontos replicaria os dois defeitos em escala maior**. A Etapa 3 precisa, antes:

1. **Nunca congelar palpite como se fosse fonte.** Gravar `origem_semestre` já
   acontece — o que falta é a régua **tratar `vencimento` como provisório** e
   reconsultar o Prime, em vez de tratar as duas origens como equivalentes.
2. **`left join`, não `join`**, na leitura da base congelada, com linha própria
   para "título congelado que não existe mais" — hoje R$ 41.857,43 somem sem
   deixar rastro.

---

## 2. Comparação linha a linha das seis funções de saldo por aluno

Universo: **16.090 alunos** com ao menos um título ou acordo. As cinco funções
chamáveis por aluno foram executadas **aluno por aluno**, não por amostra.

### 2.1 O censo — a contagem certa é a do Anexo A

> **Correção deste documento.** Parti da lista de 6 nomes da seção 6 do
> diagnóstico e identifiquei **um** invólucro. O Anexo A foi mais longe: achou
> **7 nomes e 3 invólucros**, e concluiu que **apenas 2** respondem "quanto o
> aluno deve". **Vale a contagem dele.** A tabela abaixo fica como registro do
> que eu medi, com a ressalva de que o censo é o do Anexo A.

| # | Função | Chave | Natureza |
|---|---|---|---|
| f1 | `saldo_cobravel_aluno` | `aluno_id` | fórmula própria |
| f2 | `aluno_saldo_pendente_detalhe` | `aluno_id` | fórmula própria |
| f3 | `caso_saldo_operacional` | `aluno_id`/matrícula | **invólucro de f2** |
| f4 | `saude_carteira_saldo_por_origem` | `aluno_id[]` | fórmula própria |
| f5 | `saldo_titulos_aberto` | **`cpf`** | fórmula própria |
| f6 | `carteira_saldo_historico_recalcular` | — | **não é função de saldo** |

- **f3 não é fórmula.** Ela chama f2 e repassa o `total` sem tocar. Medido:
  **0 divergências em 8.106 alunos.** O que f3 acrescenta é `baixas_pendentes`
  no booleano `tem_saldo`, não valor.
- **f6 não é função de saldo por aluno.** É construtora de coorte: filtra
  `portador = 195`, `semestre in ('2024/1','2024/2','2025/1','2025/2')` ou nulo,
  só graduação/pós, sem pagamento, sem liquidação, `saldo > 0`, não negociado.
  Comparar o total dela com f1–f5 não tem sentido — ela responde outra pergunta.

**O problema real é muito menor do que "seis fórmulas divergentes"** — e o
Anexo A o enuncia melhor: são **duas** funções respondendo "quanto o aluno
deve", e elas são a mesma fórmula a menos da guarda de cobrabilidade.

### 2.2 Os totais

| # | Função | Total sobre os 16.090 alunos |
|---|---|---:|
| f1 | `saldo_cobravel_aluno` | 46.686.338,11 |
| **f2** | **`aluno_saldo_pendente_detalhe`** | **47.209.713,10** |
| f3 | `caso_saldo_operacional` | ≡ f2 |
| f4 | `saude_carteira_saldo_por_origem` | 47.236.644,32 |
| f5 | `saldo_titulos_aberto` (por CPF) | 35.935.225,29 |

### 2.3 f1 × f2 — 71 alunos, R$ 523.374,99, explicado 100%

| Causa | Alunos | Valor (f2 − f1) |
|---|---:|---:|
| **A.** aluno em `SUSPENSAO_COBRANCA` (f1 devolve 0 por desenho) | 69 | 520.955,63 |
| **B.** parcela de acordo em status ≠ ATIVO e ≠ CANCELADO | 1 | 578,12 |
| **C.** parcela `RENEGOCIADA` em acordo ATIVO | 1 | 1.841,24 |
| **Total** | **71** | **523.374,99** |

**Resíduo zero** — a soma das causas é exatamente a divergência medida. E a
conclusão importa: **f1 × f2 não é defeito.** É a decisão de 08/10/2026 em
funcionamento — cobrança suspensa sai da cobrabilidade e a dívida continua
registrada. `f1 ≡ f2` a menos da guarda de suspensão e de dois casos de borda
(R$ 2.419,36).

### 2.4 f2 × f5 — 2.199 alunos, R$ 11.340.789,11: perguntas diferentes

**[NOVO frente ao Anexo A]** Ele mediu F3/F4 numa amostra de 1.500 alunos.
Esta seção e a 2.5 medem na **população inteira (16.090)**, o que fecha a
decomposição ao centavo.

Decomposição exata de f2:

| Componente de f2 | Valor |
|---|---:|
| títulos `ABERTO` | 35.949.284,36 |
| títulos `NEGOCIADO` órfãos | **0,00** (nenhum hoje) |
| parcelas de acordo não-cancelado | 11.260.428,74 |
| **Total** | **47.209.713,10** ✔ |

`f2 − f5 = R$ 11.274.487,81`, dos quais **R$ 11.260.428,74 são a componente de
parcelas, que f5 simplesmente não tem.** Resíduo: R$ 14.059,07.

**f5 não é uma fórmula de saldo divergente — é outra pergunta:** "saldo de
mensalidade em aberto sem vínculo". Chamá-la de saldo do aluno omite 24% da
dívida. O resíduo de R$ 14.059,07 vem de três fragilidades próprias, medidas:

| Fragilidade de f5 | Exposição medida |
|---|---|
| chave é **CPF**, não `aluno_id` | **26 CPFs em 2+ fichas, 96 fichas**: f5 devolve a soma de todas a cada uma |
| CPF vazio vira `00000000000` | **44 alunos** caem no mesmo balde |
| usa só `saldo_corrigido`, sem fallback | **31 títulos** `ABERTO` com `saldo_corrigido` nulo contam **zero** (R$ 47.627,60) |
| exclui título com **qualquer** linha de vínculo | inclusive vínculo inativo ou de acordo cancelado |

### 2.5 f2 × f4 — 8 alunos, R$ 33.417,18: f4 ignora o ajuste aprovado

f4 fica **acima** de f2. Causa dominante: f4 usa
`coalesce(saldo_corrigido, valor_original, 0)` e **não lê
`valor_cobranca_ajustado`**. Onde a gestão aprovou uma redução, f4 continua
exibindo o valor cheio. Nos 4 alunos divergentes de uma metade do universo,
f4 − f2 = R$ 10.182,52 e o ajuste ignorado nesses mesmos alunos é
R$ 12.023,76 — mesma ordem e mesmo sentido (atribuição dominante, não
exaustiva: as populações de f2 e f4 também diferem).

**Exposição total do ajuste ignorado: 12 títulos, R$ 40.090,65** de redução
aprovada pela gestão, invisível em **f4, f5 e nas quatro réguas da
Efetividade** (que usam `valor_original` cru).

### 2.6 Candidata a canônica

**f2 (`aluno_saldo_pendente_detalhe`).** Três razões medidas:

1. é a única cuja decomposição **fecha exato** (seção 2.4);
2. é a única com a cadeia completa
   `coalesce(valor_cobranca_ajustado, saldo_corrigido, valor_em_aberto, valor_original, 0)`
   — respeita o ajuste da gestão, que f4 e f5 ignoram;
3. f1 **já é** f2 com a guarda de suspensão (seção 2.3), e f3 **já é** f2.

Então a consolidação natural é `f1 = f2 × guarda de suspensão`, sem inventar
nada. **Nenhuma view foi criada** — a Etapa 0 proíbe, e a decisão de promover
f2 a canônica é da gestão.

Ressalva: f2 **não tem dimensão de semestre**, e nenhuma das cinco tem. Ver
seção 3.

---

## 3. Quais fontes permitem apurar o saldo real por semestre **[NOVO]**

> Esta seção responde ao item 4 do pedido da gestão e **não tem equivalente no
> Anexo A**.

**Nenhuma das cinco funções de saldo por aluno carrega semestre.** Só f6 toca
`prime_titulo_semestre`, e só para a coorte de portador 195 / 2024–2025. A
apuração por semestre **tem de ser montada no nível do título**, que é onde a
chave existe.

Decomposição de f2 (R$ 47.209.713,10) pela possibilidade de atribuir semestre:

| Bloco | Valor | % | Apurável por semestre? |
|---|---:|---:|---|
| Mensalidade aberta **com série no Prime** | 35.441.912,76 | 75,07% | **SIM, direto** |
| Parcela de acordo de **1 semestre** | 5.482.085,06 | 11,61% | **SIM, pelo título do acordo** |
| Parcela de acordo **sem título vinculado (L2)** | **5.546.425,79** | **11,75%** | **NÃO** |
| Mensalidade aberta **sem série no Prime** | 507.371,60 | 1,07% | NÃO |
| Parcela de acordo de **2+ semestres** | 222.201,32 | 0,47% | só com rateio declarado |
| Parcela de acordo só com título sem série | 9.716,57 | 0,02% | NÃO |
| **Total** | **47.209.713,10** | 100% | **86,68% apurável** |

Fecha ao centavo contra f2. E o detalhamento do lado do título mostra que a
série do Prime cobre quase tudo:

| Semestre de origem | Títulos | Saldo aberto |
|---|---:|---:|
| 2026/1 | 7.072 | 9.677.658,74 |
| 2026/2 | 4.106 | 7.886.148,45 |
| 2025/1 | 9.576 | 6.487.928,07 |
| 2025/2 | 10.302 | 6.409.674,33 |
| 2024/2 | 5.080 | 2.924.215,22 |
| 2024/1 | 3.228 | 2.056.287,95 |
| **(sem série no Prime)** | 1.122 | 507.371,60 |

**98,6% do saldo de mensalidade já tem semestre oficial.** O gargalo não é a
fonte do semestre — é o vínculo acordo↔título.

### A conclusão operacional

**O saldo real por semestre é apurável hoje para 86,68% da carteira, com fonte
oficial e sem nenhuma presunção.** O bloqueio é um só, e é o mesmo L2 que o
diagnóstico já identificou do lado do caixa: **1.360 acordos com parcela viva e
nenhum título vinculado, R$ 5.546.425,79.** Medido do lado do saldo:

| Classe do acordo | Acordos | Parcelas vivas |
|---|---:|---:|
| **D.** nenhum título vinculado | **1.360** | **5.546.425,79** |
| A. 1 semestre (atribuível) | 998 | 5.482.085,06 |
| B. 2+ semestres (exigiria rateio) | 28 | 222.201,32 |
| C. só título sem série no Prime | 4 | 9.716,57 |
| **Total** | **2.390** | **11.260.428,74** ✔ |

Cada vínculo que a Central de Pagamentos e a Conferência Prime criarem move
valor de D para A **automaticamente**, sem mudar uma linha da proposta. L2 é a
mesma frente dos dois lados do balanço — não são dois problemas.

---

## 4. A distinção que não pode ser perdida

Preservada integralmente, e agora com nome fixo nas duas dimensões:

| | Recuperação **comprovada** | Recuperação **estimada por status** |
|---|---|---|
| Fonte | `pagamentos.valor_pago`, com data | `parcelas.status='PAGO'` → rateio proporcional |
| O que prova | que entrou dinheiro, e quando | que alguém marcou a parcela |
| Tamanho | **R$ 4.441.845,28** rastreável a semestre (ver nota) | R$ 7.536.194,00 declarado pelas réguas |
| Contraprova medida | — | **4.939 das 6.250 parcelas `PAGO` (89,5% do valor) não têm `origem_baixa_ref`** |

**Nunca na mesma coluna, nunca somadas, e a diferença sempre exibida com
nome.** `conferencia.fecha = true` é teste de integridade de partição, não
conferência de caixa, e não deve ser apresentado à gestão como se fosse.

> **Nota — número corrigido pelo Anexo B.** A seção 9 do diagnóstico (e a
> primeira versão desta tabela) dizia **R$ 4.772.446,60 / 2.712 pagamentos**.
> Esse cálculo usava a **união** das portas de vínculo e, quando duas portas
> apontavam para acordos diferentes, aceitava a que tivesse título — escolhia a
> mais conveniente. A Etapa 1, já construída (Anexo B), aplica **precedência**
> (porta provada > chave exata) e recusa o atalho: **R$ 4.441.845,28 / 2.618**.
> **Vale o número do Anexo B.**

---

## 5. Recuperação mensal por semestre, com origem auditável

Confirmado construtível, sem presunção, com a precedência que evita a dupla
contagem dos 168 pagamentos que casam mais de um acordo:

```
porta_vinculo  = origem_baixa_ref  >  boleto_parcela  >  numero_ulbra
confianca      = PROVADA           |  CHAVE_EXATA     |  INDETERMINADA
```

`(indeterminado)` é **linha de primeira classe** — nunca distribuída por
proporção, data próxima ou valor parecido. Os quatro motivos são fechados:
`ACORDO_FORA_DO_CRM`, `ACORDO_SEM_TITULO`, `TITULO_SEM_SERIE_PRIME`,
`SEMESTRE_MULTIPLO`.

Teste de aceitação, inalterado: `Σ valor_pago` da view = **R$ 13.697.182,98**,
com **zero pagamento fora**. A view classifica todos, inclusive os que não
resolve.

---

## 6. Atualização diária automática — verificado em PROD **[NOVO]**

> Item 7 do pedido da gestão; **sem equivalente no Anexo A**.

### Não é preciso cron novo. Confirmado job a job

| Job | Agenda (UTC) | Ativo | O que faz |
|---|---|:--:|---|
| 1 `atualizar_parcelas_vencidas_diario` | `5 3 * * *` | ✔ | vira parcelas vencidas |
| 3 `recalcular_situacao_virada_diaria` | `0 6 * * *` | ✔ | virada de situação |
| 7 `saude_carteira_snapshot_diario` | `5 8 * * *` | ✔ | snapshot diário **com histórico** |
| 12 `relatorio_2026_1_snapshot_diario` | `50 2 * * *` | ✔ | snapshot diário **com histórico** |
| 53 `carteira_saldo_historico_hora` | `25 * * * *` | ✔ | `carteira_saldo_historico_recalcular()` |
| 69 `carteira_efetividade_dreno` | `*/5 * * * *` | ✔ | recalcula pendentes |
| 70 `carteira_efetividade_hora` | `3 * * * *` | ✔ | `carteira_efetividade_recalcular()` |

### O problema é tabela, não cron — confirmado

| Tabela | Linhas | Guarda histórico? |
|---|---:|---|
| `carteira_efetividade_snapshot` | **9** | **NÃO** — colunas `bloco, recorte, payload, gerado_em, duracao_ms`; **não existe `dia`** |
| `relatorio_mens_2026_1_snapshot` | 84 | SIM — 84 dias distintos |
| `saude_carteira_snapshot` | 82 | SIM — 82 dias distintos |

A Efetividade recalcula **de hora em hora** e **sobrescreve** as mesmas 9 linhas
(3 blocos × 3 recortes). **O dia anterior não existe.** Comparar dias hoje é
impossível — por falta de tabela, não de rotina. E o padrão a copiar já está
pronto e rodando em duas tabelas do próprio projeto.

### Desenho (para decisão da gestão, não implementado)

- **Tabela `efetividade_dia`**, chave `(dia, semestre)`, nos moldes das duas que
  já funcionam. **Append-only:** `on conflict do update` **só para o dia
  corrente**; dia fechado nunca é reescrito.
- **Sem cron novo:** estender o comando do **job 70** com
  `select efetividade_dia_gravar()` guardado por "só grava se ainda não houver
  linha fechada para o dia", ou usar a janela livre do **job 12** (02:50 UTC).
  É uma linha de `cron.alter_job`. **A escolha é da gestão.**
- **Janela correta:** depois do job 1 (03:05 UTC) e do job 3 (06:00 UTC), para o
  dia fechar com as parcelas já viradas.
- **Dado atrasado:** `data_pagamento` é a data do banco e o pagamento entra no
  CRM depois. O dia fechado **recebe pagamento novo**. Tratamento: campo
  `caixa_lancado_apos_fechamento` + `gerado_em`, e a variação aparece como
  ajuste retroativo identificado, no dia em que chegou, apontando para o dia a
  que pertence. **Nunca reescrever o dia fechado em silêncio.**
- **Reconciliação por linha:**
  `saldo_anterior − recuperado_dia − cancelado_dia − suspenso_dia ± ajuste_dia = saldo_atual`.
  Não fechando, **gravar a linha com a diferença explícita** e
  `reconciliado = false` — nunca descartar o dia nem forçar o número.

### Fonte oficial de cada campo — com as três correções que a Etapa 0 impõe

| Campo | Fonte oficial | Correção vinda desta Etapa 0 |
|---|---|---|
| Saldo inicial | base congelada do semestre + **data do congelamento** | `left join`, e linha para o título congelado que sumiu (R$ 41.857,43) |
| Saldo atual | **f2** `aluno_saldo_pendente_detalhe` | respeita `valor_cobranca_ajustado` (R$ 40.090,65), que f4/f5 ignoram |
| Saldo por semestre | título → `prime_titulo_semestre`; acordo → título do acordo | 86,68% apurável; L2 é linha própria, não rateio |
| Recuperado no dia (caixa) | `pagamentos.valor_pago` via view da Etapa 1 | precedência `origem_baixa_ref > boleto_parcela > numero_ulbra` |
| Recuperado por rateio | régua do semestre | rotulado **rateio**, coluna separada |
| Honorários recebidos | `pagamentos.valor_honorario` — **só esta** | as outras 4 fontes são expectativa (razão 17:1) |
| Cancelamentos | `situacao='CANCELADA'` + `origem_encerramento` | — |
| Suspensões | `parcelas.efeito_sem_pagamento` + `aluno_bloqueio_administrativo` | a guarda de f1 já isola R$ 520.955,63 |
| Ajustes | `titulo_valor_ajuste_historico` | hoje fora das 4 réguas |
| Diferença de conciliação | rateio − caixa, por semestre | **sempre exibida** |

---

## 7. O que mudou na proposta técnica

> **A revisão canônica da proposta é a [`A.3` do Anexo A](DIAGNOSTICO-EFETIVIDADE-FINANCEIRA-2026-10-23.md).**
> Esta tabela só acrescenta o que vem das seções marcadas **[NOVO]** aqui.
>
> E **a Etapa 1 já não está pendente**: ela foi construída (migration escrita e
> testada, **não aplicada**, branch `feat/efetividade-caixa-origem`) e está
> documentada no Anexo B, que inclusive **corrigiu um número do diagnóstico**.

| Etapa | O que estas seções [NOVO] acrescentam |
|---|---|
| **3** base congelada para 2024/2025/2026/2 | Além da reconferência registrada que a A.3 já exige: trocar o `join` por **`left join`** na leitura do congelado, com linha própria para "título congelado que não existe mais" — hoje R$ 41.857,43 somem sem rastro (§1) |
| **4** painel com duas colunas | Ganha a terceira linha: **saldo por semestre**, 86,68% apurável, com `L2` nomeado em R$ 5,55 mi (§3) |
| **5** suspensões e ajustes como linha | **Dimensionada:** suspensão = R$ 520.955,63 (69 alunos); ajuste = R$ 40.090,65 (12 títulos), invisível em F3, F4 e nas 4 réguas (§2.5) |
| **novo** atualização diária | Crons e histórico de snapshot **verificados job a job**: não falta rotina, falta tabela — `carteira_efetividade_snapshot` tem 9 linhas e nenhuma coluna `dia` (§6) |
| **novo** dupla contagem entre réguas | Existe uma segunda, `2025 × 2026/1` (R$ 176,40), que a A.3 não registra como tal (§1) |

---

## 8. O que esta Etapa 0 NÃO fez

- Não criou nenhum objeto — nem view, nem tabela, nem função, nem cron.
- Não alterou nem aplicou nenhuma migration.
- Não tocou `pagamentos`, `parcelas`, `acordos`, `acordos_titulos`,
  `baixas_pagamento` nem `carteira_2026_1_base`.
- Não corrigiu os 2 títulos em dupla contagem, nem os 9 títulos congelados que
  sumiram, nem promoveu f2 a canônica. Tudo isso depende de decisão.
- Não tocou Central de Pagamentos, Santander, Criticidade nem Revisão
  Cadastral.
