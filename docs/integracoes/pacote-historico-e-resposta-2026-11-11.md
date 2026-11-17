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
- **Permissões** (lidas do banco no momento): identidade confirmada por CPF; operador é dono da carteira **ou** responsável do atendimento. Leitura global: `amanda.seibel@aelbra.com.br` e `cobranca04@aelbra.com.br` (definição da gestão, 16/11, só leitura); `cobranca07` (Amanda ADM) e os demais só a própria carteira/responsabilidade (A3). Conexão própria ativa; a conta conectada precisa ser a do JWT (A2).
- **Duas etapas na tela:** prévia local e registrada no servidor (não há custo nem janela comprovados pelo provedor; nada é inventado). Só então "Confirmar envio" com **chave idempotente**; a mesma chave com outro texto é recusada (A5). Sucesso só com contrato de sucesso comprovado; até lá todo resultado de envio é FALHA_INCERTA (A6).
- Registro: `ulbra_envios` (status e id da mensagem quando houver, sem tratar o id como prova) e linha `ULBRA_ENVIO` na `auditoria`.
- Página `/ulbra/conectado` (retorno do OAuth) — só entrega `code`/`state` à função; nenhum token passa pela tela.

## 3. Banco (migrations)

> **Estado das migrations (16/11):** a `20261110100000_ulbra_historico_orcamento` está APLICADA em produção (ledger, versão `20261112111006`), SEM o portão interno. O `.sql.pendente` desta migration está no original (sha `163f3b55…`); não deve ser reaplicado. O portão está só na corretiva `20261116150000` (NÃO aplicada).
| Arquivo | sha256 `.sql.pendente` | rollback |
| --- | --- | --- |
| `20261110100000_ulbra_historico_orcamento` (aplicada em produção, versão 20261112111006; tabela de uso diário + `ulbra_historico_reservar`) | pendente (original, não reaplicar) `163f3b551bd62f18dca519310b76e0cb58d78f4235bde7cff7ff7210bc82622b` | rollback `1aa486a119b5fe86e2fc8b304308ff1f784b22db9094946e52ecd775cd18b801` |
| `20261111140000_ulbra_conexao_individual_e_envio` (pedidos PKCE, conexões com tokens cifrados + pessoa/escopos, envios; RLS sem política para authenticated/anon; só service_role) — substitui a proposta 20261109170000, nunca aplicada | pendente `fcd270305358c69db33e25072c1c0288fd0cbf7dc129bd1b6147fef1dbb6e691`, rollback `f6b8013e8c43ff2f917dbf8839ac103b93e53c991b299b1cd1bc83e09d8e760f` | `f6b8013e8c43ff2f917dbf8839ac103b93e53c991b299b1cd1bc83e09d8e760f` |

## 4. Segredos e configuração (a criar pela gestão no deploy; nenhum criado agora)
- `ULBRA_OAUTH_CLIENT_ID` — **vem da TI da ULBRA**.
- `ULBRA_OAUTH_REDIRECT_URI` — `https://crm-reativa.vercel.app/ulbra/conectado` (igual ao registrado).
- `ULBRA_TOKENS_CHAVE` — 64 hex (32 bytes) gerados fora do banco; cifra os tokens em repouso. Sem ela, a função responde `CONEXAO_NAO_CONFIGURADA` e nada funciona.
- `ULBRA_ENVIO_REAL` — ausente/`false` por padrão: só prévia; `true` só após o roteiro do primeiro envio real (`docs/integracoes/roteiro-envio-real-ulbra.md`).
- `ULBRA_CONTRATO_PREVIA_CONFIRMADO` — também obrigatório: o envio real exige as DUAS chaves (`ulbra-conversa/index.ts:85-87`). Sem o contrato da prévia confirmado, nenhum envio sai.
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
- Lógica: `oauth.test.ts` (PKCE, URL, troca/renovação/revogação com fetch simulado, retorno do navegador), `cripto` (AES-GCM), `conexao.test.ts` (11), `envio.test.ts` (45), `leitura.test.ts` (17). Não há mais `historico.test.ts`: a função `ulbra-historico` foi removida do repositório.
- Tela: `ulbraConversaCliente.test.js` (chamadas com JWT, mapeamento, prévia), `ConversaUlbra.test.jsx` (duas etapas, idempotência, falha incerta, bloqueio), `UlbraConectado.test.jsx`, `CentralUlbra.test.jsx` (histórico só com clique, conectar abre a URL, prévia → confirmação com chave, carteira interna sem histórico/envio), `CentralConversas.test.jsx`.
- CI: `deno check` de `ulbra-conversa` (job `ulbra-conversa-deno-check`); `ulbra-historico` foi removida do repositório e não tem job. Teste de acesso da RPC: job `ulbra-historico-portao-pglite` (npm ci + run.mjs).
- **Não provado:** forma exata das respostas de `meu_acesso`/`enviar_mensagem_whatsapp` (campos de custo/janela/id); a função trata ausências sem inventar valores e a prévia mostra "validade não informada" (custo não exibido).

## 7. Ordem após aprovação (cada passo com a sua autorização)
1. TI da ULBRA: `client_id` + `redirect_uri` registrados (único item externo).
2. Merge desta PR (deploy da tela; sem função publicada a Central mostra "função indisponível"/"conexão não configurada").
0. CONTENÇÃO da v1 `ulbra-historico` (pré-condição de TODOS os passos abaixo; o merge não ocorre antes).
3. NÃO reaplicar `20261110100000` (já aplicada, versão 20261112111006). Aplicação de `20261111140000` e da corretiva `20261116150000`, cada uma com aprovação específica; conferir grants (só service_role) e `search_path`.
4. Segredos `ULBRA_OAUTH_CLIENT_ID`, `ULBRA_OAUTH_REDIRECT_URI`, `ULBRA_TOKENS_CHAVE` (gestão, fora de transcript); publicar `ulbra-conversa` (verify_jwt ligado). `ULBRA_HISTORICO_HABILITADO` fica ausente (leitura desligada) até decisão da gestão. A `ulbra-historico` não entra neste pacote.
5. Validação de leitura com a gestão e com um operador (histórico de 1 conversa: 1 chamada).
6. Conexão de 1 operador piloto (1 `meu_acesso` da cota dele) e **prévia** de uma resposta (1 chamada) — sem `ULBRA_ENVIO_REAL`.
7. Pré-condição (antes de QUALQUER passo acima, inclusive merge e publicação): contenção da v1 `ulbra-historico` verificada (função ausente e endpoint indisponível). Primeiro envio real só pelo roteiro aprovado (destinatário interno, texto fixo, 1 mensagem, autoria conferida na Mensageria), ligando `ULBRA_ENVIO_REAL=true` para a janela e desligando depois, até decisão de liberação.

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
- Alternativa segura em caso de falha: manter o histórico desativado no backend (`ULBRA_HISTORICO_HABILITADO` ausente). Nenhum código em `supabase/functions` da branch chama a RPC; a v1 publicada em produção, preservada em `docs/integracoes/preservacao-ulbra-historico-v1-producao/`, chama (com service_role), por isso a v1 precisa estar contida.
- Pré-condição do rollback: a v1 de `ulbra-historico` precisa estar contida em produção; senão a exposição já existe por outro caminho.
- A2 (texto exato): divergência de identidade BLOQUEIA a conexão (com revogação do token de acesso no provedor), a leitura e o envio (sem revogação). A revogação por divergência existe só na conexão.
- A9 (ilike sem escape em `ulbra-historico`) não é item separado: resolvido pela remoção da função do repositório. A v1 em produção segue com o problema até a contenção.
- `supabase/tests/ulbra_historico_portao/run.mjs` roda no CI (job `ulbra-historico-portao-pglite`) e também manualmente (PGlite). A condição ANTES do teste simula o grant a PUBLIC; não é prova do estado de produção.

## Migrations: estado correto (revisão 16/11)
- `20261110100000_ulbra_historico_orcamento`: APLICADA em produção (ledger 20261112111006). O `.sql.pendente` foi restaurado ao original (sha 163f3b55…); não é a versão aplicada nem deve ser reaplicado.
- `20261116150000_ulbra_historico_reservar_portao_interno`: CORRETIVA, NÃO aplicada. `.sql.pendente` e `.rollback.sql` no diretório aguardando_aprovacao.
- A exposição da RPC em produção NÃO foi comprovada: o ledger já revoga EXECUTE de public/anon/authenticated. A corretiva é defesa em profundidade.

## Cobertura do teste da RPC e alcance da corretiva (medido em 16/11)
Medido em PRODUÇÃO por leitura (`pg_proc`, sem escrita):
- `public.ulbra_historico_reservar`: dono `postgres`, SECURITY DEFINER, ACL `{postgres=X/postgres, service_role=X/postgres}`.
- EXECUTE: `anon` = false, `authenticated` = false, `service_role` = true.
- Portão interno (texto "acesso negado"): AUSENTE.

Conclusão: a RPC em produção NÃO é executável por anon nem authenticated. A corretiva é defesa em profundidade para o caso de service_role indevido. Ela NÃO fecha a exposição da v1.

Cenários cobertos por `supabase/tests/ulbra_historico_portao/run.mjs` (rodado no CI, job `ulbra-historico-portao-pglite`):
1. **Definição e grants de produção:** reproduzidos pelo estado do ledger 20261112111006 + ACL medida acima. Mede-se a forma, não o banco real.
2. **Cenário defensivo (simulação):** EXECUTE concedido a PUBLIC (não é o estado de produção). Serve só para provar que anon e authenticated seriam barrados pelo portão.
3. **Contexto da v1 (service_role):** papel `service_role` no JWT. Com a corretiva, a chamada de service_role é PERMITIDA. Ou seja, o portão não bloqueia o caminho que a v1 usa.

Alcance exato da corretiva `20261116150000`: barra authenticated/anon com EXECUTE indevido e reafirma grants mínimos. NÃO barra service_role. O caminho exposto é a função `ulbra-historico` v1 (service_role + credencial central), que só a CONTENÇÃO fecha.

Bloqueio explícito de produção: a contenção da v1 (remoção do endpoint `ulbra-historico`) está AUTORIZADA e BLOQUEADA POR ACESSO. Não está comprovadamente executada. Até a remoção ou substituição segura ser verificada (listagem sem a função e endpoint indisponível), a exposição do histórico com credencial central permanece.

Sequência de implantação (NÃO executada; cada passo exige aprovação específica):
1. Aprovar a corretiva e rodar o CI do job `ulbra-historico-portao-pglite`.
2. Contenção da v1 (remoção exclusiva de `ulbra-historico`), pela gestão, com executor único. Verificar: função ausente na listagem e endpoint indisponível.
3. Aplicar a corretiva em produção (SQL), com a conferência pós-grants do próprio arquivo.
4. Verificação pós-aplicação: ACL e dono medidos de novo, e teste de acesso.
Rollback: `20261116150000_*.rollback.sql` restaura a versão sem portão. NÃO é recuperação automática. Alternativa segura: manter `ULBRA_HISTORICO_HABILITADO` ausente.

## Riscos da v1 em produção (a declarar à gestão; não corrigidos por esta PR)
- A v1 publicada (`ulbra-historico`) concede leitura global aos perfis `supervisor`, `gerencia` e `administrativo` (preservação, `index.ts:24`, `:78`, `:97`). Isso é mais largo que a regra de 16/11. Quem tem esses perfis em produção: NÃO CONFERIDO.
- A v1 casa o e-mail com `ilike` sem escape (`index.ts:76`) e usa o perfil da linha casada. Inferência de código, não reproduzida em banco.
- A UI desligada (`HISTORICO_DISPONIVEL=false`) não fecha o endpoint: a v1 responde por HTTP a qualquer JWT de usuário ativo.
- A cópia preservada em `docs/integracoes/preservacao-ulbra-historico-v1-producao/` foi reconstruída a partir do retorno da leitura. Diferenças em relação à versão do histórico do repositório: `historico.ts` (import e texto de cota). Não é prova byte a byte da produção.
- Pré-requisito explícito: contenção (remoção de `ulbra-historico`) antes de qualquer outra ação.

## Tabela de migrations (conferida em 17/11/2026, leitura de produção sem escrita)
| Migration | Estado em produção | Arquivos (sha256) | Dependências / ordem |
|---|---|---|---|
| `20261110100000_ulbra_historico_orcamento` | APLICADA (ledger `20261112111006`); tabela `ulbra_historico_uso` e `ulbra_historico_reservar` existem, dono postgres, sem portão | pendente original `163f3b55…`; rollback `1aa486a1…` | Histórica. NÃO reaplicar nem editar. |
| `20261111140000_ulbra_conexao_individual_e_envio` | NÃO APLICADA (tabelas `ulbra_conexoes_pedidos`, `ulbra_conexoes_operador`, `ulbra_envio_previas`, `ulbra_envios` e função `ulbra_conferir_envio` ausentes) | pendente `fcd27030…`; rollback `f6b8013e…` | Depende de `ulbra_vinculos`/`ulbra_conversas` já existentes. Aplicação exige aprovação. |
| `20261116150000_ulbra_historico_reservar_portao_interno` | NÃO APLICADA (sem registro no ledger) | pendente `1b448d8b…`; rollback `be7b2c64…` | Depende de `20261110100000` aplicada (pré-condição checa a função). Aplicação exige aprovação. |

Ordem sugerida, cada passo com aprovação específica: (1) `20261111140000`; (2) `20261116150000`, depois de a contenção da v1 estar verificada. Recuperação: rollback de cada uma, na ordem inversa. O rollback de `20261110100000` apaga `ulbra_historico_uso` e NÃO deve ser executado.

## Deno check (CI)
- Jobs: `ulbra-conversa-deno-check` (sem `DENO_NO_PACKAGE_JSON`) e `tv-dados-deno-check` (com `DENO_NO_PACKAGE_JSON=1`, pelo motivo documentado no próprio job: `npm:openai` no package.json da raiz).
- Evidência do CI no head `35417eb2`: `ulbra-conversa — deno check` = SUCCESS, sem a variável. Não há import `npm:` em `supabase/functions/ulbra-conversa` (só `https://esm.sh/...`). Por isso a variável NÃO é necessária nesse job. Não foi adicionada.
- Deno não está instalado localmente; a evidência é o próprio CI.

## Resultado do CI e do Guardião (registrar na PR, não em commit)
- CI do `35417eb2`: 24/24 jobs SUCCESS, incluindo `ulbra-conversa — deno check` e `ulbra histórico — portão da RPC (PGlite)`.
- CI do `042a476b`: é ancestral desta branch; esse commit removeu 13 jobs do workflow por erro de edição, depois revertido (estado restaurado pelo `ci.yml` de `35417eb2`).
- Guardião: ver a revisão final no head registrado na PR.
- CI do `60e9e194`: em andamento no momento desta escrita. Só vale o resultado concluído.
- Ligar `HISTORICO_DISPONIVEL` exige antes: a visibilidade do botão em tela (`CentralUlbra.jsx`, `ulbraHistorico.js`) coincidir com a regra do backend (hoje a tela usa `eh_gestao`, perfil amplo).
