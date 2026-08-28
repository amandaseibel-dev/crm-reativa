# Premissas do CRM ReATIVA

Regras de negócio que **não se discutem por implementação**. Cada uma nasceu de
um erro real em produção; o histórico de cada erro está nas memórias citadas.

Este documento é o contrato. Código que contraria uma premissa é defeito, mesmo
que funcione na tela — e mudança de premissa é decisão da gestão, registrada
aqui antes de virar código.

Cada premissa diz **onde ela é imposta**. Premissa que só existe em texto é
premissa que volta a ser violada: a regra tem de morar no banco (gatilho,
constraint ou função), não na tela.

Estado em 28/08/2026. Premissas 1 a 11 fechadas com a gestão.

---

## Dívida

### 1. Mensalidade só sai da conta se estiver vinculada ao acordo

Nunca por data. Não existe dedução de calendário: a mensalidade sai da dívida
**só** quando há linha em `acordo_titulo_vinculo`.

**Por quê:** `titulo_superado_por_acordo` escondia a mensalidade sempre que
existisse qualquer acordo criado depois do vencimento dela. Escondeu 4.368
títulos de 1.432 alunos, R$ 6.229.309,16. Amanda: *"não crie regras que não
existem"*.

**Onde vive:** `titulo_superado_por_acordo` foi aposentada (responde sempre
`false`) — PR #187. Não reintroduzir.

Memória: `mensalidade-so-sai-se-vinculada`

### 2. Dois acordos ativos são duas dívidas

Acordo novo **não** substitui o anterior. Quando entra acordo para aluno que já
tem outro ATIVO — inclusive se ele já estava pagando o primeiro — os dois ficam.
O valor do novo não embute o saldo do antigo.

**Por quê:** 203 alunos com 2+ acordos ATIVOS, R$ 2.800.015,68. Destes, 55
(R$ 1.040.910,85) já pagavam o primeiro quando o segundo entrou. Decisão da
gestão: *"manter a anterior, que são dívidas diferentes"*.

**Onde vive:** a tela de duplicados agrupa por **mesmo aluno + mesmo valor +
mesma quantidade de parcelas** — e está certa assim. `cancelar_acordos_importados_superados`
continua valendo só no caso restrito para o qual foi feita: acordo antigo com
ZERO parcelas pagas e totalmente vencido antes do novo. **Se o antigo tem
qualquer parcela paga, não encosta.**

Memória: `dois-acordos-ativos-sao-dividas-diferentes`

### 3. "Pago" só com saldo zerado

Nenhuma tela apresenta um caso como pago enquanto houver saldo vencido em
aberto. Com resíduo, o rótulo é **"Pago parcial"** (laranja `#f97316`), nunca
"Pago" verde.

**Por quê:** casos com selo verde "Pago" mostrando "Em aberto: R$ 2.525,96" —
o selo fazia a operadora parar de cobrar o que sobrou. 74 casos,
R$ 206.592,19.

**Onde vive:** checar `alunos.saldo_vencido` (persistido por
`recalcular_situacao_aluno`) antes de escrever "Pago". Helper `semSaldoVencido(a)`
em `PainelCarteira.jsx`. Vale para `statusPrazo`, `situacaoLabel` e a ficha.

Memória: `premissa-pago-so-com-saldo-zerado`

### 4. `liquidado_em` do Prime não é prova de pagamento — vai para a fila de confirmação

Título liquidado no Prime **não** é baixado. Ele entra na **fila de confirmação
de pagamento** como qualquer outra solicitação, e uma pessoa decide.

**Por quê:** `liquidado_em` aparece igual em título que foi pago e em título que
virou acordo — só o portador separa, e nem ele fecha sozinho. Ler liquidação
como pagamento teria apagado R$ 34,6 milhões de dívida viva.

**Onde vive:** a fila de confirmação já impõe a premissa 3 de graça —
`confirmar_pagamento_solicitacao` chama `confirmar_baixa_caso`, que **só quita se
o saldo zerar**; sobrando resíduo, o caso continua com o operador. O item do
Prime entra como solicitação com `operador_email = 'prime@sistema'`, `titulo_id`
preenchido, `data_pagamento = liquidado_em` e os três sinais escritos em `motivo`.

**Portão de entrada** (senão a fila recebe 40 mil itens e para de servir):
- aluno que sumiu dos dois portadores — 52 alunos, R$ 1,2 mi;
- título liquidado com pagamento do Santander cobrindo o dia inteiro do aluno —
  1.056 títulos, R$ 832.147,44.

Quem segue no portador 195 **não entra**: o Prime está dizendo que ainda deve
(33.820 títulos, R$ 21,1 mi).

Memórias: `prime-nao-serve-para-limpar-divida`, `conferencia-prime-tres-sinais`

---

## Prime

### 5. O Prime é a fonte da verdade; o CRM é o espelho

Divergiu, o Prime ganha. O ajuste manual da gestão é reconciliação contra o
Prime, não palpite — não pedir que ela "confira" o que já espelhou.

**Onde vive:** a automação certa é levar o dado do Prime para dentro do CRM,
nunca pedir conferência do CRM contra si mesmo.

Memória: `prime-e-a-fonte-da-verdade`

### 6. Nenhuma baixa automática a partir do Prime

Baixa exige os **três sinais** e **decisão humana registrada**:

1. **Portador** — 195 = ainda cobra; 166 = saiu da cobrança; em nenhum = quitou.
2. **Cruzamento com o Santander** — nossa base de pagamentos começa em
   01/07/2026; para liquidação a partir daí, sem pagamento = negociação.
   Antes disso a ausência não prova nada.
3. **Cobertura do lote** — a unidade é **aluno + data de liquidação**, não o
   valor do título: o aluno paga em lote com juros (de 1.595 títulos, 1 batia
   exato).

**Por quê:** dos 41 títulos que "pareciam pagos" pela API, 12 de 13 alunos
tinham acordo CANCELADO. A Prime marca a mensalidade como paga quando o aluno
negocia e **não reverte** quando o acordo cai.

**Onde vive:** decisão gravada em `prime_conferencia_decisao`. Nenhuma rotina
toca em aluno com acordo `CANCELADO`. Valor negativo (estorno) nunca vira baixa.

Memórias: `prime-baixa-automatica-proibida-acordo-cancelado`, `conferencia-prime-tres-sinais`

### 7. O Prime enriquece cadastro, e só

Telefone, endereço, curso, campus, turno, situação acadêmica e semestre da
dívida entram livremente. O Prime **nunca** toca em saldo, título, parcela ou
acordo.

**Por quê:** a API é somente-leitura (`allow: GET`), não expõe parcela de acordo
(portador 166 nunca devolve uma — +9.000 varridas, zero) e `/agreements` vem
vazio em 100% dos alunos testados. Enriquecer é seguro e destrava carteira
inacionável; mexer em dinheiro não.

**Onde vive:** `supabase/functions/prime-sync` e `prime-cadastro`. Contato entra
por `aluno_contato_adicionar`, que **complementa**: telefone novo não sobrescreve
o antigo e número invalidado não ressuscita.

**Armadilhas da API** (cada uma custou erro real):
- busca por CPF **só funciona formatada**; em dígitos puros devolve
  `totalItems: 0` sem erro — falha silenciosa;
- toda listagem é paginada com `take` padrão 50; usar o composto
  `GET /students/{matrícula}`, que devolve tudo sem paginar;
- `503` é indisponibilidade temporária → backoff;
- o nome do portador varia; vale o `id`. `covenant` vem com zero à esquerda e é
  nulo no 195 → casar sempre por `carrierId`;
- `referenceSemester` é o período do aluno no curso, **não** o semestre do
  calendário — quem manda é a janela de datas do contrato.

Memória: `integracao-ulbra-prime-api`

---

## Fila e carteira

### 8. Um aluno = um caso aberto

Trava no banco, não na tela. A ficha do aluno é única — acordo e mensalidade
aparecem juntos nela, então nem esse caso justifica dois casos abertos.

**Onde vive:** gatilho `trg_caso_nao_duplica_aluno` em `casos` (BEFORE
insert/update), levanta `ALUNO_JA_TEM_CASO_ABERTO`. **Ativo e confirmado em
produção.**

**Armadilha de medição:** para contar a fila real, filtrar
`not coalesce(encerrado_operacional,false)` **junto com**
`caso_encerrado_operacional(...)`. Só a função não basta — ela não lê
`encerrado_operacional`, que é o marcador usado pelas fusões.

Memória: `um-aluno-um-caso-trava-no-banco`

### 9. Acionamento é fato consumado

Trocar de dono muda a responsabilidade, não o passado. Nenhum caminho apaga
`data_ultimo_acionamento` nem `status_acionamento`.

**Por quê:** `internal.set_resp_aluno` zerava o acionamento na troca de
responsável. O aluno reaparecia como "nunca acionado", o trabalho feito era
subestimado e ele voltava a entrar em ação massiva — podendo receber a mesma
mensagem duas vezes. 1.619 apagados, 1.826 restaurados.

**Onde vive:** gatilho `trg_acionamento_nao_volta_para_nulo` em `alunos`.
**Ativo e confirmado em produção.** Protege acionamento e tabulação (fato);
`proxima_acao`, `data_retorno` e `hora_retorno` continuam zerando — são plano
do operador anterior, não fato.

**Só três movimentações são acionamento:** `FINALIZACAO_ATENDIMENTO`,
`ACAO_MASSIVA_EXTERNA`, `ACAO_MASSIVA_EXTERNA_EMAIL`. `REDISTRIBUICAO_SINCRONIZACAO`,
`CARGA_RETROATIVA`, `ZERADO_REAL_SEM_SALDO` e `QUITADO_MANUAL` **não são**.

Memória: `troca-de-operador-apaga-acionamento-e-retorno`

### 10. Encerrar cobrança é da gestão

Operador relata, não decide. Jurídico, suspensão e cancelamento de cobrança só
valem vindos do ADM/gestão; marcação de operador se reverte.

**Por quê:** um operador confundiu "acordo cancelado" com "cancelamento de
cobrança" e tirou dois alunos da cobrança por conta própria.

**Onde vive:** gatilho `trg_encerramento_so_gestao` em `alunos`. **Ativo e
confirmado em produção.**

**Para achar a origem de uma marcação:** olhar `aluno_movimentacoes` tipo
`FINALIZACAO_ATENDIMENTO`. O `audit_log` **não** registra mudança de
`status_atual` em `alunos`.

Memória: `cancelamento-de-operador-volta-para-a-fila`

### 11. Fila e agenda leem a mesma função

A agenda é lista de **compromisso**, não de trabalho pendente: só entra retorno
que uma pessoa marcou com o aluno (`retorno_origem = 'OPERADOR'`). E ela aplica
as **mesmas** exclusões da fila — quitado, status não acionável, confirmação de
pagamento pendente, resíduo abaixo de R$ 5,00 — escopada pelo **dono do caso**
(`responsavel_atual_email`), não por `operador_email` do cadastro unificado.

Não entram, mesmo com `data_retorno` preenchida: régua por status (mensagem
enviada +2 dias úteis, link +1, comprovante +3, acordo fechado +2), motor da
fila (`recalcular_situacao_aluno`), ação massiva +10 e régua de e-mail.

**Por quê:** `data_retorno` é o campo que reposiciona o caso na fila. Usá-lo
como agenda mistura reposicionamento com compromisso e a tela vira ruído.

> **ESTA PREMISSA NÃO ESTÁ IMPLEMENTADA.** Medido em 28/08/2026: a agenda mostra
> **12.986** itens, dos quais só **313** têm `retorno_origem = 'OPERADOR'` —
> **97,6% é ruído**. `AgendaOperacional.jsx` filtra apenas `data_retorno is not
> null` e escopa por `operador_email`; `PainelCarteira.jsx` tem consulta própria
> sobre `alunos`. O módulo compartilhado `src/utils/filaAcionamento.js`, dado
> como pronto em 25/08, **não existe em nenhuma branch** — foi registrado na
> memória mas nunca commitado.

**Onde deve viver:** regra única, no banco, lida por Painel Carteira e Agenda.
Qualquer código que grave `data_retorno` grava `retorno_origem` junto, e só
marca `'OPERADOR'` quando o humano digitou a data naquele atendimento.

Memórias: `premissa-agenda-so-retorno-agendado`, `agenda-retorno-origem-operador`

---

## Pendente de decisão

Premissas de **como se escreve** (regra no banco e não na tela, paginação com
desempate, checagem de rotinas concorrentes sobre a mesma coluna de estado,
migration commitada no mesmo dia) foram propostas em 28/08/2026 e ainda não
foram fechadas com a gestão. Entram aqui quando forem.
