# Mapa de identificadores

Toda relação entre IDs que a integração Prime/ULBRA usa hoje, e o que cada um
vale para matching automático. Particularmente importante para re-acordo, onde
usar o ID errado já causou dobra de dívida (ver memórias
`acordo-vinculo-re-acordo-deterministico` e `parcela-renegociada-nao-cancela`).

| Identificador | Quem gera | Formato | Único? | Estável? | Serve para matching automático? | Relaciona com |
|---|---|---|---|---|---|---|
| **CPF** | Receita Federal | 11 dígitos | Sim, por pessoa | Sim | SIM — é a chave universal | tudo |
| **`registration`** (matrícula Prime) | Prime/ULBRA | numérico (ex. `2025001213`) | Sim, por vínculo acadêmico | Sim | SIM, mas **não é sinônimo automático** da matrícula do CRM | `alunos` via CPF, não via igualdade direta de matrícula |
| **matrícula do CRM** (`alunos.matricula`) | CRM (import histórico) | variável | Não garantido | Não garantido | **NÃO assumir igual à `registration`** — medido pelo menos 1 caso divergente (CRM 180 = Prime 2025001442) | só via CPF |
| **matrícula do arquivo Santander** | Santander (relatório da carteira 166) | igual em forma à `registration` | Sim, no arquivo | Sim | **SIM — bate com `registration` em 13 de 13 casos conferidos** | é a mesma coisa que `registration`, evidência direta, não a mesma coisa que a matrícula do CRM |
| **`documentNumber`** (Prime, mensalidade) | Prime | 13 dígitos: base(9) = `010`+contrato, sequência(4) = parcela fracionária (÷100; terminado em `990` = parcela 9,9) | Sim | Sim | SIM, só dentro do extrato Prime — não existe no CRM | série (prefixo) agrupa parcelas do mesmo contrato |
| **`documentNumber`** (Prime, acordo) | Prime | 13 dígitos: `0`+`5`+acordo(6)+**sequência(4)** | Sim | Sim | **PARCIAL — só os 6 dígitos centrais (acordo).** A validação 8/8 de 22/09/2026 conferiu o acordo contra `acordos.numero_ulbra` e segue valendo (reconferida em 23/10/2026: 13.703 de 13.754 parcelas, 99,6%). Os **4 últimos NÃO servem** para deduzir `parcelas.numero` — ver [limitação medida](#os-4-últimos-dígitos-não-são-parcelasnumero-medido-em-23102026) | acordo (6 díg. centrais) |
| **`boleto`** (Prime, financial-statement) | Prime | 7 dígitos | Sim | Sim | SIM — **é** `acordos_titulos.documento`, ponte confiável para portador 195 | `acordos_titulos.documento` |
| **título CRM (boleto de acordo)** | CRM/ULBRA | 11 dígitos: `5` + acordo(6) + **sequência(4)** | Sim | Sim | **PARCIAL — só o acordo.** `5`+acordo(6) é confiável (ex. `050308850007` → acordo `30885`; 99,6% da base em 23/10/2026). Os **4 últimos NÃO são `parcelas.numero`** e não podem ser tratados como tal por nenhuma convenção fixa — ver [limitação medida](#os-4-últimos-dígitos-não-são-parcelasnumero-medido-em-23102026). Para chegar à parcela, casar o boleto **inteiro** com `parcelas.boleto` | `acordos.numero_ulbra` |
| **`acordos.numero_ulbra`** | CRM (espelha o Prime) | numérico | Sim | Sim | SIM | boleto de acordo (decodificação acima) |
| **`pagamentos.titulo_numero`** | Arquivo Santander | já contém o **número do acordo** diretamente | Sim, quando presente | Sim | SIM — não precisa ser derivado do boleto | `acordos.id` (via número) |
| **`carrier.id`** (portador) | Prime | inteiro pequeno (95, 160, 166, 195, 202, ...) | Sim | Sim | SIM — é a chave, nunca o nome | ver tabela de portadores abaixo |
| **Nome (qualquer fonte)** | várias | texto livre | **NÃO** — homônimos confirmados (7 pares de CPFs diferentes com o mesmo nome-like em 01/09/2026) | Não | **NUNCA** — nome não vincula, nunca decide vínculo financeiro, é sempre secundário/sugestão | — |
| **`parcelas.boleto`** (CRM) | CRM | igual ao `boleto` da Prime, sem zero à esquerda (`ltrim`) | Sim (índice único `ux_parcelas_boleto`) | Sim | SIM — é a chave real do vínculo pagamento→parcela | `financial_statement[].boleto` |

## Os 4 últimos dígitos NÃO são `parcelas.numero` (medido em 23/10/2026)

**O que fica valendo do mapeamento anterior.** A validação de 22/09/2026
("decodificação provada 8/8") conferiu o **número do acordo** contra
`acordos.numero_ulbra`, e essa parte está confirmada em escala: dos 14.488
boletos de acordo do CRM com 11 dígitos, os 6 dígitos centrais batem com
`acordos.numero_ulbra` em **13.703 de 13.754** casos comparáveis — **99,6%**
(734 boletos ficam fora da comparação porque o acordo tem `numero_ulbra` nulo;
51 parcelas, em 47 acordos, divergem de fato e estão registradas como gap em
[`prime-gaps.md`](prime-gaps.md)). **O `5` + acordo(6) continua servindo para
matching.**

**O que NÃO se sustenta.** Ler os 4 últimos dígitos como `parcelas.numero` era
uma *interpretação* do formato, não o que aquelas 8 amostras testaram. Medido
sobre as mesmas 14.488 parcelas, nenhuma convenção fixa explica a maioria:

| Leitura dos 4 últimos dígitos | Casos | % |
|---|---:|---:|
| `= parcelas.numero` (0-based) | 7.455 | 51,5% |
| `= parcelas.numero + 1` (1-based) | 5.254 | 36,3% |
| `=` posição da parcela por vencimento, 1-based | 8.150 | 56,3% |
| `=` posição da parcela por `numero`, 1-based | 7.883 | 54,4% |
| **não casa com nenhuma das quatro** | **1.673** | **11,5%** |

Nenhuma leitura passa de 56,3%, e 11,5% das parcelas não casam com nenhuma
delas. **Portanto: não derivar parcela do boleto, em nenhuma direção.**

**Por que quebra.** Duas causas medidas, independentes:

1. **A numeração de `parcelas.numero` não é única na base.** Dos 4.831 acordos
   com parcela, **946 começam em 0** (19,6%), 3.685 começam em 1 e 200 começam
   em outro valor. A mesma fórmula não pode servir aos três.
2. **A sequência do boleto avança por emissão, e a parcela pode não ter
   boleto.** **863 acordos** têm pelo menos uma parcela sem boleto (634 não têm
   boleto em nenhuma). Quando há lacuna ou reemissão, a sequência e o `numero`
   deixam de andar juntos.

**O caso que torna isso visível — acordo `63061`** (lido em produção em
23/10/2026):

| `parcelas.numero` | vencimento | boleto | status |
|---:|---|---|---|
| 0 | 03/07/2026 | `50630610001` | PAGO |
| 1 | 04/08/2026 | `50630610002` | PAGO |
| 2 | 04/09/2026 | **nulo** | PAGO (`pago_em` 22/10, sem `origem_baixa`) |
| 3 | 04/10/2026 | `50630610003` | VENCIDA |

`0001` está na parcela `numero` 0 e `0002` na `numero` 1 — não fecha como
0-based nem como 1-based dentro do **mesmo acordo**. O terceiro boleto emitido
(`0003`) caiu na parcela 3, pulando a 2, que não tem boleto.

**O que usar.** A chave real do vínculo pagamento → parcela é `parcelas.boleto`
**inteiro** (índice único `ux_parcelas_boleto`), como a última linha da tabela
acima já registra. Essa parte não mudou.

**Consequência operacional já observada.** O motor de baixa compara o
vencimento do arquivo com o da parcela cujo `boleto` casa. Numa reemissão, o
boleto novo pertence a outra parcela e o vencimento do arquivo continua sendo o
da parcela antiga — o motor acusa "divergência de vencimento" onde o fato é
**boleto reemitido**. Os três casos de 22/10/2026 (`63061`, `66483`, `70820`)
estão classificados como `boleto_reemitido_vencimento_anterior` na triagem da
PR #737, em conferência humana e **sem ação automática**; dois deles são
suspeita de pagamento em duplicidade, R$ 1.969,68 somados. Nada foi alterado.

**Não afirmar o inverso como regra.** Esta medição prova que os 4 dígitos
**não** são `parcelas.numero`. Ela **não** prova que sejam "a sequência de
emissão da ULBRA": a leitura por posição de vencimento é a que explica mais
casos (56,3%) e ainda assim deixa 43,7% fora. A semântica exata dos 4 dígitos
**permanece não determinada** e não deve ser usada para inferência financeira.

## Portadores (carriers) mapeados

| ID | Nome | Convênio | `isCollectionAgency` | Papel |
|---|---|---|---|---|
| 95 | SANTANDER | 272036 | false | mensalidade corrente (ULBRA direto, fora do escopo Reativa) |
| 160 | SANTANDER | 272037 | false | irmão do 95, fora do escopo |
| **166** | **SANTANDER REATIVA** | **0272047** | false | **convênio bancário do boleto de ACORDO da Reativa** — nunca aparece em linha de extrato |
| **195** | **REATIVA RECUPERAÇÃO DE CRÉDITO** | null | true | **mensalidade em cobrança da Reativa — a carteira principal** |
| 165 | (judicial) | — | true | fora de escopo por decisão da gestão |
| 202 | REATIVA COBRANÇA JUDICIAL | — | true | fora de escopo por decisão da gestão |

## Regra de leitura da dívida (decidida pela gestão em 25/08/2026)

```
está no 195 (REATIVA RECUPERAÇÃO)   -> mensalidade em cobrança, AINDA DEVE
está no 166 (SANTANDER REATIVA)     -> negociou, virou ACORDO
não está em nenhum dos dois         -> QUITOU
```

Regra simples e não depende de adivinhar padrão de pagamento — mas **166 nunca
aparece em linha de extrato financeiro**, só na filiação (`students_search
?carrierId=166`). Por isso "está no 166" se confirma pela **listagem**, nunca
pelo extrato.

## Vínculo acadêmico (curso + campus + turno)

**NÃO FOI ENCONTRADO IDENTIFICADOR ESTÁVEL nos endpoints e na amostra
consultados.** Medido em 28/09/2026 numa amostra de 6
alunos devedores (35 vínculos, 111 contratos):

| candidato | resultado |
|---|---|
| campo de id no item de `students_search` | **nenhum** — as chaves são `registration`, `name`, `cpf`, `course`, `status`, `admissionYear`, `graduated`, `campus`, `shift` |
| `contracts[].number` | **string vazia em 111 de 111 contratos**, sem exceção |
| chave composta `course` + `campus` + `shift` | **não separa os vínculos** |

**Por que a chave composta não serve** — três defeitos medidos, cada um
suficiente para invalidá-la:

1. **Vínculos distintos com a chave idêntica.** Na matrícula `222007757`, três
   linhas têm `course` "SUPERIOR DE TECNOLOGIA EM COMÉRCIO EXTERIOR", o mesmo
   campus e o mesmo turno "ENSINO A DISTANCIA", com status
   `Reopção de Curso`, `Cancelado` e `null`. Nenhuma combinação dos campos
   disponíveis as distingue.
2. **Acentuação divide o mesmo curso, e normalizar funde vínculos diferentes.**
   Na `201008325` convivem "EDUCACAO FISICA - BACHARELADO"
   (`status: Reopção de Curso`, `graduated: false`) e
   "EDUCAÇÃO FÍSICA - BACHARELADO" (`status: Mudança de Campus`,
   `graduated: true`). Sem normalizar, não casam com o contrato; normalizando,
   **as duas colapsam numa só** e um dos status desaparece.
3. **Chave incompleta e dado sujo.** `campus` e `shift` vieram nulos em 10 dos
   35 vínculos, e `shift` aparece como "NOITE..." (com os pontos literais) ao
   lado de "NOITE" na mesma matrícula `221005273`.

**Consequência para matching contra contrato:** casando por curso normalizado,
**21 dos 35 vínculos casam com mais de um contrato** (um deles com 34) e **8 não
casam com nenhum**. Não há, na superfície atual da API, caminho para dizer
"este vínculo é o do contrato que gerou esta dívida".

**Portanto:** com os endpoints e a amostra consultados, associar situação
acadêmica ao curso de uma dívida **não é possível com prova**. Não é afirmação
sobre a API inteira: é o alcance do que foi medido, e um endpoint ou campo ainda
não sondado pode mudar a conclusão. Quem precisar do dado exibe os vínculos encontrados e
declara a não identificação — nunca escolhe uma linha, nunca promove o status de
um curso a status da pessoa, e nunca usa `contracts[].status` como substituto.

## Regras de matching, por ordem de confiabilidade

1. **CPF exato** (formatado na busca, comparado em dígitos puros no retorno)
2. **Boleto exato** (`parcelas.boleto` = `financial_statement[].boleto`, sem
   zero à esquerda)
3. **`documentNumber` decodificado** (série/prefixo aponta contrato ou acordo
   único)
4. **Número Ulbra único**
5. **Proximidade de data + valor** — NUNCA fonte de verdade sozinha; serve
   só como teste de consistência auto-verificável (ver Premissa 20 em
   `docs/PREMISSAS.md`) ou como sugestão para revisão humana
6. **Nome** — nunca vincula nada financeiro; serve só como pista secundária
   com aviso explícito na tela ("nome não é prova")
7. **Vínculo acadêmico (curso/campus/turno)** — **não é chave**: não separa
   vínculos distintos (ver a seção acima). Não serve para matching, nem como
   pista, porque o erro é silencioso: dois vínculos com status diferentes
   respondem à mesma chave

Ver também [prime-mapa-fontes-verdade.md](prime-mapa-fontes-verdade.md) para
qual identificador vale como fonte de verdade de cada informação.

## Preventivo (frente criada em 28/09/2026)

O Preventivo **não cria identificador novo**. A identidade de um título
preventivo é `(carteira, registration, documento)`, onde `documento` é o mesmo
`financial_statement[].boleto` (7 dígitos) ou `documentNumber` (13 dígitos)
que a Prime devolve — a sincronização casa pelos dois, por igualdade exata.

**Nome do aluno nunca entra na chave**, nem no Preventivo nem em lugar nenhum:
o nome do extrato é o do PAGADOR e já causou 10 baixas erradas na cobrança em
08/09/2026 (`regra-baixa-so-pelo-numero-do-titulo-nunca-por-nome`).

A matrícula usada é a `registration` do Prime, que **não** é necessariamente a
matrícula do CRM — ver a seção de `students_search` em
[prime-api.md](prime-api.md). Por isso o relatório importado precisa trazer a
matrícula do Prime (ou a do arquivo Santander, que bateu 13 de 13 com
`registration` nos casos conferidos), nunca a do CRM.
