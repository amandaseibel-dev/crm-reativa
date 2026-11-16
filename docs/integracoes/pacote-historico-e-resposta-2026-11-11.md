# Pacote — histórico e resposta pela Central ULBRA, com autoria individual (para revisão)

Preparado em 11/11/2026. **Nenhuma mensagem enviada, nenhuma credencial alterada, nada publicado nem aplicado.** Frente separada do pacote de 12/11 (#904), que fica intocado.

## 1. O mecanismo real de conexão individual (lido do servidor da Mensageria, sem credencial)
- `GET https://crm.ulbra.ai/.well-known/oauth-protected-resource` → o recurso MCP aponta o servidor de autorização `https://crm.ulbra.ai/api/oauth` e lista os escopos (entre eles `conversas:read`, `mensagens:enviar`, `atendimentos:read`).
- `GET https://crm.ulbra.ai/.well-known/oauth-authorization-server/api/oauth` → **OAuth 2.1 padrão**: `authorization_code` + `refresh_token`, **PKCE S256**, `token_endpoint_auth_methods_supported: ["none"]` (**cliente público**, sem segredo), endpoint de revogação. **Não há `registration_endpoint`** (registro dinâmico de cliente não é anunciado).
- `POST /api/mcp` sem credencial → 401 com `WWW-Authenticate: Bearer ... resource_metadata=...` (conforme a especificação MCP).

**Conclusão — o que de fato depende da TI da ULBRA:** só **um `client_id` registrado para o ReATIVA com a `redirect_uri`** `https://crm-reativa.vercel.app/ulbra/conectado` (e uma de desenvolvimento, se quiserem). Tudo o mais é padrão e já está implementado: o operador autoriza **na tela da própria Mensageria**, com a conta dele; o ReATIVA recebe o código, troca pelo token com PKCE e guarda os tokens **cifrados**. Nenhum bloqueio presumido além desse registro.

## 2. O que a entrega faz (menor conjunto integrado)
**Histórico (leitura, credencial de backend, só leitura):**
- Leitura do histórico: ação `historico_ler` da Edge Function `ulbra-conversa`, com a **conexão individual do operador** (nunca a credencial central). Cada leitura gera `ULBRA_HISTORICO_LEITURA` na `auditoria`, sem texto de conversa. Desligada por padrão no backend (`ULBRA_HISTORICO_HABILITADO`). A função `ulbra-historico` saiu deste pacote. A versão 1 segue ATIVA em produção: a contenção está BLOQUEADA POR ACESSO (instrução na seção de deploy).
**Resposta (envio, token DO OPERADOR, nunca a credencial central):**
- Edge Function `ulbra-conversa` (nova; `conexao.ts`, `envio.ts`, `oauth.ts`, `cripto.ts` testados sem rede). Ações: `conexao_iniciar` (PKCE + state, URL de autorização), `conexao_concluir` (troca do código, cifra AES-256-GCM, **1 `meu_acesso` da cota do operador para gravar quem é a pessoa e os escopos**), `conexao_estado`, `conexao_desconectar` (revogação no provedor + local), `envio_previa`, `envio_confirmar`.
- **Permissões** (lidas do banco no momento): identidade confirmada por CPF, operador é dono da carteira **ou** responsável do atendimento. Leitura global fechada até confirmação específica da gestão (ver seção abaixo).seibel@aelbra.com.br` e `cobranca04@aelbra.com.br` (A3); Amanda ADM, supervisor e administrativo leem apenas a própria carteira. Conexão própria ativa e identidade da conta conferida com o JWT (A2).
- **Duas etapas na tela:** prévia local e registrada no servidor (não há custo nem janela comprovados pelo provedor; nada é inventado). Só então "Confirmar envio" com **chave idempotente**; a mesma chave com outro texto é recusada (A5). Sucesso só com contrato de sucesso comprovado; até lá todo resultado de envio é FALHA_INCERTA (A6).
- Registro: `ulbra_envios` (status e id da mensagem quando houver, sem tratar o id como prova) e linha `ULBRA_ENVIO` na `auditoria`.
- Página `/ulbra/conectado` (retorno do OAuth) — só entrega `code`/`state` à função; nenhum token passa pela tela.

## 3. Banco (migrations)

> **Correção (revisão do Guardião, 16/11):** a `20261110100000_ulbra_historico_orcamento` está APLICADA em produção (ledger, versão `20261112111006`), sem o portão interno do A8. A versão com o portão está só no `.sql.pendente` e não foi autorizada para aplicação. A `20261111140000` NÃO está aplicada.
| Arquivo | sha256 `.sql.pendente` | rollback |
| --- | --- | --- |
| `20261110100000_ulbra_historico_orcamento` (tabela de uso diário + `ulbra_historico_reservar`, só service_role; portão interno exige service_role — A8) | pendente `544cdb0e55f40f6f3fff0993d7abeb3e50b220485ab110382103e14ac8842da3` | rollback `1aa486a119b5fe86e2fc8b304308ff1f784b22db9094946e52ecd775cd18b801` |
| `20261111140000_ulbra_conexao_individual_e_envio` (pedidos PKCE, conexões com tokens cifrados + pessoa/escopos, envios; RLS sem política para authenticated/anon; só service_role) — substitui a proposta 20261109170000, nunca aplicada | pendente `fcd270305358c69db33e25072c1c0288fd0cbf7dc129bd1b6147fef1dbb6e691`, rollback `f6b8013e8c43ff2f917dbf8839ac103b93e53c991b299b1cd1bc83e09d8e760f` | `f6b8013e8c43ff2f917dbf8839ac103b93e53c991b299b1cd1bc83e09d8e760f` |

## 4. Segredos e configuração (a criar pela gestão no deploy; nenhum criado agora)
- `ULBRA_OAUTH_CLIENT_ID` — **vem da TI da ULBRA**.
- `ULBRA_OAUTH_REDIRECT_URI` — `https://crm-reativa.vercel.app/ulbra/conectado` (igual ao registrado).
- `ULBRA_TOKENS_CHAVE` — 64 hex (32 bytes) gerados fora do banco; cifra os tokens em repouso. Sem ela, a função responde `CONEXAO_NAO_CONFIGURADA` e nada funciona.
- `ULBRA_ENVIO_REAL` — ausente/`false` por padrão: só prévia; `true` só após o roteiro do primeiro envio real (`docs/integracoes/roteiro-envio-real-ulbra.md`).
- `ULBRA_MCP_TOKEN` (já existe) — usado **só** pelo histórico (leitura).

## 5. Custos por ação (cota de 500/dia por pessoa)
| Ação | Quem paga | Chamadas |
| --- | --- | --- |
| Carregar histórico / anteriores | credencial de backend | 1 por página (+1 `meu_acesso` se a medida do saldo venceu) |
| Conectar a conta | operador | 1 (`meu_acesso`, prova de autoria) |
| Ver prévia | operador | 1 |
| Confirmar envio | operador | 1 |
| Renovar/revogar token | — | 0 (servidor OAuth, não é o MCP) |

## 6. Testes (sem rede)
- Lógica: `oauth.test.ts` (PKCE, URL, troca/renovação/revogação com fetch simulado, retorno do navegador), `cripto` (AES-GCM), `conexao.test.ts` (11), `envio.test.ts` (20), `leitura.test.ts` (10), `historico.test.ts` (18).
- Tela: `ulbraConversaCliente.test.js` (chamadas com JWT, mapeamento, prévia), `ConversaUlbra.test.jsx` (duas etapas, idempotência, falha incerta, bloqueio), `UlbraConectado.test.jsx`, `CentralUlbra.test.jsx` (histórico só com clique, conectar abre a URL, prévia → confirmação com chave, carteira interna sem histórico/envio), `CentralConversas.test.jsx`.
- CI: `deno check` das duas funções novas (jobs adicionados).
- **Não provado:** forma exata das respostas de `meu_acesso`/`enviar_mensagem_whatsapp` (campos de custo/janela/id); a função trata ausências sem inventar valores e a prévia mostra "não informado".

## 7. Ordem após aprovação (cada passo com a sua autorização)
1. TI da ULBRA: `client_id` + `redirect_uri` registrados (único item externo).
2. Merge desta PR (deploy da tela; sem função publicada a Central mostra "função indisponível"/"conexão não configurada").
3. M1 + `apply_migration` de `20261110100000` e `20261111140000`; conferir grants (só service_role) e `search_path`.
4. Segredos `ULBRA_OAUTH_CLIENT_ID`, `ULBRA_OAUTH_REDIRECT_URI`, `ULBRA_TOKENS_CHAVE` (gestão, fora de transcript); publicar `ulbra-conversa` (verify_jwt ligado). `ULBRA_HISTORICO_HABILITADO` fica ausente (leitura desligada) até decisão da gestão. A `ulbra-historico` não entra neste pacote.
5. Validação de leitura com a gestão e com um operador (histórico de 1 conversa: 1 chamada).
6. Conexão de 1 operador piloto (1 `meu_acesso` da cota dele) e **prévia** de uma resposta (1 chamada) — sem `ULBRA_ENVIO_REAL`.
7. Primeiro envio real só pelo roteiro aprovado (destinatário interno, texto fixo, 1 mensagem, autoria conferida na Mensageria), ligando `ULBRA_ENVIO_REAL=true` para a janela e desligando depois, até decisão de liberação.

## 8. Fora deste pacote
Campanhas, criação de atendimentos, transferências, administração de operadores (ver `mensageria-ulbra-capacidades-mcp-2026-11-11.md`); coleta automática; o pacote de 12/11.

## Leitura global do histórico (decisão da gestão, 16/11)
- Alcance: `amanda.seibel@aelbra.com.br` (gestão) e `cobranca04@aelbra.com.br` (supervisão, Fernanda): leitura global. Só leitura.
- `cobranca07@aelbra.com.br` (Amanda ADM) e demais operadores: somente carteira ou responsabilidade.
- Regra: `temLeituraGlobal` em `supabase/functions/ulbra-conversa/leitura.ts`. E-mail exato do JWT (sem prefixo), usuário ativo obrigatório, não reutiliza `usuario_e_gestao()`.
- Não amplia envio, transferência ou atuação. A conexão individual continua obrigatória; a leitura global não usa credencial central.

## Migration corretiva 20261116150000 (NÃO aplicada)
- Acesso de service_role: a função é chamada com papel `service_role` no JWT (`request.jwt.claims`), como o PostgREST faz com a chave de serviço. O teste reproduz esse contexto.
- Rollback: restaura a versão de 20261112111006 (sem portão). **Não é recuperação automática.** Use só com aprovação específica e comprovação do motivo.
- Alternativa segura em caso de falha: manter o histórico desativado no backend (`ULBRA_HISTORICO_HABILITADO` ausente) e não chamar a RPC. A RPC não é chamada por nenhum código da branch.
- Pré-condição do rollback: a v1 de `ulbra-historico` precisa estar contida em produção; senão a exposição já existe por outro caminho.

## Migrations: estado correto (revisão 16/11)
- `20261110100000_ulbra_historico_orcamento`: APLICADA em produção (ledger 20261112111006). O `.sql.pendente` foi restaurado ao original (sha 163f3b55…); não é a versão aplicada nem deve ser reaplicado.
- `20261116150000_ulbra_historico_reservar_portao_interno`: CORRETIVA, NÃO aplicada. `.sql.pendente` e `.rollback.sql` no diretório aguardando_aprovacao.
- A exposição da RPC em produção NÃO foi comprovada: o ledger já revoga EXECUTE de public/anon/authenticated. A corretiva é defesa em profundidade.
