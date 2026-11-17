# Piloto com token pessoal da Mensageria (17/11/2026)

Alternativa ao OAuth, enquanto o `client_id` do ReATIVA não existe na Mensageria.
Escopo: **só a conta da gestora**, para leitura e resposta pela ficha. Sem implantação,
sem envio real e sem alterar o OAuth existente, que fica para evolução posterior.

## O que foi implementado (branch da #913, sem deploy)

- `supabase/functions/ulbra-conversa/token-pessoal.ts`: regra pura de cadastro.
  1. formato do token e validade (7, 30, 60 ou 90 dias);
  2. `meu_acesso` com o próprio token; a pessoa dona do token precisa ser o usuário
     logado (e-mail comparado sem maiúsculas, nunca pelo nome);
  3. só então grava, cifrado, sem `refresh_token`, com validade fixa.
- `index.ts`, ação `conexao_token_pessoal`: auditoria `ULBRA_CONEXAO_TOKEN_PESSOAL`
  **antes** de gravar; se a auditoria falhar, nada é guardado. A resposta não traz o token.
- `index.ts`, `conexao_desconectar`: para token pessoal, apaga a cópia local e **não**
  afirma revogação no provedor. Devolve `revogacao_manual_necessaria`.
- Configuração: envio, leitura e conexão de token pessoal exigem só `ULBRA_TOKENS_CHAVE`.
  `ULBRA_OAUTH_CLIENT_ID` e `ULBRA_OAUTH_REDIRECT_URI` deixam de bloquear essas ações.
  O OAuth (iniciar e concluir) continua exigindo as duas.
- Tela: `src/components/ConexaoTokenPessoal.jsx`, dentro do bloco de conexão da Central,
  com a mesma trava da Central (só aparece com a função respondendo).
  - campo de senha, `autocomplete=off`;
  - o valor fica só no estado do componente e é apagado em **qualquer** desfecho;
  - nada vai para `localStorage`, `sessionStorage` ou URL (há teste que prova).

## Como cadastrar o token (passo a passo, pela interface)

1. Na Mensageria, abra **MCP › Tokens pessoais** e clique em **Criar token**.
2. Nome: `reativa-piloto`.
3. Permissões (marque só estas; **não** marque campanhas, gestão, transferência, tickets ou operadores):
   - ver clientes
   - ver atendimentos
   - ler as conversas com os clientes
   - enviar mensagens e templates aos clientes dos seus atendimentos
4. Validade: **30 dias**.
5. Copie o token **uma vez**, ao final da criação.
6. No ReATIVA, abra a Central de Conversas, bloco de conexão, cole o token no campo
   "Token pessoal da Mensageria", escolha 30 dias e clique em **Cadastrar token**.
7. O campo é limpo logo após a resposta. Se a Mensageria recusar ou a conta não for a sua,
   a tela explica o motivo e nada é guardado.

Não envie o token por chat, e-mail ou commit.

## Escopos: o que é hipótese e o que falta comprovar

- Os quatro escopos acima são o **mínimo declarado** para leitura e resposta.
- Hipótese **não testada**: que "ver clientes" e "ver atendimentos" sejam necessários para
  ler a conversa. Se a leitura falhar com essa combinação, o teste real diz qual falta.
- A **autoria** (mensagem sair com o nome da dona do token) vem da descrição da ferramenta
  `enviar_mensagem_whatsapp`. **Não comprovada** até um envio real controlado.

## Expiração, desconexão e revogação: o que é comprovado

| Situação | Comportamento no CRM | Estado |
|---|---|---|
| Token vencido | Estado `EXPIRADA`; envio e leitura bloqueados (`conexao.ts`, sem refresh) | código e testes |
| Desconectar no CRM | Apaga a cópia cifrada; **não** revoga na Mensageria | código; revogação manual |
| Revogar na Mensageria | Chamadas com o token passam a responder 401/403; `chamarComoOperador` lança `ULBRA_AUTENTICACAO`, e leitura/envio não concluem (não há reconexão automática) | a confirmar no teste real |

Para revogar de fato: **MCP › Tokens pessoais › Revogar**, na Mensageria.

## Consumidores do `ULBRA_MCP_TOKEN` atual (inventário, sem valor do segredo)

O token atual é um **token pessoal da gestora** (aparece na aba Tokens pessoais com o nome
`ULBRA_MCP_TOKEN`, criado em 07/11/2026, vence em 07/12/2026). Lido por:

| Função | Arquivo | Uso |
|---|---|---|
| `ulbra-atendimento` | `supabase/functions/ulbra-atendimento/index.ts` | leitura da fila |
| `ulbra-consultar` | `supabase/functions/ulbra-consultar/index.ts` | identidade por CPF/telefone |
| `ulbra-diagnostico` | `supabase/functions/ulbra-diagnostico/index.ts` | diagnóstico (gestão) |
| `ulbra-leads-pendentes` | `supabase/functions/ulbra-leads-pendentes/index.ts` | leads pendentes |
| `ulbra-sincronizar` | `supabase/functions/ulbra-sincronizar/index.ts` | sincronização |
| `ulbra-historico` (v1) | preservada em `docs/integracoes/preservacao-ulbra-historico-v1-producao/`; **ativa em produção** | histórico com credencial central |

A `ulbra-conversa` (novo) **não** lê esse token para envio nem leitura individual.

## Evidência da exposição de 07/11

Registro em `docs/integracoes/mensageria-ulbra.md` (seção de credencial): o valor foi
cadastrado no **campo de nome** de um secret, legível em texto puro no painel para quem tem
acesso ao projeto. O cadastro malformado foi removido em 07/11, e o valor correto está no
lugar, mas **o valor exposto segue válido até ser trocado**. Este pacote não reproduz o valor.

## Rotação (não executada nesta etapa)

1. Criar o token de substituição na Mensageria (escopos mínimos, com a gestora).
2. Migrar as cinco funções e a `ulbra-historico` v1 para o novo valor, **ou** desligar a v1
   (contenção já autorizada).
3. Revogar o token antigo na aba Tokens pessoais.
4. Conferir que nenhuma função ainda lê o valor antigo.

Não revogar nem substituir sem sua decisão específica.

## Pré-condições para testar o piloto

- `ULBRA_TOKENS_CHAVE` configurada no ambiente da função `ulbra-conversa` (já prevista no pacote).
- Flags seguem desligadas até a decisão: `ULBRA_ENVIO_REAL`, `ULBRA_CONTRATO_PREVIA_CONFIRMADO`,
  `ULBRA_HISTORICO_HABILITADO`, `HISTORICO_DISPONIVEL`.
- Contenção da v1 `ulbra-historico` (autorizada; pendente de execução).
- Migrations `20261111140000` e `20261116150000` pendentes de aplicação com aprovação.

## Testes

- `token-pessoal.test.ts`: 9 casos (token próprio grava sem devolver o valor; divergência
  de e-mail não grava; Mensageria recusa; indisponível; formato e validade; expiração).
- `ConexaoTokenPessoal.test.jsx`: 6 casos (campo protegido; apaga o valor em sucesso e em
  erro; mensagens; nada em storage).
- Suítes existentes de `ulbra-conversa`, `CentralConversas` e `CentralUlbra`: passam.

Rodado localmente com vitest. O Deno do `ulbra-conversa` roda só no CI.

## Limitações declaradas

- **Conexão OAuth sem `refresh_token`** é tratada como "pessoal" em `conexao_desconectar`
  (`refresh_token === null`). Para ela, o CRM apaga a cópia local e pede revogação manual,
  sem chamar o provedor. Não há coluna de tipo na tabela (criar uma exige migration, não feita).
- **Sem `ULBRA_OAUTH_CLIENT_ID`**, a renovação OAuth falha e a conexão vira `EXPIRADA`
  (fail-closed). Antes, a ação devolvia 503 `CONEXAO_NAO_CONFIGURADA`; agora o erro sai pela
  renovação. Isso é mudança de comportamento e está declarada aqui.
- **Auditoria antes da gravação:** se a gravação falhar depois da auditoria, a auditoria
  registra uma tentativa que não se concretizou. Preferível a gravar sem auditoria.
- **Correção desta revisão:** `chamarComoOperador` devolve o resultado da ferramenta, sem
  envelope `{dados}`. Os pontos de identidade (`conexao_concluir` e token pessoal) e o wiring
  de leitura do histórico estavam lendo `undefined`, o que faria a identidade falhar sempre
  e o histórico voltar vazio. Corrigido nesta revisão, com a identidade ainda protegida por
  `pessoa_email` exato.

## O que continua não comprovado

- Autoria real da mensagem e permissões mínimas: só com envio real controlado, aprovado.
- Comportamento do token revogado na Mensageria: só com teste real.
- Leitura real da conversa com o token pessoal: só com o token criado por você.
