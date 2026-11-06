# Solicitação técnica à TI ULBRA — escopo de ACORDOS na API Prime

**Versão:** 3 (06/11/2026) — acrescenta a evidência medida em 06/11 (§2.4) e
amplia o pedido (§3). A versão 2 (05/11) e o histórico são preservados: nada
foi apagado.
**De:** ReATIVA One (CRM de recuperação de crédito — AELBRA / Grupo SEB)
**Para:** TI ULBRA — equipe responsável pela API Prime (`prime-api.ulbra.ai`)
**Contato técnico:** amanda.seibel@aelbra.com.br

> **Para quem revisa antes de enviar:** o que mudou da versão 1 está em
> [§7](#7-o-que-mudou-da-versão-1). Dois números do rascunho estavam
> conflatados e foram corrigidos; um pedido foi acrescentado porque sem ele o
> acesso resolve metade do problema.

---

## 1. O pedido, em uma frase

A `X-API-Key` fornecida à Reativa chama `GET /students/{registration}/agreements`
com sucesso (HTTP 200), mas o corpo vem **sempre vazio**. Pedimos o escopo de
acordos nessa mesma chave — **incluindo a lista de parcelas** —, ou um endpoint
equivalente.

Não é erro do CRM: a chamada está correta, a mesma chave funciona nos demais
endpoints, e o dado existe na ULBRA (visível na interface do Prime).

---

## 2. Evidência

### 2.1 O teste que isola o problema

Acordo **71903**, aluno Kaleb Sales de Oliveira. Em **15/09/2026**, na tela do
Prime: *Confirmado, 10 parcelas, todas Quitadas*. **No mesmo instante**, a API:

```http
GET /students/{registration}/agreements
X-API-Key: «chave da Reativa»

200 OK
{ "items": [], "totalItems": 0 }
```

`200` com `totalItems: 0` é resposta **válida** — não é falha de rede nem erro
de autenticação. Para um acordo que existia e estava ativo, isso indica limite
de **escopo da chave**, não ausência do dado.

### 2.2 O que já tentamos, para não pedirmos o que já existe

| Tentativa | Resultado |
|---|---|
| 48 rotas candidatas de acordo (`/agreements`, `/agreements/{id}`, `/agreements/{n}/installments`, `/students/{reg}/agreements/{n}`, `/negotiations`, `/installments`, `/titles`, `/bills`…) | **todas 404.** Nenhuma 405 — não conseguimos distinguir "rota não existe" de "existe e não aceita GET nesta forma" |
| Parâmetros no endpoint que responde: `carrierId`, `includeSettled`, `status`, `onlyAgreements`, `includeAgreements`, `includeInactive`, `agreementId` | **todos ignorados** — resposta idêntica byte a byte com e sem eles |
| `/swagger`, `/swagger/index.html`, `/openapi.json`, `/docs`, `/health` | 404, inclusive sem autenticação |

**Se existe documentação da API, ela resolveria metade deste pedido.** Não
localizamos nenhuma.

### 2.3 Três sintomas da mesma causa

1. **`financial_statement` nunca retorna o portador 166** (SANTANDER REATIVA —
   convênio 272047), nem para aluno com acordo ativo. Medido em **três coletas
   independentes de ~800 mil linhas de título: portador 166 = 0 entradas.**
2. **`isAgreementInstallment` é sempre `false`** — em 388.446 linhas / 17.211
   alunos, e reconfirmado em 1.327 linhas / 53 alunos. Esse campo deveria
   marcar parcela de acordo.
3. **Nenhum dos 13 campos de `financialStatement` é situação, status ou saldo**
   (verificado ao vivo em 28/09/2026). `paymentDate` vem preenchido em 100% das
   linhas, inclusive em título a vencer — então não serve para dizer o que foi
   pago.

---

### 2.4 Reteste em 06/11/2026 — sete semanas depois, mesmo resultado

Executado pela gestão do ReATIVA One, pela interface do CRM, com a sessão de
gestão autenticada. Nenhum teste especulativo: a rota consultada é a mesma
documentada, pelo instrumento oficial de sondagem.

| Verificação | Resultado |
|---|---|
| `GET /students/{registration}/agreements` | **HTTP 200**, corpo com **lista vazia** |
| Acordos retornados | **0** |
| Lista de parcelas | **nenhuma** |
| Autenticação da sessão de gestão | **funcionou** |

**O que isso estabelece, e o que não estabelece:**

- **Não é falha de autenticação.** A sessão de gestão passou pelo portão do
  servidor. Onde houve erro de autorização em outra função, o código foi 500 de
  configuração interna — nunca 401 nem 403 na chamada à API.
- **Não é indisponibilidade.** A API respondeu 200. O endpoint existe, aceita a
  chave e devolve corpo válido.
- **É ausência de dados no escopo da chave.** Lista vazia é resposta válida, e é
  a mesma resposta de 15/09/2026.

**O caso que decide, e é anterior:** em 15/09/2026 o acordo **71903** estava
**Confirmado e ATIVO na tela do Prime, com 10 parcelas**, e a API devolveu
`{items: [], totalItems: 0}` **no mesmo instante da consulta**. Um aluno com
acordo comprovado, e a API devolvendo zero. É o que separa "este aluno não tem
acordo" de "a chave não alcança o escopo de acordos".

**Dois esclarecimentos que evitam leitura errada dos nossos próprios números:**

1. **O portador 166 não aparecer no extrato financeiro é o comportamento
   documentado da API, não indício de ausência de acordo.** A identificação do
   166 se dá pela **listagem de filiação** (`students_search?carrierId=166`),
   nunca pelo extrato. Consulta de 06/11 numa matrícula: portador 95 com 10
   registros, 195 com 3, **166 com 0** — exatamente o previsto. Consistente com
   três coletas independentes de ~800 mil linhas de título, todas com 166 = 0.
2. **`isAgreementInstallment` permanece `false`** em todas as linhas observadas
   (388.446 linhas / 17.211 alunos, reconfirmado em 1.327 linhas / 53 alunos).
   Esse campo deveria marcar parcela de acordo, e no estado atual **não permite
   identificar quais títulos são parcela de acordo**.

**E não existe rota documentada e funcional para consultar acordo pelo número.**
As cinco candidatas foram testadas com o número de um acordo real (71903) e
todas devolveram 404: `/agreements/{id}`,
`/agreements/{numero_do_acordo}`, `/agreements/{numero_do_acordo}/installments`,
`/students/{reg}/agreements/{numero_do_acordo}` e `/negotiations`. Nenhuma 405 —
não conseguimos distinguir "rota não existe" de "existe e não aceita GET nesta
forma".

## 3. O que pedimos

### Opção 1 — ampliar o escopo da chave atual (preferencial)

Fazer `GET /students/{registration}/agreements` retornar, para a chave da
Reativa:

**Cabeçalho do acordo**

| Campo | Por que precisamos |
|---|---|
| identificador do acordo | casar com o boleto do extrato Santander |
| situação (Confirmado / Cancelado / Quebrado / Renegociado) | **é o que define "acordo alterado"** na sincronização |
| `carrierId` (esperado 166) | confirmar origem do acordo |
| valor negociado **e** valor do acordo | são campos distintos na tela (ver §4) |
| nº contratado de parcelas | saber quando a captura está incompleta |
| saldo devedor | acompanhamento |
| data de cadastro e data de assinatura | separar os títulos de origem por data de liquidação |
| usuário que confirmou | atribuição de efetividade |
| referência ao acordo anterior, quando houver | renegociação sem inferência |

**Lista de parcelas — o item que a versão 1 não pedia, e sem o qual o acesso resolve metade**

| Campo | Por que precisamos |
|---|---|
| boleto de cada parcela | é a chave de vínculo do pagamento |
| vencimento de cada parcela | cálculo de vencida / a vencer |
| valor de cada parcela | saldo e projeção |
| situação de cada parcela | saber o que foi pago **sem depender de ter recebido o pagamento** |

**Títulos originais substituídos**

| Campo | Por que precisamos |
|---|---|
| boleto de cada mensalidade negociada | hoje reconstruímos isso por inferência, com teto de confiança e falha medida em 8 de 16 casos |

### Opção 2 — endpoint dedicado

`GET /agreements/{id}` ou `GET /students/{registration}/agreements?carrierId=166`,
com a mesma estrutura.

### Em qualquer das duas

- **Somente leitura.** Não pedimos escrita.
- Mesma autenticação (`X-API-Key`), **sem credencial de pessoa**.
- Se houver limite de taxa, informem o valor — nossa rodada é de 30 minutos e
  respeitamos o limite que for definido.

### A lista fechada do que precisamos (versão 3)

Consolidada para que a TI possa responder item por item. Cada linha é um campo
que a interface do Prime já exibe, e que o acompanhamento do acordo exige.

| # | Campo | Para que serve no CRM |
|---|---|---|
| 1 | **Identificador e situação do acordo** | a situação é o que define "acordo alterado" na sincronização |
| 2 | **Portador e convênio** | confirma que o acordo é da Reativa (166 / 0272047) |
| 3 | **Valor negociado e valor do acordo** | são campos **distintos** na tela; pedimos os dois, pelo nome que a ULBRA usa |
| 4 | **Quantidade de parcelas** | sem ela não há como saber que uma captura está incompleta |
| 5 | **Parcelas: vencimento, valor, boleto e situação de pagamento** | é a chave de vínculo do pagamento, e o único jeito de ver **parcela ainda não paga** |
| 6 | **Títulos originais vinculados ao acordo** | hoje reconstruímos por inferência, com falha medida em 8 de 16 casos |
| 7 | **Saldo devedor** | acompanhamento e conferência |
| 8 | **Datas de cadastro, assinatura e confirmação** | separam os títulos de origem pela data de liquidação |
| 9 | **Usuário responsável pela confirmação** | atribuição de efetividade |
| 10 | **Acordos anteriores vinculados** | renegociação sem inferência por data ou valor |
| 11 | **Documentação da API** | `/swagger`, `/swagger/index.html`, `/openapi.json`, `/docs` e `/health`: todos 404, inclusive sem autenticação |
| 12 | **Limites de utilização** | respeitamos o que for definido; nossa rodada prevista é de 30 minutos |

### Um exemplo real de resposta, com dados anonimizados

Pedimos também, junto com o acesso, **um exemplo de resposta real de um acordo
ATIVO com suas parcelas**, com CPF, nome e matrícula anonimizados.

O motivo é prático: sem um exemplo, qualquer integração nossa seria escrita
contra nomes de campo **supostos**. Já encontramos campos cujo nome parecia
indicar uma coisa e significava outra — `paymentDate` vem preenchido inclusive
em título a vencer, e `paidAmount` é dívida corrigida, não caixa. Um exemplo
anonimizado elimina esse risco antes de uma linha de código ser escrita, e
reduz o retrabalho dos dois lados.

---

## 4. Referência: a estrutura que a interface do Prime já mostra

Acordo **71903**, observado em **04/11/2026** em
`596057.mannesoftprime.com.br` (`sistema.php?ACAO=publico/acordo.view.php`):

| Campo na tela | Valor observado |
|---|---|
| Situação | Confirmado |
| Data Cadastro | 14/09/2026 |
| Data Assinatura | 16/09/2026 |
| Usuário Confirmação | DIEGO RODRIGUES CRUZ |
| Nº Parcelas Originais | 7 |
| **Valor Negociado** | **R$ 3.975,57** |
| **Valor Acordo** | **R$ 4.293,62** |
| Nº Parcelas Novas | 10 |
| Total Pago | R$ 4.293,62 |
| Saldo Devedor | R$ 0,00 |
| Status das parcelas | 10/10 Quitadas |
| Multa | R$ 66,29 |
| Juros | R$ 593,59 |
| Mensalidades originais | 7, venc. 05/12/2025 → 05/06/2026, R$ 473,67 cada |

**Valor Negociado e Valor Acordo são campos distintos** — pedimos os dois, pelo
nome que a ULBRA usa.

O ponto deste quadro: **o dado existe, completo e ao centavo, do lado da
ULBRA.** O que falta é uma via de serviço para ele. Estamos pedindo a via, não
o dado.

---

## 5. Por que não usamos a interface web

Registramos por transparência: a estrutura está visível na tela, mas **não
vamos acessá-la por automação**. A URL é estática, o identificador do acordo vai
no corpo da requisição, e o mecanismo seria POST autenticado ou sessão PHP —
isto é, **credencial de pessoa**. Nossa política proíbe captura por sessão
pessoal, cookie, automação de login ou contorno de autenticação.

É justamente por isso que este pedido existe.

---

## 6. Impacto

| Métrica | Valor |
|---|---|
| Acordos sem estrutura no CRM | 229 |
| Pagamentos Santander sem vínculo | 411 |
| **Valor parado** | **R$ 334.447,57** |
| Desde | 11/09/2026 |
| Importações manuais do relatório | 484 desde 07/07/2026 (~4,5/dia), mais 226 substituições |

Sem o escopo de acordos, o CRM não consegue registrar acordo novo
automaticamente, vincular pagamento à parcela correta, fechar acordo quitado,
nem mostrar ao operador quais mensalidades foram renegociadas. Todo esse
trabalho segue manual, por relatório Excel — o processo que a integração por
API foi contratada para eliminar.

---

## 7. O que mudou da versão 2 para a 3 (06/11/2026)

Nada foi apagado: a versão 2 inteira continua abaixo, e o histórico do pedido
é parte da evidência.

1. **§2.4, nova** — o reteste de 06/11/2026: HTTP 200 com lista vazia, zero
   acordos, nenhuma lista de parcelas, autenticação de gestão funcionando. O
   teste anterior era de 15/09; agora a evidência tem sete semanas de distância
   e o mesmo resultado.
2. **Separação explícita** entre ausência de dados, erro de autenticação e
   limitação da API — porque as três levariam a pedidos diferentes, e só a
   primeira é o nosso caso.
3. **Dois esclarecimentos sobre os nossos próprios números**, para não serem
   lidos como defeito onde são comportamento documentado: o portador 166 não
   aparecer no extrato é por definição da API (a identificação é pela listagem
   de filiação), e `isAgreementInstallment` segue `false`.
4. **Registro de que não existe rota por número de acordo** — cinco candidatas,
   todas 404, testadas com um número de acordo real.
5. **§3, a lista fechada de 12 campos**, para a TI poder responder item por
   item.
6. **Pedido de um exemplo real de resposta com dados anonimizados**, com o
   motivo escrito: sem ele, a integração seria escrita contra nomes de campo
   supostos — e já encontramos campos cujo nome indica uma coisa e significa
   outra.

---

## 8. O que mudou da versão 1 para a 2 (05/11/2026)

1. **Acrescentada a lista de parcelas** ao pedido. A versão 1 pedia o
   cabeçalho do acordo; sem as parcelas, a parcela que ainda não recebeu
   pagamento continua invisível, e a sincronização não substituiria o
   relatório para acordo novo.
2. **Corrigidos dois valores conflatados.** A versão 1 dizia "Total negociado
   R$ 4.293,62". São dois campos: **Valor Negociado R$ 3.975,57** e **Valor
   Acordo R$ 4.293,62**. Mandar um número errado a quem tem o dado correto
   custaria credibilidade ao pedido.
3. **Separada API de tela** (§5), explicitando por que não automatizamos a
   interface — era a confusão mais provável na leitura do pedido.
4. **Acrescentado o pedido de documentação** da API (§2.2) e a pergunta sobre
   limite de taxa (§3).
5. **Atualizada a evidência do portador 166**: três coletas independentes de
   ~800 mil linhas, em vez da contagem única de 302.477.
6. **Versionado** em `docs/integracoes/`, como a regra da pasta exige — a
   versão 1 vivia em `docs/rascunhos/`, fora do controle do git.
