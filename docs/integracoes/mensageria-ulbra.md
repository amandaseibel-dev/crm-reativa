# Mensageria Ulbra (crm.ulbra.ai) — conector MCP

Sistema de atendimento/WhatsApp da ULBRA, separado do Prime. O ReATIVA One
fala com ele pelo endpoint MCP JSON-RPC 2.0 `https://crm.ulbra.ai/api/mcp`
(`tools/call`; o resultado da ferramenta vem serializado em
`result.content[0].text`). Medido em 2026-11-04 pela conexão OAuth de gestão.

## Credencial

- Edge Functions usam `ULBRA_MCP_TOKEN` (secret de backend, Bearer). Natureza
  do token (serviço × pessoa) **não confirmada** no repositório; os limites
  abaixo são por pessoa e por conexão — se for token de pessoa, todo o CRM
  divide o mesmo orçamento.
- Limites medidos: 15 chamadas/min por conexão, 30/min por pessoa,
  **500/dia por pessoa**, 20 rascunhos/h.

## Ferramentas (8) e escopos

| Ferramenta | Escopo | Argumentos | Resposta |
|---|---|---|---|
| `meu_acesso` | `mcp:acesso` | — | pessoa, perfis, escopos, limites |
| `consultar_cliente` | `clientes:read` | `telefone` \| `cpf` \| `nome` | `clientes[]` {id, nome, contato{telefone,email}, documento, situacao, equipe, tags} |
| `listar_clientes` | `clientes:read` | `busca, situacao, tags, limite≤50, pagina` | `clientes[]`, `paginacao{total}` |
| `conferir_duplicidade` | `clientes:read` | `contatos[≤20]{telefone\|email\|cpf}` | `resultados[]` **por posição** {posicao, existe, cliente?{id}, equipe?, emAtendimento?{equipe}} — `cliente.id` só dentro do escopo |
| `listar_atendimentos` | `atendimentos:read` | `situacao ∈ new/offered/assigned/accepted/done/expired/waiting, coluna, equipe, atendente, cliente, limite≤500, pagina` | `atendimentos[]` {id, cliente{id,nome}, situacao, coluna, equipe, atendente, entrouEm, aceitoEm, atualizadoEm}; **sem contato nem conversas** |
| `consultar_atendimento` | `atendimentos:read` | `id` | atendimento + histórico de eventos |
| `abrir_atendimento` | `atendimentos:write` | `cliente, equipe?, atendente?` | abre já ACEITO na fila do atendente; `ja_existia` se já é dele |
| `criar_atendimentos_da_lista` | `atendimentos:write` | `linhas[≤20], previa (padrão true)` | prévia por linha; grava só com `previa:false` |

**Não expostos:** conversas, mensagens, envio, campanhas, templates,
transferência de atendimento, edição de cadastro, relatórios.

Armadilha medida: `conferir_duplicidade` devolveu `existe:true` com
`equipe:null` para telefone inexistente — sem `cliente.id` e sem `equipe` não é
prova de cadastro (tratado como `NAO_ENCONTRADO`).

## Edge Functions

| Função | Ferramenta usada | Portão |
|---|---|---|
| `ulbra-consultar` | `conferir_duplicidade` (1 chamada, **telefone e CPF nas duas posições**) | JWT + usuário ativo; operador só aluno da própria carteira; grava `ulbra_vinculos` e `auditoria` (`ULBRA_CONSULTA`, `ULBRA_VINCULO_CRIADO`, `ULBRA_VINCULO_BLOQUEADO`) |
| `ulbra-leads-pendentes` | `listar_atendimentos {situacao:"waiting"}` | JWT; `receptivo` da própria linha ou `usuario_e_gestao()`; filtra equipe `"Reativa"`; devolve só id, nome, data |

Componente da ficha: `src/components/BlocoUlbra.jsx` (botão "Abrir na
Mensageria Ulbra"). `NotificacoesUlbra.jsx` existe mas **não está montado**
em nenhuma página (polling de 60s estouraria o limite diário).

## Estado em PRODUÇÃO — validado em 07/11/2026

Repositório e produção estão **no mesmo ponto** desde 07/11/2026. Medido no
projeto `ahattpqrjmhkzsmnbdzs`:

| Peça | Produção |
|---|---|
| SQL do vínculo | **aplicada** em 06/11 (`20261106151254`, registrada no ledger) |
| `ulbra-consultar` | **publicada** em 07/11 a partir da main: confirma por CPF, audita, falha fechado; `verify_jwt = true` |
| `ulbra-atendimento` | **publicada** em 07/11 (antes não existia): filtra `confianca = 'alta_cpf'`; `verify_jwt = true` |
| `ulbra-leads-pendentes` | sem alteração |
| view `ulbra_vinculos_confirmados` | proposta `20261106190000`, **não aplicada** |
| `ulbra_vinculos` | **2 linhas**, ambas `alta_cpf` / `origem: cpf`, com `ULBRA_VINCULO_CRIADO` na auditoria |
| secret `ULBRA_MCP_TOKEN` | **cadastrado** em 07/11 — antes disso não existia |

### O que a publicação exigiu além do merge

Duas correções que só apareceram ao exercitar a integração contra a Mensageria
real. As duas foram **medidas**, não inferidas:

1. **`Accept: application/json, text/event-stream` é obrigatório** (PR #849).
   Sem o cabeçalho o endpoint devolve **406**; com ele devolve **200**, e o
   corpo vem em **SSE** (`event: message` + uma linha `data:` com o envelope
   JSON-RPC inteiro), onde `resp.json()` quebra. Daí o `lerCorpoMcp()` nas duas
   funções, que aceita as duas formas e falha fechado em corpo sem `data:`.
2. **A rota do cadastro do cliente é `/app/clientes/<ulbra_cliente_id>`**
   (PR #850). O formato anterior, `/atendimentos/<id>`, devolvia "Not Found":
   faltava o prefixo `/app` **e** punha id de CLIENTE numa rota de ATENDIMENTO,
   que tem id próprio.

Antes dessas duas, a integração **nunca funcionou em produção** — o que explica
`ulbra_vinculos` vazia desde 03/11. Enquanto o secret não existia, toda chamada
parava em `CONFIG_AUSENTE`; depois dele, parava em `406`.

### Validação na ficha real (07/11/2026)

Com usuário de gestão autenticado, na ficha de alunos com CPF:

- o vínculo nasceu `alta_cpf` / `origem: cpf`, com `ULBRA_VINCULO_CRIADO` na
  auditoria e **sem CPF nem telefone nos detalhes** — só qual chave casou;
- num dos dois casos o telefone **não concordou** com o CPF
  (`telefone_concordou: false`). Isso **não bloqueou** nada: o CPF confirmou e
  o vínculo nasceu `alta_cpf` normalmente. O que a regra impediu foi **o
  telefone determinar o vínculo** — na versão anterior o telefone decidia, e o
  selo saía `alta` sem identidade provada.

  **Os dois casos são excludentes por construção**, e vale ler a condição
  exata em `vinculo.ts`:

  ```ts
  if (idTel && idCpf && idTel !== idCpf) -> bloquear AMBIGUO_CHAVES_DISCORDANTES
  ```

  É o **primeiro** portão de `decidirVinculo` depois do vínculo existente, e
  exige as **duas** chaves devolvendo id **dentro do escopo do token** e
  **diferentes** entre si. Nesse caso nada é gravado: `acao: "bloquear"`, sem
  candidato. Logo, **num vínculo que existe, `telefone_concordou: false` nunca
  significa "o telefone apontou outro cliente"** — se apontasse, não haveria
  vínculo. Significa que o telefone **não devolveu id**: não achou ninguém,
  ou achou fora do escopo do token (aí `telefone_fora_do_escopo` vem `true`,
  e fica registrado na auditoria em vez de passar por concordância).

  Em resumo: *telefone sem id* é caso **permitido**, decidido pelo CPF;
  *telefone com id diferente* é **bloqueio**, e não gera vínculo;
- o botão "Abrir na Mensageria Ulbra" abre o **cadastro correto** do cliente;
- numa das fichas **o bloco de atendimento respondeu vazio** (`Sem atendimento
  na Mensageria Ulbra`), já com a função corrigida e com o token de backend;
- noutra ficha, **o bloco veio preenchido**: a mesma função, com o mesmo token
  de backend, devolveu o atendimento do cadastro vinculado — situação, coluna,
  equipe e responsável, conferindo com o que a Mensageria mostra para aquele
  cadastro.

**O teste positivo prova uma coisa só, e convém não esticar:** naquele cadastro
vinculado, o token de backend **leu atendimento**. Não é base para generalizar
alcance de permissão — nada se conclui daqui sobre outras equipes, outros
cadastros ou outros tipos de atendimento.

**A causa da outra consulta vir vazia NÃO está comprovada.** O que o teste
positivo afasta é a explicação "o backend não consegue ler atendimento", já que
ele leu. Resta ausência real de atendimento naquele cadastro, recorte do que
`listar_atendimentos` devolve, ou outra coisa — e só a ULBRA confirma.
Medições feitas pela conexão OAuth de gestão **não servem de prova** para o
token de backend: são credenciais diferentes. **Não registrar como "escopo"
sem essa confirmação.**

### Pendente

- **Rotação da credencial da Mensageria, com a TI da ULBRA.** O valor do token
  havia sido cadastrado no campo **nome** de um secret, e nome de secret é
  legível em texto puro no painel para qualquer pessoa com acesso ao projeto. O
  cadastro malformado foi removido em 07/11 e o `ULBRA_MCP_TOKEN` correto está
  no lugar, mas **o valor esteve exposto e segue válido** até ser trocado.
- **Confirmar com a ULBRA** por que `listar_atendimentos` volta vazia para um
  cliente que existe e tem equipe.
- A view `ulbra_vinculos_confirmados` (`20261106190000`) segue **não aplicada**
  — é defesa em profundidade, não pré-requisito.

## Vínculo aluno ↔ cliente: a regra (corrigida em 04/11/2026)

**Vínculo automático nasce só quando o CPF confirma.** A Etapa 1 (PR #813)
gravava `confianca: 'alta'` cravado, qualquer que fosse a origem — inclusive
quando o cliente vinha de casamento por **telefone**, que é contato e não
identidade (telefone de mãe, de cônjuge, de recado, número reciclado por
operadora). O CPF, única chave de identidade do aluno, só era consultado como
*fallback* quando o telefone faltava.

O que vale agora, em `supabase/functions/ulbra-consultar/vinculo.ts`:

| Situação | Resultado |
|---|---|
| CPF confirma e o telefone concorda | grava, `confianca = 'alta_cpf'`, `origem = 'cpf'` |
| CPF confirma, telefone ausente ou não achou nada | grava (`telefone_concordou: false`) |
| CPF confirma, telefone achou alguém **fora do escopo** do token | grava pelo CPF, com `telefone_fora_do_escopo: true` na auditoria — ver limite abaixo |
| Telefone → cliente A, CPF → cliente B | **bloqueia** `AMBIGUO_CHAVES_DISCORDANTES` — sem desempate |
| CPF confirma, mas o cliente já tem vínculo ativo com outro aluno | **bloqueia** `DUPLICADO_CLIENTE_DE_OUTRO_ALUNO` |
| Só o telefone achou | **bloqueia** `CONFIRMACAO_MANUAL_SO_TELEFONE` |
| Telefone achou e o aluno não tem CPF cadastrado | **bloqueia** `CONFIRMACAO_MANUAL_SEM_CPF` |
| Já existe vínculo ativo **confirmado por CPF** | devolve o existente com `url`; **nunca** sobrescreve |
| Já existe vínculo ativo **sem** confirmação por CPF | `vinculado_nao_confirmado`: **sem `url` e sem `ulbra_cliente_id`** |

**Limite conhecido da detecção de discordância.** Quando o telefone casa com
cliente fora do escopo do token, a Mensageria devolve `equipe` mas **não** o
`cliente.id` (`FORA_DO_ESCOPO`) — então não há com o que comparar o resultado
do CPF. O CPF manda, porque é a chave de identidade, mas isso **não** é
concordância: é impossibilidade de comparar, e fica registrado como
`telefone_fora_do_escopo` na `auditoria`. Um telefone de terceiro atendido por
outra equipe da ULBRA não bloqueia o vínculo por CPF.

Barrado **não grava nada** e o motivo aparece na ficha. Por que barrar em vez
de gravar com confiança baixa: um vínculo fraco gravado como ativo seria, numa
função que só checasse `desvinculado_em`, um atendimento aberto no cliente
errado. A `ulbra-atendimento` (PR #814) filtra `confianca = 'alta_cpf'` desde a
#819, mas a regra não pode depender só dela.

Custo de chamada: **as duas chaves vão na mesma chamada**. `contatos` aceita 20
posições e o limite medido é por chamada, então a confirmação cruzada é de
graça — 1 chamada, igual à Etapa 1. O casamento entre pedido e resposta é pelo
campo `posicao`, nunca pela ordem do array (`interpretarPorChave`): confiar na
ordem de chegada troca o resultado do telefone pelo do CPF sem erro aparecer.

**A numeração de `posicao` em chamada de duas chaves NÃO foi medida** — o
contrato de 04/11/2026 só tem resposta de uma posição, com `posicao: 0`. Por
isso `interpretarPorChave` aceita as duas bases possíveis e só elas: conjunto
`{0..n-1}` (base 0) ou `{1..n}` (base 1). Os dois conjuntos nunca são o mesmo —
base 0 exige a posição `0` presente, base 1 exige que ela não esteja —, então a
base é *determinada* pelo conjunto recebido, não escolhida. Qualquer outro
conjunto — buraco, posição repetida, quantidade diferente da pedida — falha
fechado (`RESPOSTA_INVALIDA`): nenhum vínculo é gravado, nunca o errado.

**Base 1 só é aceita quando o mapeamento não pode mudar a decisão** — mesmo
cliente em todas as posições, ou nenhuma com cliente. O motivo é concreto: se
as posições estiverem trocadas em relação ao pedido, "telefone achou X, CPF não
achou" é lido como "CPF confirmou X, telefone não achou" — e o primeiro
**bloqueia** enquanto o segundo **grava**. Seria o falso positivo exato que
esta correção existe para fechar, produzido por uma convenção que ninguém
mediu. Então base 1 assimétrica falha fechado.

**Base 0 segue aceita com mapeamento assimétrico — e isso é inferência, não
medição.** Tem de ser aceita, senão o caminho principal (só o CPF confirma)
nunca gravaria. O que a sustenta é a semântica documentada de `posicao` como
índice do array `contatos` pedido; o que foi **medido** é `posicao: 0` em
resposta de **uma** posição. Para duas, é extrapolação da documentação.

Resta exatamente um cenário de falso positivo, e ele precisa estar escrito:
se as posições vierem trocadas em base 0, a função lê "CPF→A, telefone→nada" e
**grava**, quando a verdade seria "telefone→A, CPF→nada", que deveria
**bloquear**. O cenário inverso é seguro — produz bloqueio falso, não gravação
falsa. Fechar isso exige a medição com duas posições, que segue pendente e
precisa de autorização da gestão. Até lá, "nenhum resultado duvidoso gera
vínculo" é verdade para tudo que o código consegue detectar como duvidoso, e
**não comprovada** para uma violação da semântica de `posicao` em base 0.

**Vínculo antigo não é apagado nem rebaixado — mas também não dá acesso.**
Linha com `confianca = 'alta'` e `origem = 'telefone'` (selo da Etapa 1)
continua válida e visível para a gestão na tabela, porém a `ulbra-consultar`
devolve `status: 'vinculado_nao_confirmado'` **sem `url` e sem
`ulbra_cliente_id`**, e a ficha mostra só o aviso, sem o botão "Abrir na
Mensageria". Aviso ao lado de um botão clicável não é proteção: enquanto o id
viajar na resposta, qualquer cliente da API remonta a URL do atendimento.
Desvinculação é sempre lógica (`desvinculado_em`).

### Proteção do `ulbra-atendimento` (PR #814, já com a #819)

A `ulbra-atendimento` abre atendimento só com vínculo confirmado por CPF: a
função `vinculoConfirmado` (`supabase/functions/ulbra-atendimento/atendimento.ts`)
filtra `confianca = 'alta_cpf'`, e `index.ts` a chama antes de qualquer consulta.
Essa proteção entrou na main pela #819 (`accb9db2`). Não é alterada aqui.

Ainda assim, a view `public.ulbra_vinculos_confirmados` (proposta
`20261106190000`, **não aplicada** — conferido em 06/11/2026: 0 linhas em
`pg_views`) é a superfície estrutural que o filtro de código não substitui: com
ela, uma função futura que leia `ulbra_vinculos` sem filtrar `confianca` não tem
linha não confirmada para devolver. Ela tem `security_invoker = on`, para não
passar por cima da RLS de `ulbra_vinculos`. **Não é pré-requisito de
publicação** — é defesa em profundidade; o filtro `alta_cpf` da
`ulbra-atendimento` já é a alternativa que esta documentação aceita.

Antes de qualquer republicação da função da Etapa 1, ou de inserção manual de
vínculo, o filtro `alta_cpf` precisa continuar presente em `ulbra-atendimento`.

**E a ordem do deploy importa por causa disso.** A `ulbra-consultar` que está
em produção hoje é a da **#794** (`version 2`, publicada em 03/11 — não a da
Etapa 1/#813, que é de 04/11 e nunca foi publicada): ela grava
`confianca: 'alta'` por telefone.
Se a `ulbra-atendimento` for publicada **antes** da `ulbra-consultar`
corrigida, o filtro `alta_cpf` dela já estaria no ar enquanto a função que
escreve ainda cria vínculo fraco: nada se abriria errado (o filtro barra), mas
o bloco da ficha mostraria "sem atendimento" para vínculos que a função velha
acabou de criar. Publicar a `ulbra-consultar` primeiro evita esse estado
intermediário confuso.

## Pendências

- **Lacuna de inventário, apontada pela auditoria do Guardião em 06/11/2026 e
  NÃO fechada aqui:** `docs/integracoes/prime-edge-functions.md` não lista
  `ulbra-consultar`, `ulbra-atendimento` nem `ulbra-leads-pendentes`, embora a
  regra 2 do [`README.md`](README.md) mande toda Edge Function que toque
  Prime/ULBRA entrar lá **no mesmo commit em que é criada**. A regra dos cinco
  arquivos (`prime-api.md` + `prime-api-catalog.json` +
  `prime-mapa-fontes-verdade.md` + identificadores + gaps) **não** se aplica a
  esta frente: ela vale para descoberta na **API Prime**, e a Mensageria é
  sistema separado, com documento próprio na tabela do `README.md`. O
  inventário das Edge Functions, porém, aplica-se. Não foi corrigido porque
  `prime-edge-functions.md` está fora do escopo declarado desta frente — é
  decisão da gestão abrir ou não essa edição aqui.

- `ulbra_vinculos` nasceu em produção sem migration (PR #794). Conferido em
  04/11/2026: a tabela estava **vazia** (0 linhas, 0 `ULBRA_VINCULO_CRIADO` em
  `auditoria`), então não havia vínculo legado a reclassificar — a proteção é
  estrutural. Em 07/11/2026, depois da publicação, a tabela tem **2 linhas**,
  ambas `alta_cpf` / `origem: cpf`, com auditoria correspondente.
- **As 3 policies de RLS também nasceram sem migration, então não existe
  arquivo neste repositório que as defina.** Ficavam descritas em prosa como
  "todas sob `usuario_e_gestao()`", sem medição. Medidas em produção
  (`ahattpqrjmhkzsmnbdzs`) em 06/11/2026, somente leitura:

  | policy | cmd | roles | predicado |
  |---|---|---|---|
  | `ulbra_vinculos_select` | SELECT | `{authenticated}` | `using usuario_e_gestao()` |
  | `ulbra_vinculos_insert` | INSERT | `{authenticated}` | `check usuario_e_gestao()` |
  | `ulbra_vinculos_update` | UPDATE | `{authenticated}` | `using` + `check usuario_e_gestao()` |

  Nenhuma policy para `anon`, nenhuma permissiva sem predicado. Isso importa
  para a view: com `security_invoker = on` ela **não tem portão próprio**, ela
  herda este. Por isso a proposta `20261106190000` refaz essa medição como
  guarda de pré-condição — se o portão da tabela for afrouxado, a view não é
  criada. **O drift em si continua não corrigido**: as policies seguem só em
  produção, sem migration que as versione.
- **O SQL do vínculo está APLICADO em produção desde 06/11/2026** — isto
  corrige versões anteriores desta documentação, que o davam como pendente. A
  proposta `20261104200000` foi carimbada como `version 20261106151254` e está
  registrada byte a byte em
  `supabase/ledger/2026-11/20261106151254__20261104200000_ulbra_vinculos_confianca_e_unicidade.sql`
  (md5 `a8c591756729edc4d9721028ba02d0cd`, 29.864 bytes, 1 statement), com a
  nota ao lado. Conferido em produção, somente leitura, em 06/11/2026: os dois
  CHECK de `confianca` (com `alta_cpf`) de pé, `ulbra_vinculos_cliente_ativo_uniq`
  e `ulbra_vinculos_aluno_ativo_uniq` presentes e únicos,
  `trg_ulbra_vinculo_protege_historico` ativo, RLS ligada com 3 policies,
  `authenticated` com `SELECT/INSERT/UPDATE` e **sem** DELETE/TRUNCATE,
  `service_role` **sem** TRUNCATE, tabela com **0 linhas** e 0 auditorias
  `ULBRA_*`. A reversa
  (`supabase/aguardando_aprovacao/20261104200000_..._.rollback.sql`) segue
  **não executada**, e o `.sql.pendente` saiu de `aguardando_aprovacao` porque
  não está mais aguardando nada. **Não reaplicar.**
- **Pendente de verdade, e só isso: a view.**
  `supabase/aguardando_aprovacao/20261106190000_ulbra_vinculos_view_confirmados.sql.pendente`
  (+ `.rollback.sql`) traz a view `ulbra_vinculos_confirmados` com
  `security_invoker = on`, extraída inteira da proposta grande — com guarda de
  pré-condição que exige a `20261106151254` aplicada, prova de estrutura e
  prova de comportamento com grupo de controle (mostra `alta_cpf`, esconde
  legado por telefone, esconde desvinculado). Precisa de autorização explícita
  da gestão e **não bloqueia a publicação das Edge Functions**.
- **Medição pendente, precisa de autorização da gestão:** a numeração de
  `posicao` em chamada `conferir_duplicidade` com duas posições. Tratada por
  tolerância às duas bases possíveis, não por medição.
- **Teste de integração existe, mas NÃO é validação completa.**
  `supabase/functions/ulbra-consultar/integracao.test.ts` percorre a cadeia
  envelope JSON-RPC → casamento por posição → validação por CPF → tentativa de
  gravação, com banco falso que recusa como o real recusaria (CHECK de
  `confianca`, unicidade de cliente). **Fica expressamente sem prova:**
  1. `index.ts` não é importado — chama `serve()` e `createClient()` no topo e
     não há Deno nesta máquina. Códigos HTTP e ordem real das auditorias seguem
     provados só por leitura; a cadeia é reconstruída pelo teste, não executada
     a partir do `index.ts`.
  2. Nenhuma chamada real à Mensageria. Os envelopes são fixtures na forma
     medida em 04/11/2026.
  3. Nenhuma escrita real no Postgres. As recusas do banco são imitadas. Que o
     banco real as aplique é o que as seções 4 e 5 da `20261106151254` provaram
     **na própria aplicação, em produção, em 06/11/2026** — as asserções de
     comportamento (UPDATE, DELETE, reabertura e unicidade barrados de fato,
     com grupo de controle e linhas de prova desfeitas) rodaram dentro da
     transação que aplicou a migration. O que o teste imita, o banco já provou;
     o que segue sem prova é a cadeia a partir do `index.ts`.

  Ninguém deve declarar a integração validada com base só neste arquivo.
- **Ordem obrigatória de publicação — já satisfeita.** O SQL tinha de vir
  **antes** do deploy da `ulbra-consultar` corrigida, porque a função grava
  `alta_cpf`, valor que o CHECK antigo rejeitava; na ordem errada todo vínculo
  novo falharia com `VINCULO_NAO_GRAVADO` (falha fechado — não grava errado, só
  não grava). Em 06/11/2026 o CHECK novo está em produção, então **o deploy
  pode ir a qualquer momento** e essa armadilha deixou de existir.
- Teste de contrato: `supabase/functions/ulbra-consultar/contrato.test.ts`,
  `vinculo.test.ts` e `ulbra-leads-pendentes/portao.test.ts` carregam a forma
  real das respostas — se a Mensageria mudar a forma, é aí que quebra.

## Sequência de publicação — EXECUTADA em 07/11/2026

> **Esta sequência foi cumprida em 07/11/2026.** Os passos 1 a 3 estão feitos
> (secret cadastrado, `ulbra-consultar` e `ulbra-atendimento` publicadas) e o
> passo 5 foi validado em ficha real — ver "Estado em PRODUÇÃO" no topo. O
> passo 4 (frontend) não foi necessário: a tela já estava publicada. O passo 6
> (view) segue pendente, por autorização própria. O texto abaixo fica como
> registro do que foi executado e em que ordem.

Nada abaixo foi executado. Cada passo exige autorização explícita da gestão e
executor único — a sessão principal. O SQL do vínculo **já está aplicado**,
então esta sequência é de deploy, não de banco.

1. **Merge da #821 na main.** Sem isso o deploy publicaria o código antigo.
2. **Publicar `ulbra-consultar`** (`supabase/functions/ulbra-consultar/`:
   `index.ts`, `vinculo.ts`, `mcp.ts`, `portao.ts`). É o passo que encerra o
   vínculo por telefone — enquanto ele não roda, nada mudou para o operador.
   Conferir depois: `version` subiu de 2, e o fonte publicado importa
   `vinculo.ts`.
3. **Publicar `ulbra-atendimento`** (`index.ts`, `atendimento.ts`). Depois da
   `ulbra-consultar`, pelo motivo da seção anterior. Hoje a função **não
   existe** em produção e a ficha já a chama.
4. **Publicar o frontend** (`BlocoUlbra.jsx` com a recusa do botão). A tela sem
   a função nova mostraria o botão para vínculo não confirmado; a função nova
   sem a tela já é segura (o `ulbra_cliente_id` não viaja).
5. **Validar com um aluno real da carteira de quem valida**, lendo a
   `auditoria`: tem de aparecer `ULBRA_CONSULTA` e, conforme o caso,
   `ULBRA_VINCULO_CRIADO` (com `confianca = 'alta_cpf'`) **ou**
   `ULBRA_VINCULO_BLOQUEADO` com o motivo. Vínculo gravado com
   `origem = 'telefone'` depois do deploy é regressão: parar e reverter.
6. **Opcional, autorização própria:** a view
   `20261106190000_ulbra_vinculos_view_confirmados.sql.pendente`. Não bloqueia
   nada acima.
7. **Fora desta frente, e não resolvido aqui:** medir a numeração de `posicao`
   com duas chaves, e o `NotificacoesUlbra`, que segue desmontado de propósito.

**Reversão**: o deploy volta republicando a versão anterior da função — não há
dado a desfazer, porque a função corrigida só grava `alta_cpf` e vínculo não se
apaga (gatilho da `20261106151254`). A reversa do SQL existe e **não** deve ser
usada para desfazer deploy.
