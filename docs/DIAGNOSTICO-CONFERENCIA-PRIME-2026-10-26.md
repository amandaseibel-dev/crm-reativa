# Diagnóstico — fila da Conferência Prime

**Data:** 2026-10-26 · **Escopo:** SOMENTE LEITURA em produção
(`ahattpqrjmhkzsmnbdzs`) · **Nada foi alterado:** nenhuma exclusão, baixa,
migration, merge ou escrita.

Fonte oficial consultada antes de tudo, conforme `CLAUDE.md`:
[`docs/integracoes/README.md`](integracoes/README.md).

> **A fila está sendo trabalhada agora.** Entre o início e o fim desta
> investigação ela caiu de 514 para 507 linhas, porque `cobranca07@aelbra.com.br`
> decidiu 26 casos nesta tarde. Os totais e as composições das seções 1 e 5 vêm
> de **um único retrato, de 2026-10-26 16:37:20Z**, e fecham entre si
> (27+241+239 = 507; os valores somam R$ 375.126,86 exatos).
>
> As medições cruzadas da seção 3 foram lidas entre 16:35Z e 16:40Z e por isso
> diferem em 1 ou 2 linhas do retrato — é a fila drenando durante a leitura, não
> divergência de critério. Cada número está anotado como foi medido.

---

## 1. Quantos registros estão na fila ativa

| | |
|---|---|
| Linhas (títulos) | **507** |
| Alunos distintos | **306** |
| Valor | **R$ 375.126,86** |

A fila é `prime_conferencia_decisao` com `decisao = 'PENDENTE'`, exposta pela
função `prime_conferencia_fila()`. A unidade é o **título**, não o aluno.

Composição do mesmo retrato:

| Subgrupo | Linhas | Valor | Entrada |
|---|---:|---:|---|
| `A1` | 241 | R$ 156.339,54 | `LIQUIDACAO_PRIME_CORROBORADA`, toda em 18/09 |
| `C_SEM_PROVA` | 239 | R$ 201.025,65 | `PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA`, 19/09 a 08/10 |
| *(nulo)* | 27 | R$ 17.761,67 | `PRIME_LIQUIDADO_ORIGEM_NAO_COMPROVADA`, toda em 18/09 |

**Idade:** mediana de **38 dias**, máximo de 38 dias. 268 das 507 linhas entraram
num único dia (18/09) e nunca saíram.

---

## 2. Quantos alunos aparecem repetidos, e por qual motivo

**Não há duplicidade de identidade na fila.** Medido:

- `titulo_id` é **chave primária** da tabela — é impossível haver duas linhas
  para o mesmo título;
- **1 CPF = 1 `aluno_id`** (zero CPF com dois cadastros, zero `aluno_id` nulo,
  zero CPF nulo);
- **zero boletos repetidos**: uma linha por `documento`.

Estas três propriedades foram medidas duas vezes, com a fila em tamanhos
diferentes, e se mantiveram exatas: às 16:33Z, 513 linhas = 513 boletos
= 309 CPFs = 309 `aluno_id`; às 16:40Z, **503 = 503 = 304 = 304**.

A repetição é **um aluno com vários boletos**, que é o desenho da fila
(leitura de 16:35:36Z, quando a fila tinha 508 linhas e 307 alunos):

| Títulos por aluno | Alunos | Linhas |
|---:|---:|---:|
| 1 | 203 | 203 |
| 2 a 8 | **104** | **305** |

São **104 alunos** respondendo por 305 linhas — **201 linhas excedentes** acima
de uma por pessoa. O maior caso é um aluno com **8 boletos** na fila.

**Importante:** a tela já agrupa **1 card por aluno** (`src/pages/ConferenciaPrime.jsx`,
`const grupos`). Então são 306 cards, não 507. A repetição que se vê é **dentro
do card** — e, principalmente, no painel, que anuncia "Em confirmação: 507"
enquanto a lista mostra 306 cards. Os dois números estão certos e contam coisas
diferentes.

### A duplicidade real: 9 alunos com duas fichas de caso

Fora da fila, na base: **9 dos 306 alunos têm duas linhas em `casos`**, e as duas
se contradizem. O padrão é idêntico nos 9:

| Ficha | Criada | `caso_codigo` | `status_atual` | `encerrado_operacional` |
|---|---|---|---|---|
| 1ª | 2026-06-29 | preenchido | "Sem contato" / "Mensagem enviada" | **true** |
| 2ª | 2026-07-15 | **nulo** | "Em cobrança" | **false** |

`saldo_total` é igual nas duas. A carga de 15/07 criou uma segunda ficha sem
código, e hoje uma diz que o caso está encerrado e a outra que está em cobrança.
Não há restrição de unicidade em `casos(aluno_id)`.

---

## 3. Quantos registros já foram regularizados, com evidência verificável

**Pela prova que o próprio sistema exige, zero.** Medido nas 507 linhas:

| Prova de máquina | Linhas |
|---|---:|
| Pagamento nosso casando com o boleto (`pagamentos.titulo_numero`) | **0** |
| Composição de acordo na evidência (`acordo_composicao`) | **0** |
| Vínculo ativo a acordo (`vinculo_ativo`) | **0** |
| Subgrupo comprovado (`A_PAGAMENTO_COMPROVADO` / `B_ACORDO_COMPROVADO`) | **0** |
| `acordo_id` preenchido na decisão | **0** |
| `origem_liquidacao` no título | **0** |

E o estado do título é coerente com a fila, sem nenhum resíduo:

- `em_confirmacao` ⟺ `PENDENTE` **exatamente**: 507 de um lado, 507 do outro;
- **zero** títulos decididos que ficaram parados em `em_confirmacao`;
- **zero** títulos em `em_confirmacao` sem linha de decisão.

Ou seja: **a fila não está largando pendência resolvida por falha de status.**
Esse mecanismo funciona.

O que existe é outra coisa, e é grande — **o aluno já não deve mais nada**
(leitura de 16:36Z, soma 509 linhas, duas acima do retrato):

| Situação do aluno | Linhas | Alunos | Valor |
|---|---:|---:|---:|
| Caso ativo, mas **nada mais em aberto** | 292 | 171 | R$ 218.209,48 |
| Caso ativo com outra dívida | 146 | 94 | R$ 109.840,24 |
| **Caso já encerrado** e sem outro saldo | 55 | 33 | R$ 38.992,15 |
| **Caso já encerrado**, mas tem saldo | 16 | 10 | R$ 15.965,53 |

**346 linhas (203 alunos) pertencem a alunos sem nenhum outro título em aberto**
— conferido direto em `acordos_titulos`, não apenas pelo `saldo_total`: desses
203 alunos, **zero** têm título com `situacao='ABERTO'` e status diferente de
`quitada`. A linha da fila é a única coisa que ainda os prende à base.

E **71 linhas (43 alunos) são de caso com `encerrado_operacional = true`** — o
caso foi administrativamente encerrado e a fila continua pedindo decisão.
12 linhas são de aluno marcado `nao_acionar`.

**Ressalva honesta:** "sem outro saldo" não prova que o boleto foi regularizado.
Esses títulos estão fora do saldo justamente porque estão em `em_confirmacao`.
O que o número prova é mais estreito, e é o que importa para operar: **não há
mais nada a cobrar dessas pessoas além desta decisão pendente.**

---

## 4. Quais regras ou processos deixam pendências resolvidas na fila

### Causa 1 — a porta de saída automática é logicamente inalcançável

`prime_liquidacao_reavaliar_pendentes()` roda **de hora em hora** (cron 55,
`prime_conferencia_triagem_hora`, 168 execuções em 7 dias, 168 `succeeded`).
Ela tem **uma só** saída automática, o ramo (a):

```
if (v_ev ? 'prime') and v_liq is null then   -- "a Prime reverteu a liquidação"
```

Esse ramo **nunca pode ser verdadeiro**, pelos dois lados:

- **se o espelho tem a linha:** `prime_extrato` tem **417.072 linhas e 0 com
  `liquidado_em` nulo**, logo `v_liq` nunca é nulo. *(Correção do mesmo dia: o
  motivo **não** é que o espelho filtre linha liquidada — ele não filtra nada.
  É que a API nunca devolve `paymentDate` nulo. Ver o adendo H1 no fim deste
  documento.)*
- **se o espelho não tem a linha:** `prime_liquidacao_evidencias()` monta a chave
  `prime` como `case when liquidado_em is null and portador is null then null`, e
  o retorno passa por `jsonb_strip_nulls` — a chave desaparece, e `v_ev ? 'prime'`
  é falso.

**Prova de que nunca abriu:** `PRIME_REVERTEU_LIQUIDACAO` **não existe em
nenhuma linha** de `prime_liquidacao_classificacao`, e das **768** decisões já
tomadas, **zero** têm `decidido_por = 'prime_liquidacao@rotina'` — há só 3
autores, todos humanos: `amanda.seibel`, `cobranca07` e o backfill rotulado de
08/10. A rotina
roda, classifica (1.161 `PRIME_ORIGEM_NAO_COMPROVADA`, 115 `ACORDO_COMPROVADO`)
e **nunca tirou uma linha da fila**.

### Causa 2 — quando a prova aparece, a fila só anota; não libera

Os ramos (b) e (c) da mesma função, ao descobrir que surgiu acordo ou pagamento,
fazem `update ... set subgrupo = 'B_ACORDO_COMPROVADO'` e **mantêm
`decisao = 'PENDENTE'`**. A evidência sobe de nível e a linha continua esperando
um humano — mesmo quando a mesma evidência, num título **novo**, seria tratada
como prova suficiente pela rota B de `prime_liquidacao_classificar_novas`.

Hoje isso ainda não produziu efeito visível (0 linhas em subgrupo comprovado),
porque a evidência não apareceu para ninguém da coorte. Mas a regra está lá: a
fila não tem porta para "regularizou".

### Causa 3 — a fila é um estoque fechado desde 09/10

O comentário em `prime_liquidacao_classificar_novas` registra a mudança:

> `09/10/2026: C_SEM_PROVA NAO SUSPENDE MAIS.`

Desde então, liquidação sem prova **só é registrada**, e o título segue
`ABERTO`/`NEGOCIADO` na cobrança. Só as rotas A e B suspendem e enfileiram.
Consequência medida: **a última entrada na fila é de 08/10** — 18 dias atrás.
A fila de hoje é um **passivo legado** de antes da regra nova, 268 linhas dele
de um único dia (18/09), e **nada a drena além de decisão manual**.

Isso é um acerto de desenho, não um defeito: o estoque não cresce mais. O defeito
é que **ninguém decidiu o que fazer com o estoque que ficou.**

### Causa 4 — a decisão é por boleto, a causa é por pessoa

A triagem classifica 222 linhas como `INSTITUCIONAL_PROVAVEL` e 55 como
`FIES_ISENCAO_PROVAVEL`. Essas causas são **do aluno e do semestre**, não do
boleto: quando um aluno tem 8 boletos liquidados pela mesma isenção, a fila exige
8 decisões idênticas. Os 104 alunos repetidos geram **201 decisões excedentes**.
A classificação humana, que seria o caminho para decidir por causa, está
praticamente sem uso: **2 linhas de 507** têm `classe_humana`.

---

## 5. Proposta de correção permanente

Ordem deliberada: primeiro **consertar a porta**, depois **drenar o estoque**.
Nenhum passo apaga histórico — `prime_conferencia_decisao` guarda a linha com
`decisao`, `motivo`, `decidido_por` e `decidido_em`, e cada saída registra em
`prime_liquidacao_classificacao` e `aluno_movimentacoes`.

### E1 — ~~corrigir o ramo morto da reversão~~ → **RETIRADA em 26/10/2026**

> ⚠️ **Esta proposta foi retirada no mesmo dia, pelo resultado da H1.** Ela
> dizia: *"trocar a condição inalcançável por uma que o espelho possa satisfazer:
> a linha **desaparecer** do extrato liquidado na coleta mais recente"*, com
> guarda de coleta posterior. E afirmava ser *"o único item que corrige uma perda
> de receita latente"*.
>
> **A medição derrubou as duas coisas.** Dos 1.009 boletos cuja linha envelheceu
> enquanto o aluno era recoletado, **991 (98,2%) são reemissão** — boleto novo,
> mesmo vencimento, mesmo principal. Uma regra por ausência devolveria à
> cobrança 991 dívidas já reemitidas sob outro número. E **zero** dos 1.009
> estão no portador 195, o da fila: a perda de receita que eu chamei de latente
> **não tem uma única instância observada**.

**No lugar dela:** remover ou neutralizar o ramo morto, documentando que
reversão não é observável — em vez de tentar fazê-lo funcionar. Código que não
pode executar é dívida técnica disfarçada de proteção, e enquanto parecer
proteção impede que a proteção real seja escrita.

**E o sinal que presta:** substituição, que é prova **positiva**. Boleto novo
com mesmo vencimento e mesmo `valor_bruto` afirma que a dívida continua viva, é
detectável hoje no espelho, sem dependência externa — e a ação se aplica ao
boleto **novo**, nunca reabrindo o antigo.

### E2 — ~~liberar automaticamente o que ganhou prova~~ → **NÃO AUTORIZADA**

> ⚠️ **Decisão da gestão, 26/10/2026: a liberação automática não está
> autorizada** — nem por `A_PAGAMENTO_COMPROVADO`, nem por `A2_COBRE`. A
> redação anterior propunha que a rotina aplicasse `CONFIRMADO`/`VINCULADO`
> onde a evidência atingisse prova de máquina, e afirmava que isso "não oculta
> pendência real". **O backtest não sustentou a afirmação.**

Das **62** linhas com prova de máquina que já foram decididas por um humano:
**58 concordaram** e **4 divergiram** (6,5%, R$ 2.405,00). A automação teria
tomado, nesses 4, a decisão oposta à humana — e na direção cara, tirando título
da cobrança.

Os 4 são **dois padrões**, e somá-los num percentual único confunde padrões de
prova diferentes:

| Padrão | Subgrupo | Casos | Divergentes | Taxa |
|---|---|---:|---:|---:|
| 1 | `A2_COBRE` — heurística de cobertura de **valor** | 57 | 3 | 5,3% |
| 2 | `A_PAGAMENTO_COMPROVADO` — padrão de prova **atual** | 5 | 1 | 20% |

**E a divergência não prova que a máquina errou.** Nem que o humano acertou: o
motivo humano é texto livre, plausível e não verificado, a classificação da
máquina é derivada de regra, e não há terceira fonte no registro. 6,5% é taxa
de **desacordo**, não de erro. Os 4 ficam formalmente **pendentes de validação
de evidência** — não contam a favor nem contra a automação até serem conferidos.

**Por que não autorizar, independente do percentual:** a direção do erro é a
silenciosa (tirar dívida viva da cobrança); a amostra do padrão atual é de 5
casos; e há **0 pendentes com prova de máquina hoje**, então o ganho seria zero
agora e o risco não.

**No lugar:** a prova de máquina segue como **sugestão forte na tela**, com a
evidência à vista, e a decisão segue expressa e humana. Detalhe e critérios de
reabertura do tema em
[`prime-gaps.md`](integracoes/prime-gaps.md#liberação-automática-por-prova-de-máquina-não-autorizada--2026-10-26).

### E3 — decidir o estoque por CAUSA, com aprovação da gestão, não por boleto

Não é automação: é dar à gestão uma decisão por **grupo de causa**, aplicada em
lote aos boletos daquele aluno. A ferramenta já existe e já é usada
(`prime_conferencia_rejeitar_lote`, e o botão "Soltar os N da confirmação").
O que falta é o recorte e o registro do fundamento.

Recortes prontos, do retrato de hoje:

| Grupo | Linhas | Valor | Decisão que a gestão precisa tomar |
|---|---:|---:|---|
| `INSTITUCIONAL_PROVAVEL` | 222 | R$ 201.347,49 | liquidação da instituição ⇒ encerrar administrativamente |
| `FIES_ISENCAO_PROVAVEL` | 55 | R$ 48.263,64 | isenção/FIES ⇒ encerrar administrativamente |
| `CANCELAMENTO_PROVAVEL` | 40 | R$ 18.918,76 | cancelamento/estorno ⇒ encerrar |
| `ACORDO_CANDIDATO` | 54 | R$ 34.144,35 | conferir acordo próximo e **vincular** |
| `PAGAMENTO_CANDIDATO` | 7 | R$ 4.215,30 | conferir pagamento e **confirmar** |
| `NAO_COMPROVADA` | 116 | R$ 67.991,69 | sem pista ⇒ **devolver à cobrança** (`REJEITADO`) |
| `RESIDUO` | 13 | R$ 245,63 | centavos ⇒ encerrar |

Regra de ouro para não ocultar pendência real: na dúvida, **`REJEITADO`** — o
título volta a `ABERTO` e volta a ser cobrável. O erro reversível é devolver à
cobrança; o erro caro é encerrar dívida viva.

### E4 — fechar as 9 fichas duplicadas e impedir novas

Consolidar as 9 duplicidades de `casos` mantendo a ficha **com `caso_codigo`**
(a de 29/06) e migrando o que a de 15/07 tiver de próprio, sem apagar: marcar a
segunda com o status de unificação que a tabela já prevê
(`chave_unificacao`, `unificacao_status`). Depois, restrição de unicidade em
`casos(aluno_id)` — hoje não existe.

### E5 — fazer a repetição aparecer como uma pendência só

Na tela, o painel deve dizer as duas coisas: **"507 boletos / 306 alunos"**. E a
decisão por card deve oferecer "aplicar a todos os N boletos deste aluno" quando
a causa é a mesma — o que transforma 507 decisões em 306, e as 201 excedentes em
zero, sem mudar nenhuma regra de prova.

---

## O que NÃO foi feito, por desenho

- Nenhuma escrita em produção: sem exclusão, baixa, migration, merge ou deploy.
- Nenhum ensaio da E2 executado.
- Nada commitado: este arquivo é a única alteração no disco.

## Pendência de documentação que este diagnóstico criou — RESOLVIDA

O achado da **Causa 1** é uma limitação nova da integração, não um defeito só
nosso: **a reversão de uma liquidação na Prime não é observável**. Pela regra
obrigatória do `CLAUDE.md`, foi registrada em `prime-gaps.md` + `prime-api.md` +
`prime-api-catalog.json` + `prime-mapa-fontes-verdade.md` +
`prime-mapa-identificadores.md` — os cinco, e depois corrigida nos cinco pelo
adendo abaixo.

---

# ADENDO — resultado da H1 (26/10/2026, mesma data)

A H1 perguntava se o `financial_statement` devolve o título cuja liquidação foi
revertida, com `paymentDate` nulo ou outro indicador explícito de reabertura.
**A sonda autorizada não foi executada** — o portão da `prime-sonda` exige, além
do JWT do gateway, o token de rotina (segredo de ambiente) ou sessão de gestão.
A H1 foi resolvida sem a API, porque o espelho é **cópia não filtrada** do
extrato.

## O erro que este adendo corrige

O corpo deste diagnóstico afirmava que `prime_extrato` "só persiste linha
liquidada". **Errado.** O ingestor
(`supabase/functions/prime-extrato/index.ts`) aceita **toda** linha de
`financialStatement` que tenha boleto — sem filtro de liquidação, portador ou
situação (linha 123) — e o helper `dia()` (linha 78) **preserva o nulo**:
`String(v ?? "")` vira `""`, que tem menos de 10 caracteres, e grava `null`.
**Se a API devolvesse `paymentDate` nulo, o espelho gravaria nulo.**

Os zero nulos são, portanto, **comportamento da API** — não efeito de filtro.

## Resultado

| | |
|---|---|
| **H1.a** — `paymentDate` nulo como sinal de reabertura | **REFUTADA** |
| **H1.b** — outro campo não mapeado que indique reabertura | **INCONCLUSIVA** |
| Caso de reversão conhecido e verificável | **não existe** |

**H1.a**, a evidência: `paymentDate` nulo = **0 em 417.072 linhas**, 9
portadores, 18.266 alunos, coleta de 24 a 26/10. Incluindo **19.315 títulos a
vencer no portador 95, todos com `paymentDate` preenchido** — e um título que
ainda não venceu não pode ter sido pago. Um sinal que não ocorre não indica
nada.

**H1.b** fica inconclusiva de propósito: o espelho só guarda os 13 campos que o
ingestor mapeia, então não dá para afirmar pelo banco que a API não devolva um
campo adicional. Fecha-se com uma chamada de `prime-sonda` (`cru:false`), que
precisa de sessão de gestão.

## As três coisas que não são a mesma

| Fenômeno | Medido em 26/10 | Ação |
|---|---:|---|
| **Boleto reemitido** (mesma dívida, número novo) | **991 de 1.009 (98,2%)** | agir sobre o boleto **novo** |
| **Ausência no espelho** (linha não voltou na recoleta) | 1.009 candidatos | **nada** — é sintoma |
| **Reversão comprovada** | **0** | não tem forma própria |

Dos 18 que sobram depois da reemissão: todos do portador 95, nenhum em
`acordos_titulos`. E **zero dos 1.009 estão no portador 195**, o da fila.

## O que isto muda na proposta

A **E1 foi retirada** (ver acima). A instrumentação de cobertura da coleta desce
de prioridade: continua pré-requisito de qualquer regra sobre ausência, mas
nenhuma regra sobre ausência deve ser escrita.

> **Nota do mesmo dia, posterior a este adendo:** este trecho dizia que a
> prioridade passava a ser a **E2** (liberação com prova positiva) e a **E3**. O
> backtest das 62 decisões derrubou a E2, que a gestão **não autorizou** — ver a
> E2 acima. **Resta a E3**, drenar o estoque por causa com decisão humana, onde
> estão as ~490 linhas paradas há 38 dias.

Nenhum CPF, nome ou dado pessoal foi registrado neste documento: todos os
números são agregados.
