# Pacote — histórico e resposta pela Central ULBRA, com autoria individual (para revisão)

Preparado em 11/11/2026. **Nenhuma mensagem enviada, nenhuma credencial alterada, nada publicado nem aplicado.** Frente separada do pacote de 12/11 (#904), que fica intocado.

## 1. O mecanismo real de conexão individual (lido do servidor da Mensageria, sem credencial)
- `GET https://crm.ulbra.ai/.well-known/oauth-protected-resource` → o recurso MCP aponta o servidor de autorização `https://crm.ulbra.ai/api/oauth` e lista os escopos (entre eles `conversas:read`, `mensagens:enviar`, `atendimentos:read`).
- `GET https://crm.ulbra.ai/.well-known/oauth-authorization-server/api/oauth` → **OAuth 2.1 padrão**: `authorization_code` + `refresh_token`, **PKCE S256**, `token_endpoint_auth_methods_supported: ["none"]` (**cliente público**, sem segredo), endpoint de revogação. **Não há `registration_endpoint`** (registro dinâmico de cliente não é anunciado).
- `POST /api/mcp` sem credencial → 401 com `WWW-Authenticate: Bearer ... resource_metadata=...` (conforme a especificação MCP).

**Conclusão — o que de fato depende da TI da ULBRA:** só **um `client_id` registrado para o ReATIVA com a `redirect_uri`** `https://crm-reativa.vercel.app/ulbra/conectado` (e uma de desenvolvimento, se quiserem). Tudo o mais é padrão e já está implementado: o operador autoriza **na tela da própria Mensageria**, com a conta dele; o ReATIVA recebe o código, troca pelo token com PKCE e guarda os tokens **cifrados**. Nenhum bloqueio presumido além desse registro.

## 2. O que a entrega faz (menor conjunto integrado)
**Histórico (leitura, credencial de backend, só leitura):**
- Leitura do histórico: ação `historico_ler` da Edge Function `ulbra-conversa`, com a **conexão individual do operador** (nunca a credencial central). Cada leitura gera `ULBRA_HISTORICO_LEITURA` na `auditoria`, sem texto de conversa. Desligada por padrão no backend (`ULBRA_HISTORICO_HABILITADO`). A função `ulbra-historico` saiu deste pacote. A versão 1 foi CONTIDA: função excluída e endpoint HTTP 404 (evidência em `preservacao-ulbra-historico-v1-producao/MANIFESTO.md`).
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
- `ULBRA_ENVIO_REAL` e `ULBRA_CONTRATO_PREVIA_CONFIRMADO` — ambas ausentes/`false` por padrão. A prévia (`envio_previa`) só funciona com AS DUAS ligadas (`index.ts:87`, `:363`). Ligar as duas também libera `envio_confirmar`. Por isso a etapa de prévia exige a aprovação do roteiro (`docs/integracoes/roteiro-envio-real-ulbra.md`).
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
0. CONTENÇÃO da v1 `ulbra-historico`: **CONCLUÍDA** pela gestão (função excluída pelo painel após download do ZIP; ausente da listagem; endpoint HTTP 404). Evidência e referência em `docs/integracoes/preservacao-ulbra-historico-v1-producao/MANIFESTO.md`. Não há restauração.
1. TI da ULBRA: `client_id` + `redirect_uri` registrados (único item externo).
2. Migrations `20261111140000` (conexão individual e envio) e `20261117120000` (`ulbra_gravar_conexao`, depende da anterior), cada uma com aprovação específica; conferir grants (só service_role) e `search_path`. `20261110100000` já está aplicada e não é reaplicada. `20261116150000` **fica fora** deste piloto: nenhum caminho do `ulbra-conversa` a chama.
3. Segredos `ULBRA_OAUTH_CLIENT_ID`, `ULBRA_OAUTH_REDIRECT_URI`, `ULBRA_TOKENS_CHAVE` (gestão, fora de transcript); publicar `ulbra-conversa` (verify_jwt ligado).
4. Merge da #913 (habilita a tela; sem função publicada, a Central mostra "função indisponível"/"conexão não configurada").
5. Piloto de leitura: `ULBRA_HISTORICO_HABILITADO=true` e `ULBRA_HISTORICO_PILOTO_EMAILS` com a lista restrita aprovada. Lista ausente ou vazia = ninguém (fail-closed). Sem conexão individual ativa do próprio operador, a leitura responde 403 `SEM_CONEXAO`, sem chamar a Mensageria.
6. Envio: `ULBRA_ENVIO_REAL` e `ULBRA_CONTRATO_PREVIA_CONFIRMADO` **desligadas**. Só com aprovação específica, contato de teste autorizado e roteiro aprovado.

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
- A9 (ilike sem escape em `ulbra-historico`) não é item separado: resolvido pela remoção da função do repositório e pela contenção da v1 em produção (função excluída; HTTP 404).
- `supabase/tests/ulbra_historico_portao/run.mjs` roda no CI (job `ulbra-historico-portao-pglite`) e também manualmente (PGlite). A condição ANTES do teste simula o grant a PUBLIC; não é prova do estado de produção.

## Migrations: estado correto (revisão 16/11)
- `20261110100000_ulbra_historico_orcamento`: APLICADA em produção (ledger 20261112111006). O `.sql.pendente` foi restaurado ao original (sha 163f3b55…); é a MESMA versão aplicada em produção (sha `163f3b55…`, igual ao ledger `20261112111006`). Não deve ser reaplicado.
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

Contenção da v1 (`ulbra-historico`): CONCLUÍDA (função excluída pelo painel; ausente da listagem; endpoint HTTP 404). Por isso a corretiva não é pré-condição do piloto.

Sequência de implantação (NÃO executada; cada passo exige aprovação específica):
1. Aprovar a corretiva e rodar o CI do job `ulbra-historico-portao-pglite`.
2. Contenção da v1: CONCLUÍDA (ver acima).
3. Aplicar a corretiva em produção (SQL), com a conferência pós-grants do próprio arquivo.
4. Verificação pós-aplicação: ACL e dono medidos de novo, e teste de acesso.
Rollback: `20261116150000_*.rollback.sql` restaura a versão sem portão. NÃO é recuperação automática. Alternativa segura: manter `ULBRA_HISTORICO_HABILITADO` ausente.

## Riscos da v1 `ulbra-historico` (CONTIDA)

**Estado: CONTIDA.** A função foi excluída pela gestão; a listagem não a mostra mais e o endpoint responde HTTP 404. Essa evidência está preservada e não é pendência. Não há restauração.

Registro histórico do que a v1 permitia (para a gestão saber o que foi fechado):
- Concedia leitura global aos perfis `supervisor`, `gerencia` e `administrativo` (preservação, `index.ts:24`, `:78`, `:97`), mais larga que a regra de 16/11.
- Casava o e-mail com `ilike` sem escape (`index.ts:76`) e usava o perfil da linha casada (inferência de código, não reproduzida em banco).
- Respondia a qualquer JWT de usuário ativo, mesmo com a UI desligada.
- A cópia preservada foi reconstruída a partir do retorno da leitura; não é prova byte a byte da produção.

## Verificação A3 — grants e políticas de `auditoria` (produção, somente leitura, 17/11/2026)

Consulta de leitura em `information_schema.role_table_grants`, `pg_policies`, `pg_policy` e `pg_class`:
- Grants: `authenticated` tem INSERT, UPDATE e DELETE em `public.auditoria`. `service_role` e `postgres` têm os seus.
- RLS: habilitado (`relrowsecurity = true`), não forçado para o dono.
- Políticas: `auditoria_select_amanda` (PERMISSIVE, SELECT, para `amanda.seibel` e auditor ativo) e `painel_negado` (RESTRICTIVE, ALL, para `authenticated`, `NOT eh_painel()`).
- Não há política PERMISSIVE de INSERT. Com RLS ligado, a inserção direta por `authenticated` é NEGADA pelo banco, apesar do grant.

**Conclusão:** a hipótese de "qualquer autenticado forja auditoria" NÃO se confirma pela política. O grant excessivo continua existindo e é pendência de higiene.

**Caminho de auditoria do piloto:** `auditar()` em `index.ts:262` usa o cliente `service_role` (`sb`), que não depende de RLS nem de grant de `authenticated`.

**Dependência que bloqueia a revogação simples:** `src/pages/ProjecaoHoraHora.jsx` insere em `auditoria` com a sessão do usuário. Revogar INSERT de `authenticated` quebraria essa tela. A correção mínima (rascunho, NÃO aplicado) é: (1) migrar o insert de `ProjecaoHoraHora` para uma função de servidor; (2) então `REVOKE INSERT, UPDATE, DELETE ON public.auditoria FROM authenticated`. Rollback: `GRANT INSERT, UPDATE, DELETE ON public.auditoria TO authenticated`. Exige aprovação específica e validação do grant final.

## Pré-requisito de contenção — atendido
- A contenção da v1 está concluída (ver acima). Não há pré-requisito pendente para o piloto por esse motivo.

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
- Ligar `HISTORICO_DISPONIVEL` exige antes: a visibilidade do botão em tela coincidir com a regra do backend. A conversa (`CentralUlbra.jsx`) já usa `historico_capacidade` do servidor. A LISTA (`MensageriaPeriodo.jsx`) usa `capacidade_historico` por linha, e a RPC `ulbra_central_conversas_periodo` ainda NÃO produz esse campo: sem ele o botão da lista fica fechado (fail-closed). Mudar essa RPC é migration nova, que exige autorização própria; não foi feita.

## Ação `envio_conferencia` (documentada aqui)
- `ulbra-conversa` tem a ação `envio_conferencia` (`index.ts`, bloco de conferência): leitura do estado de um envio pelo servidor, restrita pelos perfis de `conferencia.ts`. Não altera a Mensageria. Está fora do cabeçalho de `index.ts`, por isso fica registrada aqui.

## Ordem de implantação (dependências explícitas)
Tipos de ação, que NÃO são a mesma coisa: **merge** (código na main, sem efeito em produção), **deploy automático** (CI publica função/front), **aplicação manual** (SQL em produção ou publicação de função com aprovação específica). Nada abaixo é automático.

| Passo | Tipo | Depende de | Verificação antes de avançar |
|---|---|---|---|
| 0. Contenção da v1 `ulbra-historico` (remover só essa função) | aplicação manual, pela gestão | nada | listagem sem `ulbra-historico` e endpoint indisponível |
| 1. Aplicar `20261111140000` (tabelas de conexão/prévia/envio e `ulbra_conferir_envio`) | aplicação manual (SQL) | passo 0 | tabelas existem; RLS ligada; sem grant a anon/authenticated |
| 2. Aplicar corretiva `20261116150000` (portão da RPC) | aplicação manual (SQL) | passo 0 e `20261110100000` aplicada (já está) | pós-conferência do próprio arquivo; EXECUTE só service_role |
| 3. Publicar `ulbra-conversa` com segredos (`ULBRA_OAUTH_*`, `ULBRA_TOKENS_CHAVE`) e `verify_jwt` | aplicação manual (função) | passos 1 e 2 (a função grava nas tabelas do passo 1) | `historico_capacidade` e `historico_ler` respondem como o teste prevê |
| 4. Merge desta PR na main (inclui a tela) | merge | passos 0 a 3 | CI da PR verde; a tela sem a porta não chama nada |
| 5. Deploy do front a partir da main | deploy automático | passo 4 | Central com `HISTORICO_DISPONIVEL = true` (porta de tela); cada botão só aparece com `capacidade` do servidor, que nega enquanto `ULBRA_HISTORICO_HABILITADO` estiver ausente |
| 6. Conexão de 1 operador piloto | manual (usuário) | passos 3 e 5 | conexão ATIVA, `pessoa_email` igual ao JWT |
| 7. Ativar `ULBRA_HISTORICO_HABILITADO` (leitura) | aplicação manual (segredo) | passo 6 e aprovação | leitura de 1 conversa com auditoria gravada |
| 8. Ativar `ULBRA_ENVIO_REAL` e `ULBRA_CONTRATO_PREVIA_CONFIRMADO` (prévia e envio) | aplicação manual (segredo) | passo 7, aprovação do roteiro e **B5 corrigido** (bloqueio obrigatório, separado do piloto de leitura) | prévia sem mensagem enviada; envio só pelo roteiro |
| 9. (antigo "ligar `HISTORICO_DISPONIVEL`") | **não há mais passo de merge de porta**: a porta já está `true` no passo 4 | — | a conversa só mostra o botão onde `historico_capacidade` concede; a lista só após a RPC produzir `capacidade_historico` (migration própria) |

Recuperação: cada passo tem rollback no próprio arquivo, exceto a v1 (não restaurar a versão vulnerável). O rollback de `20261110100000` NÃO deve ser executado (apaga `ulbra_historico_uso`).
