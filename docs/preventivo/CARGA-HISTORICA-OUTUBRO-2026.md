# Carga histórica de outubro/2026 — conferência antes de gravar

Documento de **conferência**, não de execução. Ele existe para que a decisão de
carregar as fotos seja tomada sobre medida, e não sobre lembrança.

Medido em 2026-10-06 sobre os arquivos originais. **Remedido em 2026-10-08**
diretamente nos quatro CSV, o que corrigiu uma afirmação deste documento e
acrescentou os itens 1b e 1c.

> **ESTADO REAL EM 08/10/2026, conferido em produção (só leitura).** A versão
> anterior dizia "nada aqui foi importado nem registrado". **F3 está
> importada**: `prev_lote` tem uma linha, arquivo
> `relatorio_inadimplencia (17) whatsapp.csv` — o gêmeo byte a byte de F3 —,
> status `CONFIRMADO`, criada em 05/10/2026 18:10 UTC, com 10.762 títulos
> vinculados. Ela entrou pelo fluxo normal do módulo, **antes** desta
> conferência.
>
> **F1, F2 e F4 seguem não importadas.** E **nenhuma ação externa foi
> registrada**: `prev_acao` tem uma única linha, `origem = 'MODULO'`, estado
> `PREPARADA`, nunca exportada nem confirmada como enviada — zero linhas com
> `origem = 'EXTERNA'`.

## 1. O escopo dos quatro relatórios — PENDENTE de confirmação da gestão

A pergunta que precisa de resposta antes da carga: **um dos arquivos foi
extraído com filtro de canal?** Se tivesse sido, a ausência de um aluno nele
não significaria regularização — significaria que ele nunca esteve ali.

**Esta pergunta segue em aberto.** O que está abaixo é indício a favor de que o
escopo é o mesmo; não é prova, e não substitui a confirmação de quem extraiu os
relatórios.

| Foto | Arquivo | Linhas | Sem telefone | Sem e-mail | Colunas |
|---|---|---:|---:|---:|---:|
| F1 — sexta, 02/10 | `relatorio_inadimplencia_16_2.csv` | 14.021 | 89 | 94 | 18 |
| F2 — 05/10, manhã | `relatorio_inadimplencia_17.csv` | 11.993 | 77 | 79 | 16 |
| F3 — 05/10, tarde | `relatorio_inadimplencia_17_whatsapp.csv` | 10.797 | 71 | 73 | 16 |
| F4 — hoje, 06/10 | `relatorio_inadimplencia (17).csv` | 6.298 | 45 | 45 | 16 |

**O indício.** O arquivo cujo nome diz `whatsapp` ainda carrega **71 linhas sem
telefone nenhum** — gente que não teria como receber WhatsApp. Um filtro por
"tem telefone" não teria deixado essas linhas passar. A taxa de preenchimento
também é praticamente idêntica nas quatro fotos (telefone 99,3%–99,4%, e-mail
99,3%), quando um recorte por canal faria essa taxa saltar para 100% naquele
campo.

**Por que isso não é prova.** O indício só descarta uma hipótese específica — a
de um filtro por "possui telefone". Ele não descarta as outras, e nenhuma delas
deixaria marca no preenchimento de contato:

- recorte por **unidade, curso, campus ou faixa de saldo**, decidido na origem;
- um público montado **fora do relatório** e depois exportado;
- parâmetro diferente na extração que nada tem a ver com canal (data de corte,
  situação acadêmica, tipo de boleto).

O nome do arquivo sugere que descreve **o que foi feito com ele depois**, e não
um filtro aplicado na extração — mas isso é leitura do nome, não medição.

> **CORREÇÃO DE 08/10/2026.** A versão anterior deste documento afirmava que as
> colunas `Situação Acadêmica` e `Tipo de Boleto` vinham **vazias nos quatro
> arquivos**, e usava isso como razão para não ser possível conferir o escopo
> por elas. **Está errado.** Medido linha a linha nos quatro CSV originais, as
> duas colunas estão **preenchidas em 100% das linhas de dados**:
>
> | Foto | `Situação Acadêmica` | `Tipo de Boleto` |
> |---|---:|---:|
> | F1 | 14.020 / 14.020 | 14.020 / 14.020 |
> | F2 | 11.992 / 11.992 | 11.992 / 11.992 |
> | F3 | 10.796 / 10.796 | 10.796 / 10.796 |
> | F4 | 6.297 / 6.297 | 6.297 / 6.297 |
>
> (Cada arquivo tem **uma** linha final em branco, que é o que separa estes
> números da contagem de linhas da tabela do item 1.)
>
> A consequência é que a conferência por esses campos **é possível** — e, feita,
> ela não confirma o escopo: aponta divergência. Ver a subseção abaixo.

**Pendente:** confirmação da gestão de que os quatro relatórios foram extraídos
com os **mesmos parâmetros**. Sem ela, a ausência de um aluno entre duas fotos
não pode ser lida como saída da base.

Com a medição de 08/10 (item 1b), a pergunta ficou mais específica — são três,
e as três são para quem extraiu os relatórios:

1. **Houve filtro por `Situação Acadêmica`?** F1 traz 2 categorias e F4 traz 6.
   Se não houve filtro, a diferença é da base — mas isso precisa ser afirmado
   por quem extraiu, não inferido por quem lê.
2. **Houve filtro por `Escola`, `Estabelecimento`, `Curso` ou `Processo`?** F4
   tem 2 Escolas que F3 não tem, sendo 42% menor.
3. **F1 saiu de outra versão do relatório?** O template de 18 colunas, com
   `Turno` e `Turma` presentes e 100% vazios, é objetivo.

F1 traz duas colunas a mais (`Turma` e `Turno`) — template mais largo. Isso
mostra que **pelo menos um parâmetro de extração mudou entre F1 e as demais**,
o que é mais uma razão para a confirmação não ser dispensada. F2, F3 e F4 têm
cabeçalho idêntico entre si.

Observação de arquivo: `relatorio_inadimplencia (17) whatsapp.csv` é
**byte a byte igual** a `relatorio_inadimplencia_17_whatsapp.csv` (mesmo md5).
São quatro fotos distintas, não cinco. **Reconferido em 08/10/2026:** md5
`5d03b0aa17b78993a1ea573b926da6ba` nos dois.

### 1b. Conferência pelos campos que existem — medida em 08/10/2026

Com as duas colunas preenchidas, a conferência saiu do campo da suposição. Ela
**não confirma** que o escopo é o mesmo; ela mostra divergência.

**`Situação Acadêmica` — o conjunto de categorias difere por foto:**

| Foto | categorias | quais |
|---|---:|---|
| F1 | **2** | Cancelado · Matriculado Curso Normal |
| F2 | **5** | as 2 acima · Reopção de Curso · Saída por Transferência · Trancado |
| F3 | **5** | as mesmas 5 de F2 |
| F4 | **6** | as 5 acima · Aguardando Matrícula |

O desenho é o inverso do que amostragem explicaria: **F1 é o maior arquivo
(14.021 linhas) e tem a menor variedade (2 categorias)**; F4 é o menor (6.298) e
tem a maior (6). Amostra maior tende a mostrar mais categorias, não menos. Isso
é indício forte de que a extração de F1 teve parâmetro diferente — mas **não é
prova**, porque a base muda entre 02/10 e 06/10 e nenhum campo registra *por
que* a linha entrou.

**`Dt Vcto`:** F2, F3 e F4 trazem exclusivamente `05/10/2026`. F1 traz
`05/10/2026` em 14.016 linhas, mais 2 em `01/10/2026` e 2 em `08/10/2026` — uma
janela marginalmente mais larga, de 4 linhas.

**Nenhuma foto é subconjunto puro de outra.** Medido por matrícula (`Código`),
todos os seis pares têm linhas exclusivas **dos dois lados**:

| Par | só no 1º | só no 2º | comum |
|---|---:|---:|---:|
| F1 (13.973) × F2 (11.951) | 2.123 | 101 | 11.850 |
| F1 × F3 (10.762) | 3.311 | 100 | 10.662 |
| F1 × F4 (6.279) | 7.833 | 139 | 6.140 |
| F2 × F3 | 1.190 | 1 | 10.761 |
| F2 × F4 | 5.724 | 52 | 6.227 |
| F3 × F4 | 4.535 | 52 | 6.227 |

Os números do item 2 abaixo usam identidade de **título**
(`matrícula + Dt Vcto + Vcto Origem`); estes usam **matrícula**. Daí as
pequenas diferenças (2.126 × 2.123, 4.536 × 4.535): são chaves distintas
medindo a mesma coisa em granularidades distintas, não contradição.

**F4 contém categorias que F3 não tem**, apesar de ser 42% menor:

- **Escola:** 2 ausentes em F3 — `ADMINISTRACAO`, `ODONTOLOGIA`
- **Curso:** 5 ausentes em F3 — `FISIOTERAPIA NOT`, `IMPLANTODONTIA`,
  `MBA EM ENGENHARIA DE SOFTWARE FULL STACK COM I.A`, `PROTESE DENTARIA`,
  `PSICOPEDAGOGIA INSTITUCIONAL E CLINICA`
- **Processo:** 3 ausentes em F3 — `10842`, `34200`, `34214`

Um subconjunto puro de F3 não poderia trazer Escola que F3 não tem. Somado às
52 matrículas exclusivas de F4, a leitura mais provável é que **F4 não é a mesma
população encolhida** — é população diferente, por recorte ou por entrada nova.
Qual das duas, os arquivos não dizem.

**O núcleo comum das quatro fotos: 6.140 matrículas.** A cobertura é muito
desigual, e é isso que torna o núcleo a única base de comparação segura:

| Foto | núcleo / total | cobertura |
|---|---|---:|
| F1 | 6.140 / 13.973 | 43,9% |
| F2 | 6.140 / 11.951 | 51,4% |
| F3 | 6.140 / 10.762 | 57,1% |
| F4 | 6.140 / 6.279 | **97,8%** |

Dentro do núcleo a série é comparável, porque a presença nas quatro remove a
dúvida de escopo — soma de `Saldo Atualizado`: F1 R$ 7.984.986,23 · F2
R$ 7.972.788,29 · F3 R$ 7.971.268,70 · F4 R$ 8.108.910,32.

### 1c. O que vale e o que não vale, enquanto o escopo não for confirmado

**Pode ser usado:**

- qualquer medida **dentro** de uma única foto — total, distribuição, saldo por
  unidade;
- **presença**: uma matrícula aparecer numa foto prova que estava naquela
  extração;
- comparação restrita à **interseção** de duas fotos, ou ao **núcleo** das
  quatro.

**NÃO pode ser usado — e isto não é mais dúvida, é medição:**

> **Ausência entre duas fotos NÃO pode ser interpretada como regularização**
> enquanto o escopo de extração não for confirmado.

As relações de conjunto acima mostram entrada e saída **nos dois sentidos em
todos os seis pares**, e F4 traz Escola, Curso e Processo que F3 não tem. Uma
coorte que apenas encolhe por regularização não produz esse padrão. Ler
"sumiu da foto" como "pagou" ou "regularizou" atribuiria à cobrança um efeito
que o dado não sustenta.

## 2. O que a série diz — se o escopo for o mesmo

Os números abaixo valem **sob a hipótese** do item 1. Se um dos relatórios tiver
sido extraído com parâmetro diferente, eles mudam.

Movimento entre fotos consecutivas, por identidade do título
(`matrícula + Dt Vcto + Vcto Origem`), sem filtro de origem:

| Intervalo | Saíram | Entraram |
|---|---:|---:|
| F1 → F2 | 2.126 | 101 |
| F2 → F3 | 1.190 | 1 |
| F3 → F4 | 4.536 | 52 |

Consolidado F1 → F4, **comparando título a título** (não subtraindo totais):
**7.837 saíram**, 6.140 continuam, 154 entraram ao longo da série.

Com o recorte de origem aplicado — só títulos com `Vcto Origem` dentro de
outubro/2026, que é a regra que o importador já aplica —, os números passam a
**7.828 que saíram** e **151 entradas na série**.

## 3. A palavra continua sendo "saiu da base"

Nenhum desses 7.828 tem pagamento confirmado nesta fonte. O relatório de
inadimplência não diz por que alguém sumiu: pode ser pagamento, cancelamento,
bolsa, renegociação ou mudança do recorte na origem. Enquanto a conferência com
o Prime não existir para esses títulos, o módulo diz **saiu da base**, e nunca
"pago" ou "recuperado".

## 4. O que ainda falta — duas etapas SEPARADAS

As duas não dependem uma da outra, e nenhuma delas destrava a outra.

### Etapa A — importar as quatro fotos

**Revisto em 08/10/2026, depois da medição do item 1b.** A Etapa A era descrita
como um bloco único que dependia da confirmação de escopo. Ela se divide em
duas, e **só a segunda está bloqueada**:

**A1 — importação como fotos independentes: TECNICAMENTE POSSÍVEL, PENDENTE DE
AUTORIZAÇÃO DA GESTÃO.**

O que a medição prova: **cada foto pode ser armazenada e analisada
individualmente**, sem a confirmação de escopo. Cada uma é um retrato
autossuficiente do que estava em aberto naquela extração, e tudo que se mede
**dentro** dela — total, saldo, distribuição por unidade, situação acadêmica —
vale por si. A identidade de cada arquivo está provada por md5, e o importador
recusa e contabiliza linha inválida e duplicada por conta própria.

O que a medição **não** faz: **viabilidade técnica não é autorização.** Nada
aqui libera escrita em produção. Importar uma foto grava em `prev_lote`,
`prev_titulo`, `prev_titulo_lote` e `prev_carteira`, e essa é decisão de
gestão, não conclusão de análise.

**F1, F2 e F4 só serão importadas após autorização explícita da gestão** — por
foto, não em bloco, e com o registro de quem autorizou.

**A2 — interpretação de "saiu da base": BLOQUEADA ATÉ A CONFIRMAÇÃO DO
ESCOPO.** A confirmação continua
obrigatória para ler a **diferença entre fotos** como movimento da carteira. É
a conclusão do item 1c: ausência entre fotos não é regularização enquanto o
escopo não for confirmado, e os números do item 2 abaixo seguem valendo apenas
**sob a hipótese** de escopo igual. Fora do núcleo de 6.140 matrículas, nenhuma
afirmação de "saiu" se sustenta hoje.

Nenhuma ação precisa ser conhecida para a A1: a evolução da carteira entre
remessas não depende de quem foi acionado.

As fotos sem hora comprovada entram com precisão `DATA` e a **ordem no dia**
declarada por quem importa — F2 é a 1ª de 05/10 e F3 é a 2ª.

### Etapa B — registrar as três ações externas

**Depende de duas coisas, e só delas:**

1. **Contexto de cada ação.** A ação já registrada ("Mensalidade de outubro",
   05/10) é `BOLETO_VENCIDO`. As outras duas precisam da definição da gestão.
2. **Público de cada ação.** Para cada envio: cobriu a remessa inteira ou uma
   lista? Sem isso, o resultado seria medido sobre gente que não recebeu.

A **hora dos envios** não bloqueia o registro: onde ela não for comprovada, a
ação é registrada com precisão `DATA`. A consequência é conhecida — o
resultado contra uma foto do **mesmo dia** fica pendente, e a foto seguinte
resolve.

Se a Etapa A for feita e a B não, a carteira já tem histórico e gráficos; o
que falta é a atribuição de resultado por ação. O caminho inverso não existe:
sem as fotos não há contra o que medir ação nenhuma.
