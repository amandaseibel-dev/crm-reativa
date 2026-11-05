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
| Já existe vínculo ativo | devolve o existente; **nunca** sobrescreve |

**Limite conhecido da detecção de discordância.** Quando o telefone casa com
cliente fora do escopo do token, a Mensageria devolve `equipe` mas **não** o
`cliente.id` (`FORA_DO_ESCOPO`) — então não há com o que comparar o resultado
do CPF. O CPF manda, porque é a chave de identidade, mas isso **não** é
concordância: é impossibilidade de comparar, e fica registrado como
`telefone_fora_do_escopo` na `auditoria`. Um telefone de terceiro atendido por
outra equipe da ULBRA não bloqueia o vínculo por CPF.

Barrado **não grava nada** e o motivo aparece na ficha. Por que barrar em vez
de gravar com confiança baixa: `ulbra-atendimento` (PR #814) abre atendimento
para qualquer vínculo ativo, **sem ler `confianca`** — um vínculo fraco gravado
como ativo seria, uma função adiante, um atendimento aberto no cliente errado.

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

**Vínculo antigo não é apagado nem rebaixado.** Linha com `confianca = 'alta'`
e `origem = 'telefone'` (selo da Etapa 1) continua válida e clicável, mas vem
com `reconfirmar_recomendado: true` e a ficha avisa que a identidade não foi
provada por CPF. Desvinculação é sempre lógica (`desvinculado_em`).

## Pendências

- `ulbra_vinculos` nasceu em produção sem migration (PR #794). Conferido em
  04/11/2026: a tabela está **vazia** (0 linhas, 0 `ULBRA_VINCULO_CRIADO` em
  `auditoria`), então não há vínculo legado a reclassificar — a proteção é
  estrutural.
- **Proposta SQL não aplicada**, em
  `supabase/aguardando_aprovacao/20261104200000_ulbra_vinculos_confianca_e_unicidade.sql.pendente`
  (+ `.rollback.sql`): backup de estrutura e dados (§13), CHECK de `confianca`
  com `alta_cpf`/`reconfirmar`, índice único de **cliente ativo** (hoje a
  unicidade só existe do lado do aluno), trigger de
  imutabilidade/não-reabertura com `REVOKE EXECUTE`, e o REVOKE de
  DELETE/TRUNCATE de `authenticated` proposto na Etapa 1 — escrito como SQL
  pela primeira vez aqui. As provas incluem comportamento (UPDATE, DELETE,
  reabertura e unicidade barrados de fato, com grupo de controle e ROLLBACK),
  não apenas existência dos objetos.
- **Medição pendente, precisa de autorização da gestão:** a numeração de
  `posicao` em chamada `conferir_duplicidade` com duas posições. Tratada por
  tolerância às duas bases possíveis, não por medição.
- **`index.ts` da `ulbra-consultar` não tem teste automatizado** (não há Deno
  nesta máquina). A regra toda está em `vinculo.ts` e `mcp.ts`, que têm; o que
  fica sem prova automática é a fiação: códigos HTTP e ordem das auditorias.
- **Ordem obrigatória de publicação:** o SQL **antes** do deploy da
  `ulbra-consultar` corrigida. A função grava `alta_cpf`, valor que o CHECK de
  hoje rejeita; na ordem errada todo vínculo novo falha com
  `VINCULO_NAO_GRAVADO` (falha fechado — não grava errado, só não grava).
- Teste de contrato: `supabase/functions/ulbra-consultar/contrato.test.ts`,
  `vinculo.test.ts` e `ulbra-leads-pendentes/portao.test.ts` carregam a forma
  real das respostas — se a Mensageria mudar a forma, é aí que quebra.
