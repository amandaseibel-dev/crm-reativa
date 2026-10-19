# F1.b — integração segura do vínculo financeiro (planejamento técnico)

**Estado:** preparação somente no GitHub, sem migration, sem conexão em produção e sem consumidor ativo. A PR #692 contém uma função pura que retorna candidatos, não confirma pagamento.

## Estruturas já existentes
- `solicitacao_confirmacao_pagamentos` associa `confirmacao_id` a `pagamento_id` com unicidade do pagamento, introduzida em `20260922100000_confirmacao_vinculo_pagamentos.sql`.
- `confirmacao_pagamentos_resolver(id)` já separa `VINCULO_GRAVADO`, `CHAVE_MESMA_TRANSACAO`, `AMBIGUO` e `SEM_VINCULO`. Não deve ser substituída por associação por nome e data.
- A função de F1.a `confirmacao_classificar_por_evidencia` devolve a categoria sem gravar status.
- `pagamentos.titulo_numero`, `pagamentos.numero_parcela_completo`, `acordos.numero_ulbra` e `parcelas.boleto` são candidatos a correspondências documentados em `docs/integracoes/prime-mapa-identificadores.md`.
- `ConferenciaPagamentos.jsx` pertence também à PR #673 aberta; não mexer antes de decidir a ordem.

## Contrato da próxima integração
1. A origem deve ser o **pagamento individual** importado, com identidade do aluno já comprovada; não selecionar aluno por nome. O adaptador agora calcula a comprovação para **cada pagamento** por `pagamentos.matricula` → `prime_contratos.registration` → CPF único → `alunos.cpf`, sem aceitar um booleano declarado pelo chamador. Se a identidade não estiver comprovada, retorna `IDENTIDADE_NAO_COMPROVADA` e não oferece candidato. Para integrar operacionalmente, o consumidor precisará carregar o conjunto completo e autorizado de contratos Prime pertinente a cada matrícula, jamais uma amostra que possa ocultar divergências.
2. Resolver o conjunto de pagamentos da confirmação **pela relação gravada existente**, quando disponível. Para legado sem prova, encaminhar à fila de revisão; não preencher retroativamente por aluno/data/nome.
3. Para cada pagamento, avaliar identificadores explícitos e consistência do acordo, aluno e parcela; qualquer conflito, duplicidade, dado malformado, valor inconsistente ou ausência de prova vai para **revisão manual**, com motivo identificável.
4. Se a prova é apenas número do acordo, o resultado é candidato a **acordo**, sem inferir parcela. Se existe boleto exato, só produzir candidato a parcela depois de comprovar unicidade e titularidade.
5. A análise é **não mutável**: não alterar `pagamentos`, `parcelas`, `acordos`, `solicitacoes_confirmacao_pagamento`, agenda, responsabilidades, baixa, quitação ou estado acadêmico.
6. Na persistência futura, exigir transação atômica, índices únicos, rastreabilidade da evidência e idempotência. **Rateio e pagamentos múltiplos por título exigem especificação/teste própria antes de escrever `titulo_id`.**
7. A classe `BAIXA_CONFIRMADA` não decorre desta correspondência. A prova de caixa vem da fonte oficial documentada, não de `paidAmount` ou presença de `paymentDate` na Prime.

## Critérios de aceite para passar de biblioteca isolada a consumidor
- Testes automatizados da PR #692 aprovados.
- Um teste de integração com dados fictícios usando o schema existente prova correspondência 1:1 e recusa ambiguidades/duplicidades.
- Leitura do estado real da PR #673 e decisão expressa sobre ordem de integração da tela.
- Verificação de unicidade e tipos no schema real (sem consultar ou divulgar dados pessoais).
- Nova autorização da gestão antes de qualquer migration, persistência, deploy ou ativação automática.

**F1.b nesta PR:** somente biblioteca, testes e este contrato. A importação diária e a fila seguem como estão.

---

# Medição contra produção — 19/10/2026 (somente leitura)

Tudo abaixo foi medido no banco de produção por `SELECT`, sem migration, sem
escrita e sem ativar nada. Substitui as suposições da seção acima.

## 1. A ponte Santander → Prime → CPF → aluno se sustenta

Das **157** linhas de pagamento ligadas às **108** confirmações abertas que têm
vínculo gravado:

| etapa da prova de identidade | linhas |
|---|---:|
| identidade **comprovada** (`registration` única → CPF único = `alunos.cpf`) | **145** |
| reprovadas por `pagamentos.aluno_id` nulo (11) ou divergente (1) | 12 |
| `CHAVE_DE_IDENTIDADE_AUSENTE` (sem CPF no aluno) | 0 |
| `MATRICULA_SEM_REGISTRO_PRIME` | 0 |
| `CPF_PRIME_AMBIGUO` | 0 |
| `CPF_DIVERGENTE` | 0 |

Zero divergência de CPF em 145 provas é evidência direta de que
`pagamentos.matricula` = `prime_contratos.registration` e que o CPF da Prime
casa com o do CRM, como `prime-mapa-identificadores.md` registra (13 de 13 na
conferência manual). A formatação também é limpa hoje: **0** valores com zero à
esquerda ou caractere não-dígito em `acordos.numero_ulbra`, `parcelas.boleto`,
`pagamentos.titulo_numero`, `numero_parcela_completo`, `matricula` e
`prime_contratos.registration` (63.341 linhas).

## 2. O vínculo gravado em que a F1.b se apoia nasceu de NOME + data

`solicitacao_confirmacao_pagamentos` é escrita pelo bloco `V-VINCULO` do
trigger de import (`20260922100000_confirmacao_vinculo_pagamentos.sql`), e esse
bloco casa `alunos.nome` normalizado com `pagamentos.aluno_nome` + data, exigindo
nome único. Então: **a F1.b não usa nome em código nenhum, mas a fonte em que ela
confia foi derivada de nome.** O que torna o conjunto mais forte do que qualquer
uma das partes é justamente a prova de CPF da Prime aplicada por cima — uma
variável independente do nome. Isso é o valor novo desta frente, e precisa ficar
dito, não implícito.

Cobertura: 995 linhas, **630 de 10.369** confirmações; na fila aberta,
**108 de 274 (39,4%)**.

## 3. Rendimento real do motor na fila aberta: 35 de 274

Simulação da lógica exata de `integracaoConfirmacaoF1b.js` sobre as 274
confirmações `AGUARDANDO_CONFIRMACAO`:

| desfecho | confirmações |
|---|---:|
| `CANDIDATOS_IDENTIFICADOS` | **35** |
| `SEM_VINCULO_GRAVADO` | 166 |
| `CONJUNTO_COM_EXCECAO` | 72 |
| `VALORES_NAO_CONFEREM` | 1 |

O gargalo **não** é defeito do motor: das 145 linhas com identidade comprovada,
**96 têm `titulo_numero` que não existe em `acordos.numero_ulbra`** e 97 têm
`numero_parcela_completo` que não existe em `parcelas.boleto`. São pagamentos de
**mensalidade**, onde esses campos não apontam acordo nem parcela de acordo.
`ACORDO_NAO_ENCONTRADO` é a resposta certa e fechada para eles — não um bug a
corrigir. Vincular mensalidade é outro escopo (`titulo_id`, F1.c), e aí o rateio
volta a ser obrigatório.

A exigência de unicidade **global** (em vez de por aluno) **não custa nada**:
47 números são únicos globalmente e os mesmos 47 são únicos dentro do aluno; as
2 duplicidades são duplicadas também dentro do aluno. `parcelas.boleto` não tem
nenhuma duplicidade. A escolha conservadora está correta e fica.

## 4. Corroboração por variável independente (valor e status da parcela)

Nem valor nem `parcelas.status` entram na decisão do motor, então servem de
teste externo. Dos **41** pagamentos que o motor promove a candidato:

| verificação independente | linhas |
|---|---:|
| `parcelas.status` já é **`PAGO`** | **35** |
| `valor_pago` ≥ valor da parcela (22 maiores: juros/multa) | 39 |
| `valor_pago` **menor** que a parcela | 2 |
| parcela ainda não `PAGO` (informação nova de fato) | 6 |

35 de 41 caem numa parcela que o CRM **já** considera paga — isto é, o caminho
por identificador concorda com um vínculo estabelecido antes e por outro motor
(o da baixa). É a confirmação cruzada que faltava. Consequência honesta: hoje a
análise traz informação nova em **6** linhas; o resto ela confirma.
Os 2 "pago menor" merecem olhar caso a caso antes de qualquer persistência.

## 5. DUPLICAÇÃO: `confirmacao_pagamentos_resolver` já faz a rota 1 — e mais uma

Existe em produção `public.confirmacao_pagamentos_resolver(uuid)`
(`STABLE SECURITY DEFINER`, de `20260922100100_confirmacao_processada_resolver.sql`).
Ela já faz, **dentro do banco**, o que `integracaoConfirmacaoF1b.js` refaz no
navegador, com os mesmos testes: soma dos pagamentos do vínculo gravado contra
`valor_informado` com tolerância de 1 centavo, e recusa quando algum pagamento é
de outro aluno. E tem uma **segunda rota que a F1.b não tem**:
`CHAVE_MESMA_TRANSACAO`, o legado por `pagamentos.created_at =
s.criado_em at time zone 'UTC'`, com portão `confirmacao_utc_provada()` — que
hoje responde **`true`**.

Cobertura dela na mesma fila aberta de 274:

| prova | confirmações | pagamentos |
|---|---:|---:|
| `CHAVE_MESMA_TRANSACAO` | **150** | 185 |
| `VINCULO_GRAVADO` | 101 | 143 |
| `SEM_VINCULO` | 16 | 0 |
| `AMBIGUO` | 7 | 0 |

**251 de 274 (91,6%)** contra as 35 da F1.b. Os 166 que a F1.b devolve como
`SEM_VINCULO_GRAVADO` incluem as 150 que essa função resolve.

### Por que a F1.b não a chama — e o que falta decidir

`confirmacao_pagamentos_resolver` **não tem `EXECUTE` para `authenticated`** (só
`postgres` e `service_role`) e **não tem portão `usuario_e_gestao()` interno**.
Então o navegador não consegue chamá-la, e abrir `EXECUTE` sem adicionar o portão
repetiria o erro já registrado no repositório (7 `SECURITY DEFINER` sem portão
interno abertas a qualquer logado). **Isso é uma migration, e depende de
autorização da gestão** — está fora desta PR por decisão, não por esquecimento.

O desenho correto, quando autorizado:

1. migration: `usuario_e_gestao()` no corpo de `confirmacao_pagamentos_resolver`
   + `grant execute` para `authenticated`;
2. `analiseFinanceiraF1b.js` passa a obter o conjunto de pagamentos **dessa
   função** (as duas rotas), em vez de ler `solicitacao_confirmacao_pagamentos`
   direto — some a reimplementação e entram as 150 do legado;
3. `comprovarIdentidadeF1b` e `identificarVinculoF1b` ficam como estão: são o
   valor que a F1.b acrescenta e que não existe em lugar nenhum hoje —
   a função do banco para em `pagamento_id` e nunca chega a acordo/parcela.

## 6. Permissão e PII

- `solicitacao_confirmacao_pagamentos`: RLS com `usuario_e_gestao()` — operador
  comum vê 0 linhas e a análise devolve `SEM_VINCULO_GRAVADO`.
- `prime_contratos`: política `prime_contratos_select` = `NOT eh_painel()`, isto
  é, **qualquer logado lê `registration` e `cpf`**. A proteção existia apenas pela
  **ordem** das consultas (a tabela de gestão abortava antes). Corrigido nesta
  revisão com portão explícito `usuario_e_gestao()` no início de
  `analisarConfirmacaoF1bNoCRM`, antes de qualquer leitura de PII, com teste.

## 7. Custo do painel por clique

Nenhum aluno tem mais de **3** confirmações abertas (214 têm 1, 27 têm 2, 2 têm
3). O teto de 20 do componente nunca é atingido e o N+1 fica em poucas consultas
por clique — não há problema de desempenho a resolver aqui.

---

# Preparo da migration do resolver — 19/10/2026

Autorizado por Amanda em 19/10/2026 **para preparar**, não para aplicar nem
mesclar. Migration escrita: `20261019120000_f1b_resolver_porta_de_gestao.sql`.
**Não aplicada.**

## O desenho mudou: envelope, não portão dentro do resolver

A seção 5 acima propunha pôr `usuario_e_gestao()` **dentro** de
`confirmacao_pagamentos_resolver` e abrir `EXECUTE`. Medir derrubou isso, por
duas razões, cada uma suficiente:

1. **`confirmacao_pagamento_processado(uuid)` (SECURITY DEFINER) chama o resolver
   por dentro.** E `usuario_e_gestao()` é
   `auth.jwt()->>'email' in (<3 e-mails>)`, que dá **false** para `service_role`,
   `postgres` e cron — não há JWT ali. Um portão incondicional dentro do resolver
   **quebraria esse caminho interno que hoje funciona.**
2. **A migration `20260922100150` revogou `EXECUTE` dessas funções de propósito**
   ("menor privilégio: nenhuma é chamada pelo front"). Abrir o resolver reverteria
   uma decisão deliberada de endurecimento, não corrigiria um esquecimento.

Então a migration **cria uma função nova** —
`confirmacao_pagamentos_resolver_gestao(uuid)` — que tem o portão e repassa o
resultado. O resolver interno **não é tocado** e **continua sem `EXECUTE` para
`authenticated`**. Rollback é `drop function`, sem nada a restaurar.

Prova de que o resolver não é tocado: corpo em produção tem 3801 bytes,
`md5(prosrc)` = `f9ed8548789684bd2ebe20e0894e8f89`, **idêntico** ao do arquivo
`20260922100100_confirmacao_processada_resolver.sql` (sem deriva), e a migration
nova não emite `CREATE OR REPLACE` para ele — o único `create` é o da função
nova. Depois de aplicar, esse md5 deve continuar o mesmo.

Verificado antes de escrever: o nome `confirmacao_pagamentos_resolver_gestao`
não existe (0), **0** crons e **0** triggers usam o resolver ou o
`confirmacao_pagamento_processado`.

## As 251 NÃO são vínculos comprovados — e isso é o ponto

Condição da Amanda: "confirme que as 251 confirmações possuem vínculos
comprovados, e não apenas correspondências sugeridas". A resposta medida é
**não**, e importa dizer por quê. As duas rotas do resolver ancoram identidade no
**nome normalizado do aluno**:

| rota | o que ela exige | âncora de identidade |
|---|---|---|
| `VINCULO_GRAVADO` (101) | linha em `solicitacao_confirmacao_pagamentos`, escrita pelo bloco `V-VINCULO` do trigger de import | `alunos.nome` normalizado = `pagamentos.aluno_nome` + data, com nome único |
| `CHAVE_MESMA_TRANSACAO` (150) | mesma transação do import (`created_at` = `criado_em at time zone 'UTC'`), mesma data, soma fecha o valor, nenhum conjunto concorrente | `_nome_norm(pagamentos.aluno_nome)` = nome do aluno |

Ou seja, as 251 são **reconstruções do agregado da importação**, não prova. São
"sugeridas" no sentido exato da pergunta.

**O que prova é o que a F1.b põe por cima:** a ponte
`pagamentos.matricula` → `prime_contratos.registration` → CPF único →
`alunos.cpf`, independente do nome, mais os identificadores financeiros exatos.
Depois disso o número cai de 251 para **168**:

| desfecho | confirmações | das quais `VINCULO_GRAVADO` | das quais `CHAVE_MESMA_TRANSACAO` |
|---|---:|---:|---:|
| **`CANDIDATOS_IDENTIFICADOS`** | **168** | 35 | 133 |
| `CONJUNTO_COM_EXCECAO` (revisão) | 83 | 66 | 17 |
| `RESOLVER_SEM_VINCULO` (revisão) | 16 | — | — |
| `RESOLVER_AMBIGUO` (revisão) | 7 | 7 | — |
| **total da fila aberta** | **274** | 101 | 150 |

Os 106 que seguem para **conferência manual** são 83 + 16 + 7. Motivos:

| motivo | confirmações / pagamentos |
|---|---|
| `ACORDO_NAO_ENCONTRADO` (pagamento de **mensalidade**: `titulo_numero` não é número de acordo) | 134 pagamentos (96 gravado + 38 legado) |
| `BOLETO_NAO_ENCONTRADO` | 6 pagamentos |
| `ACORDO_AMBIGUO` | 2 pagamentos |
| `IDENTIFICADORES_CONTRADITORIOS` (acordo e boleto apontam acordos diferentes) | 1 pagamento |
| `RESOLVER_AMBIGUO` — vínculo gravado cuja soma não fecha ou tem pagamento de outro aluno | 7 confirmações |
| `RESOLVER_SEM_VINCULO` — nenhum pagamento da mesma transação/data/nome | 16 confirmações |

Por que a rota do legado rende mais (133/150) que a do vínculo gravado (35/101):
o vínculo gravado só existe desde 22/09 e cobre as importações recentes, cuja
mistura é predominantemente **mensalidade** (96 de 143 pagamentos
`ACORDO_NAO_ENCONTRADO`); no legado a mistura é de **acordo** (38 de 185).

## Corroboração: as duas rotas e os identificadores nunca se contradisseram

Valor da parcela e `parcelas.status` **não entram** na decisão do motor, então
servem de teste externo. Sobre os **185 pagamentos** que viram candidato:

| verificação independente | resultado |
|---|---|
| parcela identificada já marcada **`PAGO`** pelo CRM | **178 de 185 (96,2%)** |
| `valor_pago` ≥ valor da parcela (99 exato + 85 maior, juros/multa) | 184 de 185 |
| `valor_pago` **menor** que a parcela — olhar caso a caso | **1** |
| parcela ainda não `PAGO` (informação nova de fato) | **7** |
| acordo identificado pertence a **outro** aluno (`ACORDO_DE_OUTRO_ALUNO`) | **0 de 185** |
| mesmo pagamento reivindicado por duas confirmações abertas | **0** |
| rota do legado contradizendo a tabela de vínculo gravado | **0** |
| acordos distintos alcançados | 153 |

Leitura honesta: em 178 dos 185 a F1.b **confirma** um vínculo que outro motor (o
da baixa) já havia estabelecido — é a confirmação cruzada que faltava, e o valor
está em poder carimbar isso com prova. A informação **nova** são **7** pagamentos.
O caminho por identificador e o caminho por nome **nunca discordaram** sobre a
titularidade: 0 em 185.

## Sem efeito financeiro — verificado mecanicamente

| verificação | resultado |
|---|---|
| `insert`/`update`/`delete`/`truncate`/`alter`/`drop` na migration | **nenhum** |
| objeto existente substituído pela migration | **nenhum** (único `create` é da função nova) |
| `trigger`, `cron`, `table` ou `policy` tocados | **nenhum** |
| escrita (`.insert`/`.update`/`.upsert`/`.delete`) no JS da F1.b | **nenhuma** |
| RPCs que o JS chama | só `usuario_e_gestao` e `confirmacao_pagamentos_resolver_gestao`, ambas **STABLE** |
| volatilidade: resolver e portão | **STABLE** ambos |

A função nova é **`stable`**: o PostgreSQL **recusa** `INSERT`/`UPDATE`/`DELETE`
dentro de função não-volátil (`0A000`). A garantia é do motor, não só da
convenção. Nada de baixa, quitação, saldo, status, agenda ou fila é alcançado.

## O que a tela passa a dizer

`prova_do_conjunto` é carregada até o retorno e aparece no painel, porque as duas
rotas **não têm o mesmo peso** e nenhuma delas é prova de pagamento:
"vínculo gravado na importação" × "reconstruído pela transação do import
(legado)". Conjunto com proveniências misturadas vai para revisão
(`PROVAS_MISTURADAS`) em vez de eleger uma. O veredito do resolver, quando ele
não resolve, é repassado com o texto dele (`motivo_resolver`).
