# Contrato da sincronização automática de ACORDOS — o que é necessário e de onde vem

**Consolidado em 05/11/2026.** Fecha a Etapa 0 do lado do CRM: o que a
sincronização automática exige, campo por campo, com a fonte de cada um e o
veredito de disponibilidade. Não repete investigação — consolida o que
`prime-api.md`, `prime-mapa-fontes-verdade.md`, `prime-mapa-identificadores.md`,
`prime-gaps.md` e `docs/PREMISSAS.md` já mediram.

**A pergunta que este documento responde:** podemos substituir a importação
manual do "Relatório de Títulos em Aberto" por sincronização automática, usando
apenas acessos de serviço autorizados?

**Resposta: não, hoje.** Falta **uma** coisa, e está isolada na seção final.

---

## 1. O contrato de origem: o que o importador manual usa hoje

Medido em `src/pages/ImportacaoAcordos.jsx` e na RPC `importar_acordos`.

O contrato **atual** é pobre, e isso importa: automatizá-lo como está
reproduziria um contrato que a Premissa 19 item 8 já critica.

| # | Coluna do relatório | Campo no payload | Destino |
|---|---|---|---|
| 1 | Documento (12 díg.) | `documento` | `acordos_titulos.documento`, `parcelas.boleto` |
| 2 | CPF Aluno | `cpf` | resolução de `aluno_id` |
| 3 | Titular | `nome` | `alunos.nome` (nunca decide vínculo) |
| 4 | Vcto | `venc` | `acordos_titulos.vencimento` |
| 5 | A Receber Bruto | `valor` | `valor_original`, `valor_em_aberto`, `saldo_corrigido` (os três iguais) |
| 6 | Estabelecimento | `unidade` | `acordos.unidade` |
| 7 | Situação do Aluno | `situacao` | `alunos.situacao_academica` |
| 8 | Tipo de Boleto | *(só filtro)* | não é gravado; literal `'Acordo'` é gravado em `acordos_titulos` |

**Três limites do contrato atual, medidos:**

1. `acordos_titulos.dados` (jsonb do payload bruto) **nunca é preenchido** —
   nulo em 392 de 392 (`docs/PREMISSAS.md:550-551`).
2. O relatório **não traz pagamento nem baixa**. Acordo pago **desaparece**
   dele (`docs/PREMISSAS.md:472`), então toda estrutura entra como 100% em
   aberto. Ausência no relatório **nunca é prova negativa**.
3. O importador **não trata cancelamento nem renegociação**: não existe um
   `UPDATE` em `acordos.status` dentro de `importar_acordos`, e a guarda
   `status <> 'CANCELADO'` **reabre** a dívida de acordo cancelado.

---

## 2. O contrato COMPLETO que a sincronização exige

A gestão pediu: *acordos novos ou alterados, com toda a composição, títulos
originais, parcelas, vencimentos, valores, situação, pagamentos, cancelamentos
e renegociações, preservando o histórico.* Isso é maior que as 8 colunas acima.

Legenda de disponibilidade:
🟢 fonte de serviço autorizada e medida · 🟡 parcial ou condicionada ·
🔴 nenhuma fonte de serviço autorizada

### 2.1 Identidade do acordo

| Campo | Fonte autorizada | Status | Nota |
|---|---|---|---|
| Número do acordo no Mannesoft | `financial_statement[].documentNumber` (6 díg. centrais do boleto) | 🟡 | 13.703 de 13.754 comparáveis (99,6%); 51 parcelas em 47 acordos divergem |
| CPF do aluno | `students_search` / `student_composite` → `registrationData.cpf` | 🟢 | **só funciona FORMATADO** — dígitos puros devolvem `totalItems:0` sem erro |
| `registration` (matrícula Prime) | `students_search[].registration` | 🟢 | não é `alunos.matricula` do CRM; resolução passa por CPF |
| Data do acordo (assinatura) | — | 🔴 | visível só na tela; é o seletor da regra venc.+30 |
| Quem fechou o acordo | — | 🔴 | sondado por `prime-acordo`, nada encontrado |

### 2.2 Estrutura negociada

| Campo | Fonte autorizada | Status | Nota |
|---|---|---|---|
| Status do acordo (Confirmado/Cancelado/Quebrado/Renegociado) | — | 🔴 | **é o que define "alterado"** no Processo 1 |
| Valor Negociado | — | 🔴 | observado R$ 3.975,57 no 71903 (tela) |
| Valor Acordo | — | 🔴 | observado R$ 4.293,62 no 71903 — **campo distinto** do anterior |
| Nº contratado de parcelas | — | 🔴 | pela via do extrato só se veem parcelas pagas |
| Saldo devedor | — | 🔴 | `financialStatement` tem 13 campos e nenhum é saldo |
| Entrada / sinal | `parcelas.is_entrada` existe no modelo | 🔴 | identificação por `right(documento,2)='01'` **não é derivável com prova**: nenhuma convenção explica mais de 56,3% de 14.488 parcelas |

### 2.3 Parcelas geradas

| Campo | Fonte autorizada | Status | Nota |
|---|---|---|---|
| Boleto da parcela (11 díg.) | **arquivo Santander, coluna E** → `pagamentos.numero_parcela_completo` | 🟡 | "identificador único por parcela"; **só existe para parcela que recebeu pagamento** |
| Vencimento da parcela | **arquivo Santander, coluna G** | 🟡 | idem — condicionado a pagamento |
| Valor devido da parcela | **arquivo Santander, coluna H** (`valor_original`) | 🟡 | distinto do valor pago (coluna K); idem |
| Honorário da parcela | **arquivo Santander, coluna I** | 🟡 | idem |
| Convênio da linha | **arquivo Santander, coluna F** → `pagamentos.dados.convenio_bancario` | 🟡 | preservado desde `290b1b1b`; equivalência com portador 166 **não medida** |
| Situação de cada parcela | — | 🔴 | provado ao vivo (28/09) que nenhum dos 13 campos do `financialStatement` é situação ou saldo |
| Parcela que **nunca** recebeu pagamento | — | 🔴 | **o buraco estrutural** — ver §4 |

**Correção de uma conclusão anterior:** eu havia dito que o núcleo de parcela
tinha "cobertura zero". Está errado. O arquivo Santander entrega boleto,
vencimento, valor devido e honorário **por parcela de acordo, por chave
exata** (`supabase/functions/santander-previa/planilha.ts:170-199`). A
cobertura é **condicionada a pagamento**, não nula.

### 2.4 Títulos originais substituídos

| Campo | Fonte autorizada | Status | Nota |
|---|---|---|---|
| Boleto do título original (7 díg.) | `financial_statement[].boleto` | 🟢 | é `acordos_titulos.documento` |
| Vencimento e decomposição (principal, desconto, honorário, líquido) | `financial_statement[]` | 🟡 | só do título ORIGINAL (portador 95/195); `penaltyAmount = 0` e `interestAmount = null` em todas as linhas |
| **Quais** mensalidades o acordo substituiu | reconstrução interna (par `documentNumber`+`boleto` + regra venc.+30) | 🟡 | **reconstrução, teto ALTA_CONFIANCA, nunca CONFIRMADO**; o teste de consistência fecha ao centavo em 8 de 16 acordos |

### 2.5 Eventos

| Campo | Fonte autorizada | Status | Nota |
|---|---|---|---|
| Pagamento (valor em caixa e data) | arquivo Santander → `public.pagamentos` | 🟡 | **piso temporal: a base começa em 01/07/2026** |
| Cancelamento | — | 🔴 | depende do status; ausência no relatório não é prova |
| Renegociação / re-acordo | referência explícita do Mannesoft (`acordoAnteriorMannesoft`) | 🔴 | essa referência vem da tela; nunca inferida por data ou valor |
| Payload bruto preservado | bucket privado `importacoes-acordos` + SHA-256; `titulo_presenca_importacao` retém toda linha | 🟢 | **em produção desde 23/10/2026** — a medição de 22/09 que dizia o contrário está superada |

### 2.6 Enumeração do universo

| Campo | Fonte autorizada | Status | Nota |
|---|---|---|---|
| Quem tem acordo em aberto | `students_search?carrierId=166` | 🟡 | **não é histórico**: quem quitou sai do 166. Serve para alimentar fila, não para contar acordos |
| Filiação por título (quais títulos são parcela de acordo) | — | 🔴 | `isAgreementInstallment` nunca observado `true` (388.446 linhas / 17.211 alunos) |

---

## 3. Verificação do caminho de serviço autorizado

**A distinção que a gestão pediu para não confundir:** tela acessível por
usuário **não é** API autorizada. Este documento a mantém.

| Caminho | Autorizado? | Veredito |
|---|---|---|
| `X-API-Key` do Vault, via Edge Function (`prime_api_key_backend()`) | **SIM** — é o acesso de serviço existente | **Não entrega acordo.** `GET /students/{registration}/agreements` devolve `{items:[],totalItems:0}` em 100% dos testes |
| 48 rotas candidatas de acordo | — | **todas 404**, nenhuma 405 (405 indicaria rota existente com método errado) |
| Parâmetros no endpoint existente | — | `carrierId`, `includeSettled`, `status`, `onlyAgreements`, `includeAgreements`, `includeInactive`, `agreementId` — **todos ignorados**, resposta idêntica byte a byte |
| OpenAPI / Swagger | — | `/swagger`, `/openapi.json`, `/docs`, `/health`: 404, inclusive sem autenticação |
| Conector MCP de mensageria ULBRA | **SIM** | clientes e atendimentos; **sem acordo e sem financeiro** |
| Tela web do Prime (`596057.mannesoftprime.com.br`) | **NÃO — não é API** | mostra a estrutura inteira. Mas a URL é estática, o identificador vai no corpo da requisição, e o mecanismo é **POST ou sessão PHP, ambos pendentes**. Acesso por sessão de pessoa está **fora do critério** |

**Sondagem ao vivo não foi executada nesta rodada, e por um motivo que vale
registrar:** o caminho autorizado de sondagem é a Edge Function `prime-sonda`,
que exige JWT de gestão ou `ROTINA_TOKEN`. Nenhum dos dois está disponível a
um agente, e **ler o segredo do Vault para chamar a API por fora violaria a
regra do próprio catálogo** — "a chave nunca chega ao navegador, nunca é
logada". A verificação acima vem das 48 rotas já medidas e versionadas, não de
suposição.

---

## 4. O buraco estrutural, que nenhum pedido resolve sozinho

Ainda que a API passe a entregar acordo, **a parcela que nunca recebeu
pagamento continua invisível pela via Santander**. Um acordo de 12 parcelas
com 1 paga entra no staging com **1** título gerado, e nada no modelo sabe que
faltam 11 — `parcelaUnica` é contagem do que foi capturado, não número
contratado.

É por isso que a sincronização **não substitui** o relatório para acordo novo
não pago, e por isso o pedido à TI (§5) precisa incluir **a lista de parcelas**,
não só o cabeçalho do acordo.

Segundo limite independente: **a base `pagamentos` começa em 01/07/2026**.
Acordo quitado antes disso não tem uma linha. A Premissa 19 item 4 exige
histórico com parcelas, boletos, títulos de origem e pagamentos — e a via
Santander é incapaz de reconstruir isso.

---

## 5. O que falta, exatamente, para a primeira sincronização real

Em ordem de dependência. **Só o item 1 é externo.**

| # | O que falta | Quem resolve | Bloqueia |
|---|---|---|---|
| 1 | **Escopo de acordo na credencial de serviço**, ou endpoint equivalente — ver [`prime-pedido-ti-acordos.md`](prime-pedido-ti-acordos.md) | **TI ULBRA** | tudo |
| 2 | Aplicar o staging **com** o delta de RLS (PR #825) | gestão | gravar captura |
| 3 | Medir a equivalência coluna F ≡ covenant `0272047` | gestão/TI | classe PARCIAL sair de EXCECAO |
| 4 | Decidir **duas regras** que o importador atual não tem: como **atualizar** acordo existente (hoje desvia por `NOT EXISTS`) e o que fazer com **cancelado** (hoje reabre a dívida) | gestão | promoção, e a exigência de preservar histórico |
| 5 | Cron de 30 min do Processo 1 | gestão | a rodada |
| 6 | Ligar a entrada automática do extrato Santander | gestão | trocar manual por manual não é automação |

**O que já está pronto e não precisa ser escrito:** staging append-only com
versionamento e detecção de mudança (`hashComposicao` + `compararVersoes`),
adaptador Santander, motor de conciliação (`pagamento_conciliar_um`), e o
molde de rodada incremental (`fluxo_pagamentos_incremental`).
