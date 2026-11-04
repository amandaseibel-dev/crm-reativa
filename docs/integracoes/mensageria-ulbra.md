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
| `ulbra-consultar` | `conferir_duplicidade` (1 chamada) | JWT + usuário ativo; operador só aluno da própria carteira; grava `ulbra_vinculos` e `auditoria` (`ULBRA_CONSULTA`, `ULBRA_VINCULO_CRIADO`) |
| `ulbra-leads-pendentes` | `listar_atendimentos {situacao:"waiting"}` | JWT; `receptivo` da própria linha ou `usuario_e_gestao()`; filtra equipe `"Reativa"`; devolve só id, nome, data |

Componente da ficha: `src/components/BlocoUlbra.jsx` (botão "Abrir na
Mensageria Ulbra"). `NotificacoesUlbra.jsx` existe mas **não está montado**
em nenhuma página (polling de 60s estouraria o limite diário).

## Pendências

- `ulbra_vinculos` nasceu em produção sem migration (PR #794); REVOKE de
  DELETE/TRUNCATE de `authenticated` proposto na PR da Etapa 1, não aplicado.
- Teste de contrato: `supabase/functions/ulbra-consultar/contrato.test.ts` e
  `ulbra-leads-pendentes/portao.test.ts` carregam a forma real das respostas —
  se a Mensageria mudar a forma, é aí que quebra.
