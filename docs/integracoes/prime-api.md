# Manual da API Prime/ULBRA

Referência oficial da integração do ReATIVA One com a API da Prime (ULBRA).
Este documento existe para que ninguém precise abrir o F12, procurar uma
requisição ou redescobrir um endpoint que a sessão de alguém já mapeou.

**Antes de criar regra, fallback ou inferência nova envolvendo dado da Prime:**
consultar este manual e o [catálogo machine-readable](prime-api-catalog.json).
Se a informação não estiver aqui, ela é GAP — ver
[prime-gaps.md](prime-gaps.md) — e não se infere em cima de ausência.

Índice geral em [README.md](README.md).

---

## Visão geral

- **Base:** `https://prime-api.ulbra.ai/api`
- **Servidor:** Kestrel (ASP.NET Core) — sem Swagger/OpenAPI acessível em produção
  (`/swagger`, `/openapi.json`, `/docs`, `/health` respondem 404)
- **Autenticação:** header `X-API-Key`, chave única para toda a integração
- **Versionamento:** nenhum observado (`/v1/*` responde 404; não há header de
  versão na resposta)
- **Rate limit:** nenhum limite documentado pela ULBRA. A Edge Function
  `prime-diagnostico` lê `x-ratelimit-remaining` e `retry-after` a cada chamada
  por precaução, mas nunca viu esses headers preenchidos
- **Paginação:** `take`/`skip`, resposta `{ items: [...], totalItems: N }`.
  `take` sem valor pagina em 50 por padrão
- **Somente leitura:** todas as rotas testadas respondem apenas a GET; o
  servidor não expõe escrita. Confirmado adicionalmente pelo header `allow: GET`

---

## `carriers` — Lista de portadores

**Endpoint:** `GET /carriers?take=N`

**Fonte:** Prime/ULBRA

**Finalidade:** lista os portadores (carteiras/convênios) que a Prime conhece.
É o vocabulário que decide o que é carteira da Reativa e o que não é.

**Identificadores necessários:** nenhum.

**Parâmetros:**

| Nome | Tipo | Obrigatório | Comportamento comprovado |
|---|---|---|---|
| `take` | int | não | limite de itens; usado sempre alto (200–500) numa chamada só, sem paginar |

**Retorno:**

| Campo | O que significa |
|---|---|
| `id` | o identificador que importa — o nome varia entre chamadas |
| `name` | nome do portador |
| `covenant` | convênio, com zero à esquerda (`"0272047"`); `null` em alguns (195) |
| `isCollectionAgency` | `true` nas agências de cobrança terceirizada (195, 202); `false` nos convênios bancários (95, 160, 166) |

**Exemplo sanitizado:**

```json
{
  "items": [
    { "id": 166, "name": "SANTANDER REATIVA", "covenant": "0272047", "isCollectionAgency": false },
    { "id": 195, "name": "REATIVA RECUPERACAO DE CREDITO", "covenant": null, "isCollectionAgency": true }
  ],
  "totalItems": 124
}
```

**Fonte de verdade para:** existência e nome de um portador; se um portador é
convênio bancário (boleto emitido pelo banco) ou agência de cobrança.

**Limitações conhecidas:** 124 portadores ao todo; só 166 (acordos, "Santander
ReATIVA convênio 0272047") e 195 (mensalidades, "Reativa Recuperação de
Crédito") são carteira da Reativa, por decisão da gestão. 165 e 202 são
judiciais e ficam fora de escopo por decisão, não por limitação técnica.

**Segurança:** READ ONLY

**Pode automatizar?** SIM

**Fallback:** nenhum necessário.

**Não inferir:** o `name` de um portador pode variar de forma cosmética entre
consultas — nunca decidir escopo pelo nome, sempre pelo `id`.

---

## `students_search` — Busca de alunos

**Endpoint:** `GET /students?search={cpf ou nome}&carrierId=N&take=N&skip=N`

**Fonte:** Prime/ULBRA

**Finalidade:** resolve CPF ou nome em `registration` (a matrícula que a Prime
usa internamente) e confirma filiação a um portador.

**Identificadores necessários:** CPF **formatado** (`052.961.800-11`) OU nome
em texto livre.

**Parâmetros:**

| Nome | Tipo | Obrigatório | Comportamento comprovado |
|---|---|---|---|
| `search` | string | não | **substring**, não exato. CPF sem pontuação devolve `totalItems: 0` **sem erro** — falha silenciosa, não falha visível |
| `carrierId` | int | não | filtra por portador; discrimina de verdade (testado com portadores sem relação — devolve zero) |
| `take` | int | não | página; padrão observado 50 |
| `skip` | int | não | offset |

**Retorno:** `items[]` com `registration`, `name`, `cpf`, `course`, `campus`,
`shift`, `status`; `totalItems`.

**Exemplo sanitizado:**

```json
{
  "items": [
    { "registration": "2025001213", "name": "Fulana de Tal", "cpf": "02881891160",
      "course": "Administração", "campus": "Sede", "shift": "Noite", "status": "ATIVO" }
  ],
  "totalItems": 1
}
```

**Fonte de verdade para:** resolver CPF/nome em `registration`; confirmar se
uma pessoa está num portador específico.

**Limitações conhecidas:**
- `search` é substring: **sempre conferir o CPF exato** da linha retornada
  antes de aceitar — pedir `046.176.770-89` pode trazer linhas de outra pessoa
  cujo CPF contenha o trecho;
- CPF **só é encontrado formatado**. Em dígitos puros, `totalItems: 0` sem
  nenhum sinal de erro — quem não souber disso conclui "não está na Prime"
  quando na verdade é "busquei errado";
- a **matrícula do CRM não é necessariamente a `registration` do Prime**
  (medido: aluno com matrícula 180 no CRM é `2025001442` na Prime). A matrícula
  do **arquivo Santander**, por outro lado, bateu 13 de 13 com `registration`
  nos casos conferidos — são fontes diferentes que não podem ser tratadas como
  sinônimas sem checar qual matrícula está em mãos.

**Segurança:** READ ONLY

**Pode automatizar?** CONDICIONAL — automatizar a resolução de identidade sim;
usar o **nome** como prova de vínculo financeiro, não. Nome nunca decide
vínculo (ver [prime-mapa-identificadores.md](prime-mapa-identificadores.md)).

**Fallback:** nenhum — é a única forma de resolver identidade por CPF/nome
nesta API.

**Não inferir:** `items.length > 0` não é prova de que a pessoa é a titular —
só filtrando por CPF exato é que a evidência vale.

---

## `student_composite` — Detalhe completo do aluno

**Endpoint:** `GET /students/{registration}`

**Fonte:** Prime/ULBRA

**Finalidade:** devolve, num objeto só e **sem paginar**, cadastro, contratos,
extrato financeiro inteiro e (nominalmente) acordos. É o endpoint preferido
sempre que se já tem a `registration` — evita a armadilha da paginação padrão
de 50 no extrato.

**Identificadores necessários:** `registration` (resolvida via
`students_search`, ou já conhecida por outra fonte, como o arquivo Santander).

**Parâmetros:** nenhum.

**Retorno:**

| Bloco | Conteúdo |
|---|---|
| `registrationData` | `cpf`, `fullName`, `socialName`, `originalName`, `rg`, `phones[]`, `address`, `email`, `institutionalEmail` |
| `contracts[]` | `validFrom`, `validTo`, `status`, `type`, `course`, `establishment`, `shift`, `referenceSemester` (período do curso, **não** semestre-calendário), `cancelledAt`, `number` (vazio para acordo) |
| `financialStatement[]` | mesmos 13 campos do endpoint `financial_statement`, ver abaixo — aqui vem inteiro, sem paginar |
| `agreements[]` | **sempre vazio** em todos os testes realizados até hoje |

**Exemplo sanitizado:** ver os endpoints `financial_statement` e `agreements`
abaixo — os blocos são idênticos, só que compostos num objeto.

**Fonte de verdade para:** cadastro (telefone, endereço, e-mail, nome social);
contratos acadêmicos vigentes; extrato financeiro completo de um aluno.

**Limitações conhecidas:** ver limitações de `financial_statement` e
`agreements` — valem aqui integralmente. `socialName` deve prevalecer sobre
`fullName` quando presente (é como o operador chama a pessoa ao telefone).

**Segurança:** READ ONLY

**Pode automatizar?** SIM para cadastro e extrato; **NÃO** para acordo (o
campo vem sempre vazio — ver `agreements` abaixo).

**Fallback:** nenhum melhor para cadastro/extrato. Para acordo, ver
`docs/PREMISSAS.md` Premissas 19 e 20.

**Não inferir:** `agreements: []` aqui **não** significa que o aluno não tem
acordo — foi medido vazio inclusive para acordos confirmados como ATIVOS na
tela do Prime no mesmo instante da chamada.

---

## `student_contracts` — Contratos acadêmicos (isolado)

**Endpoint:** `GET /students/{registration}/contracts`

**Fonte:** Prime/ULBRA · **Finalidade:** mesmo conteúdo do bloco `contracts`
do composto, isolado.

**Retorno:** igual ao bloco `contracts[]` acima.

**Fonte de verdade para:** contratos acadêmicos, quando não se quer o
composto inteiro.

**Limitações conhecidas:** `number` (número de contrato) vem vazio — não serve
para vincular acordo a contrato.

**Segurança:** READ ONLY · **Pode automatizar?** SIM · **Fallback:**
`student_composite` traz o mesmo bloco.

---

## `financial_statement` — Extrato financeiro

**Endpoint:** `GET /students/{registration}/financial-statement?take=N`

**Fonte:** Prime/ULBRA

**Finalidade:** todo título (mensalidade ou parcela) que passou por qualquer
portador do aluno, com o valor decomposto em principal, desconto, multa,
juros e honorário.

**Identificadores necessários:** `registration`.

**Parâmetros:**

| Nome | Tipo | Obrigatório | Comportamento comprovado |
|---|---|---|---|
| `take` | int | não | padrão 50 — para o extrato inteiro sem paginar, preferir `student_composite` |
| `carrierId` | int | não | **IGNORADO neste endpoint** — resposta idêntica com ou sem ele (medido) |

**Retorno (13 campos):**

| Campo | Tipo | Significado |
|---|---|---|
| `boleto` | string, 7 díg. | **é** `acordos_titulos.documento` no CRM — ponte medida e confiável, só para portador 195 |
| `documentNumber` | string, 13 díg. | documento interno ULBRA. Mensalidade: base(9) = `010`+contrato, sequência(4) = parcela fracionária (ex. terminado em `990` = parcela 9,9). Acordo: `0`+`5`+acordo(6)+parcela(4) |
| `carrier` | `{id, name}` | o portador **do título**, não do aluno — decide se ainda está em cobrança |
| `dueDate` | date | vencimento |
| `paymentDate` | date | presente em ~100% das linhas do portador 195, **inclusive títulos que o CRM mantém ABERTO** — não é prova de pagamento isolada |
| `grossAmount` | decimal | o principal (mensalidade original) |
| `discountAmount` | decimal | desconto |
| `penaltyAmount` | decimal | multa — observado `0` em todas as linhas de acordo testadas |
| `interestAmount` | decimal\|null | juros — observado `null` em todas as linhas de acordo testadas |
| `honorariumAmount` | decimal | honorário |
| `netAmount` | decimal | soma dos anteriores |
| `paidAmount` | decimal | **dívida corrigida** na data da consulta — NÃO é caixa; pode superar o valor pago real |
| `isAgreementInstallment` | boolean | existe no schema; medido `false` em 388.446 linhas / 17.211 alunos (09/09) e reconfirmado em 1.327 linhas / 53 alunos (15/09) — **nunca observado `true`** |

**Exemplo sanitizado:**

```json
{
  "items": [
    {
      "boleto": "4039712", "documentNumber": "0104270450100",
      "carrier": { "id": 195, "name": "REATIVA RECUPERACAO DE CREDITO" },
      "dueDate": "2026-01-05", "paymentDate": "2026-09-14",
      "grossAmount": 550.00, "discountAmount": 0, "penaltyAmount": 0,
      "interestAmount": null, "honorariumAmount": 45.00, "netAmount": 595.00,
      "paidAmount": 1110.12, "isAgreementInstallment": false
    }
  ],
  "totalItems": 29
}
```

**Fonte de verdade para:** mensalidade liquidada, sob a regra de entrada em
produção (vencimento+30, diferente do dia da importação, portador 195 —
ver `regra-entrada-prime-liquidado-nao-e-pagamento` e `docs/PREMISSAS.md`);
decomposição de valor; ponte `boleto` (7 díg.) ↔ `acordos_titulos.documento`.

**Limitações conhecidas:**
- `paymentDate` sozinho **não** distingue negociado de aberto — regra testada
  e formalmente invalidada em 2026-09-01 (100% das linhas do portador 195 têm
  `paymentDate`, inclusive as ABERTAS no CRM);
- `isAgreementInstallment` nunca vem `true` — não serve para achar parcela de
  acordo;
- carrier 166 (convênio de acordo) **nunca** aparece numa linha de extrato,
  mesmo para acordo ATIVO com parcela em aberto já conhecida por outra via
  (medido em 67 alunos / 1.625 linhas);
- `carrierId` como filtro deste endpoint é ignorado silenciosamente — pedir
  só o 195 ou só o 166 não reduz a resposta.

**Segurança:** FINANCEIRO (leitura)

**Pode automatizar?** CONDICIONAL — só dentro da regra de entrada em produção,
com corte de data e travas de corroboração (ver `docs/PREMISSAS.md`).
`paidAmount` nunca automatiza nada: não é caixa.

**Fallback:** nenhum equivalente para o que este endpoint não cobre (acordo).

**Não inferir:** presença de `paymentDate` = pagamento. Mesma paymentDate em
duas linhas = mesmo acordo (regra testada e invalidada).

---

## `agreements` — Acordos do aluno

**Endpoint:** `GET /students/{registration}/agreements`

**Fonte:** Prime/ULBRA

**Finalidade nominal:** os acordos (negociações) do aluno — quantidade de
parcelas, valor negociado, situação.

**Identificadores necessários:** `registration`.

**Parâmetros testados, todos IGNORADOS** (resposta idêntica byte a byte com ou
sem eles): `carrierId`, `includeSettled`, `status`, `onlyAgreements`,
`includeAgreements`, `includeInactive`, `agreementId`.

**Retorno:** `{ items: [], totalItems: 0 }` — **em todos os testes
realizados**, sem exceção.

**Fonte de verdade para:** nada, hoje — não há dado retornado.

**Limitações conhecidas — a mais importante deste documento:**

`200` com `totalItems: 0` é uma resposta **válida** da API, não um erro. E foi
medida **inclusive para um acordo confirmado como ATIVO na tela do Prime no
mesmo instante em que a chamada foi feita** (15/09/2026, acordo 71903). Isso
prova que é um limite de **escopo** da superfície pública testada, não
ausência do dado em algum lugar da ULBRA — a estrutura existe e é visível na
interface web do Prime; a rota/URL estruturada que essa interface consome
**ainda não foi identificada**. Ver `docs/PREMISSAS.md`, Premissas 19 e 20,
para a evidência completa (inclusive o teste de consistência
`Σ(paidAmount − grossAmount) == Σ(valor_pago) − Σ(honorário)`, que fecha ao
centavo em 8 de 16 acordos testados e é auto-verificável — quando não fecha, a
reconstrução é NÃO COMPROVADA e não deve ser gravada).

**Segurança:** READ ONLY (quando responde) — mas não há efeito a classificar,
pois nunca devolve dado.

**Pode automatizar?** NÃO — não há dado.

**Fallback:** **NENHUM ENCONTRADO PELA API.** A tela do Prime mostra a cadeia
completa (títulos originais → composição → acordo → parcelas novas), mas essa
tela não é uma superfície de integração — é a UI de um humano. Enquanto a
rota que a alimenta não for identificada (via F12 → Rede, na sessão de alguém
com acesso à tela de detalhe do acordo), a única fonte parcial é
`pagamentos.titulo_numero`, que **já contém o número do acordo** vindo do
arquivo Santander, e o teste de consistência acima, que serve para
**verificar** uma hipótese, nunca para **reconstruir** sem prova.

**Não inferir:**
- **nunca escrever "a informação não existe"** — extrapola o medido. Escrever
  sempre: "não foi exposta pela superfície de integração testada com a
  X-API-Key atual";
- ausência no `/agreements` não autoriza concluir que o acordo foi quitado,
  quebrado ou cancelado;
- não reconstruir estrutura de acordo por proximidade de data/valor sem o
  teste de consistência fechando ao centavo — e mesmo fechando, é teste, não
  regra universal (ver Premissa 20).

---

## Erros e comportamento de rede

| Situação | Como a API responde | Como tratar |
|---|---|---|
| Chave inválida | `401` | não insiste — reportar e parar |
| Rota inexistente ou método errado | `404` uniforme (nunca `405` observado) | 404 não distingue "rota não existe" de "rota existe mas não aceita esta forma de GET" |
| Indisponibilidade temporária | `503 "Prime database unavailable"` | backoff exponencial (as Edge Functions usam 3–4 tentativas, 900ms–2,6s) |
| Timeout de rede | exceção no fetch | mesmo backoff do 503 |
| Payload inesperado | `200` com forma diferente da documentada aqui | **nunca tratar como "vazio"** — é ERRO, e deve interromper o fluxo em vez de assumir ausência (ver como `prime-portador` trata isso) |

## Observabilidade

O que já existe, medido no código em produção (nenhuma tabela nova criada
por este mapeamento):

| Onde | O que registra |
|---|---|
| `prime_cadastro_execucoes` | início/fim, `alvos`/`encontrados`/`erros`, motivo do erro por categoria (não por CPF individual), amostra de até 3 mensagens |
| `prime_extrato_fila.tentativas` / `.ultimo_erro` | contagem de tentativa e último erro por matrícula, sem payload |
| resposta de cada Edge Function | contagem por resultado (`coletados`, `erros`, `parou_no_tempo`, `segundos`) — nunca o corpo cru da chamada à Prime, exceto em `prime-sonda` com `cru:true`, que é modo de conferência manual, não rotina |

**O que nunca é registrado, em nenhuma das funções auditadas:** a
`X-API-Key`, JWT completo, senha, qualquer secret, ou dado pessoal além do
mínimo necessário para o diagnóstico (CPF aparece em log só quando o próprio
erro é sobre aquele CPF, nunca em lote).

**Recomendação, não implementada nesta etapa** (evitar criar rotina nova em
produção sem aprovação — ver `docs/BACKLOG-TECNICO.md`): padronizar um
registro único por chamada à Prime, com `recurso` (nome do endpoint do
catálogo), `sucesso/falha`, `status_http`, `duracao_ms`, `quantidade_itens`,
`timestamp` e `versao_forma` (hash da FORMA da resposta, não do conteúdo) —
isso permitiria detectar drift de contrato antes que ele quebre uma
automação, sem esperar pelo teste de contrato (`src/utils/primeApiContrato.test.js`)
rodar contra uma fixture desatualizada.

## Como confirmar um endpoint novo, com segurança

A Edge Function `prime-sonda` (produção, versionada em
`supabase/functions/prime-sonda/`) existe exatamente para isto: recebe um
`caminho` arbitrário, faz um único GET com a chave do Vault, e devolve a
**forma** da resposta (nomes de campo e tipos, não o conteúdo) — só devolve o
conteúdo cru se `cru: true` for pedido explicitamente, para conferir um caso
concreto. Nunca grava nada. Usar essa função — não reinventar sondagem, e
nunca colar a chave em um script ad-hoc.

## Manutenção deste documento

Toda descoberta nova sobre a API deve atualizar, no mesmo commit:
[`prime-api.md`](prime-api.md) (este arquivo) + [`prime-api-catalog.json`](prime-api-catalog.json)
+ [`prime-mapa-fontes-verdade.md`](prime-mapa-fontes-verdade.md). Ver
[README.md](README.md) para o processo completo.
