# Premissas do CRM ReATIVA

Regras de negócio que **não se discutem por implementação**. Cada uma nasceu de
um erro real em produção; o histórico de cada erro está nas memórias citadas.

Este documento é o contrato. Código que contraria uma premissa é defeito, mesmo
que funcione na tela — e mudança de premissa é decisão da gestão, registrada
aqui antes de virar código.

Cada premissa diz **onde ela é imposta**. Premissa que só existe em texto é
premissa que volta a ser violada: a regra tem de morar no banco (gatilho,
constraint ou função), não na tela.

Estado em 28/08/2026. As quinze premissas foram fechadas com a gestão.

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

### 11. A Carteira é a fila; retorno agendado nasce marcado

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

> **A TELA FOI RETIRADA DO AR EM 28/08/2026, por decisão da gestão.** Medido
> naquele dia: a agenda mostrava **12.986** itens, dos quais só **313** tinham
> `retorno_origem = 'OPERADOR'` — **97,6% era ruído**. `AgendaOperacional.jsx`
> filtrava apenas `data_retorno is not null` e escopava por `operador_email`
> (o do cadastro unificado) em vez do dono do caso; `PainelCarteira.jsx` tem
> consulta própria sobre `alunos`. Duas regras diferentes para a mesma pergunta.
>
> O módulo compartilhado `src/utils/filaAcionamento.js`, dado como pronto em
> 25/08, **nunca existiu** — foi registrado na memória e jamais commitado.
>
> **A tela não foi adiada, foi dispensada.** Decisão da gestão em 28/08/2026:
> *"se a fila de acionamentos faz sentido, e se é possível definir a data como
> hoje para acionar os casos, não vejo sentido"*. A Carteira já entrega o mesmo
> serviço e entrega melhor — selo **"Retornar hoje"** no card, filtro e contador
> do dia, e a data de retorno editável dentro do próprio atendimento. A Agenda
> era uma segunda porta para o mesmo dado, e a porta pior: mostrava
> reposicionamento de fila junto com compromisso.
>
> Retiradas a rota `/agenda`, o item de menu e as entradas de permissão dos
> quatro perfis. O arquivo `src/pages/AgendaOperacional.jsx` fica no repositório
> como histórico. `Minha Agenda` (`/minha-agenda`) é outra tela e continua no ar.
>
> **O que sobrevive desta premissa** é a regra de escrita, que continua valendo
> em qualquer lugar que grave retorno: quem grava `data_retorno` grava
> `retorno_origem` junto, e só marca `'OPERADOR'` quando o humano digitou a data
> naquele atendimento. Sem isso não há como distinguir compromisso de motor da
> fila — e foi essa mistura que inutilizou a Agenda.

**Onde vive:** a Carteira é a única porta para o trabalho do dia. Não abrir uma
segunda tela sobre `data_retorno` sem que ela leia exatamente as mesmas
exclusões da fila.

Memórias: `premissa-agenda-so-retorno-agendado`, `agenda-retorno-origem-operador`

---

---

## Como se escreve

As onze premissas acima dizem o que o sistema deve fazer. **Estas quatro existem
para que as onze não sejam desfeitas sem ninguém perceber.** Os quatro erros que
as originaram têm a mesma assinatura: nada quebrou, nenhum alarme tocou, e o
número errado chegou à gestão com a cara de um número certo.

### 12. A regra mora no banco, não na tela

Regra de negócio se escreve uma vez, no banco, e toda tela pergunta para lá.
Nenhuma regra nova em `.jsx`.

**Por quê:** regra escrita dentro de uma tela vale só ali — a tela do lado não
sabe que ela existe, e as duas divergem sem dar erro. A Agenda e a Carteira
respondiam "quem eu ligo hoje?" com contas diferentes: 12.986 contra 313.
Nenhuma das duas estava quebrada; cada uma tinha a sua regra. O selo "Pago"
repetiu o padrão — uma tela conferia o saldo antes de escrever, outra não.

**Onde vive:** mudar de ideia sobre uma regra tem de ser uma alteração em um
lugar só, valendo em todas as telas no mesmo instante.

Memórias: `premissa-agenda-so-retorno-agendado`, `premissa-pago-so-com-saldo-zerado`

### 13. Lista longa se pagina, e sempre com desempate por coluna única

Usar `src/utils/paginado.js` (`buscarTudo`). Toda consulta paginada termina com
`.order("id")`. Contagem se faz com `count: 'exact', head: true`, não trazendo
tudo. Filtro de status vai no banco, não no cliente.

**Por quê — dois defeitos distintos, ambos silenciosos:**

1. **Sem paginar**, a API corta em **1.000 linhas mesmo sem `.limit`** e responde
   `206 Partial Content` — sucesso. Nenhuma tela reclama, nenhum log acusa. A
   fila de confirmação mostrava 617 pagamentos e R$ 853.230,58 quando o correto
   era 2.258 e R$ 3.226.623,24: **R$ 2,36 milhões invisíveis**. Foram 16
   consultas cortadas, incluindo produtividade e comissão calculadas sobre 10%
   dos dados.
2. **Paginando sem desempate**, cada página é uma consulta nova e o Postgres não
   garante a mesma ordem entre elas quando a coluna tem empates. A linha cai em
   várias páginas (repetida) e outras não caem em nenhuma (somem). Tarciele
   apareceu **4×** na fila do João com uma ficha só no banco — e o lado que some
   é invisível.

**Onde vive:** `src/utils/paginado.js`. Não deixar tela nova nascer com laço
próprio — foi assim que a Carteira ficou de fora do helper que já existia.

**Não levantar o teto da API:** o navegador passaria a baixar 17 mil linhas num
sistema que já caiu por CPU/IO.

Memórias: `teto-mil-linhas-corta-telas`, `paginacao-sem-desempate-repete-e-perde`

### 14. Antes de criar rotina que mexe em estado, listar quem mais mexe

Rotina automática que escreve numa coluna de estado (`encerrado_operacional`,
`status_financeiro`, `data_retorno`) só entra depois de conferir as outras que
escrevem na mesma coluna. Dois consertos relacionados no mesmo dia exigem
reconferir o estado no fim.

**Por quê:** em 28/08 duas rotinas mexiam em `encerrado_operacional` com
critérios opostos — a fusão de duplicados marcava, o reabridor desmarcava. O
reabridor achou as cópias que a fusão tinha aposentado e **trouxe 513 de volta**,
recriando a duplicidade recém-limpa. Não houve erro nem aviso: as duas
"funcionaram". Só apareceu porque a gestão pediu revisão do início ao fim.

**Onde vive:** trava aplicada — o reabridor só reabre quando o aluno não tem
nenhum outro caso aberto.

Memória: `reabridor-e-fusao-se-atropelaram`

### 15. Migration aplicada em produção é commitada no mesmo dia

Aplicar no banco e salvar o arquivo no repositório são dois passos. O segundo
não fica para depois. E **"está pronto" sem número de PR é suspeita, não fato** —
conferir com `git grep` antes de contar com qualquer coisa.

**Por quê — o erro acontece nos dois sentidos:**

- **Código vivo sem arquivo:** 12 funções e gatilhos rodavam em produção sem
  definição em arquivo nenhum, incluindo `_reabrir_aluno_com_divida_nova` e
  `saude_carteira_saldo_por_origem`. Uma reconstrução do banco pelo repositório
  teria perdido tudo isso (PR #235 versionou 20 arquivos).
- **Arquivo que nunca existiu:** `src/utils/filaAcionamento.js` foi registrado
  como pronto e importado pelas duas telas em 25/08. Não existe em nenhuma
  branch, nenhum commit, nem no disco. Foi o que deixou a Agenda três dias no ar
  mostrando 97% de ruído.

**Onde vive:** a auditoria que funciona compara **objetos**, não nomes de
migration — extrair `create function/trigger/table/view/policy` de
`supabase_migrations.schema_migrations` e conferir se aparecem em
`supabase/migrations`. Comparar nomes de arquivo deu 73 falsos positivos. Vale
repetir de tempos em tempos.

Memórias: `prod-tinha-funcoes-que-o-repo-nao-registrava`, `arquivos-locais-podem-estar-atras-da-main`
