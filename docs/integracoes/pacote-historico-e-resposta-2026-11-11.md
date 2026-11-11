# Pacote — histórico e resposta pela Central ULBRA, com autoria individual (para revisão)

Preparado em 11/11/2026. **Nenhuma mensagem enviada, nenhuma credencial alterada, nada publicado nem aplicado.** Frente separada do pacote de 12/11 (#904), que fica intocado.

## 1. O mecanismo real de conexão individual (lido do servidor da Mensageria, sem credencial)
- `GET https://crm.ulbra.ai/.well-known/oauth-protected-resource` → o recurso MCP aponta o servidor de autorização `https://crm.ulbra.ai/api/oauth` e lista os escopos (entre eles `conversas:read`, `mensagens:enviar`, `atendimentos:read`).
- `GET https://crm.ulbra.ai/.well-known/oauth-authorization-server/api/oauth` → **OAuth 2.1 padrão**: `authorization_code` + `refresh_token`, **PKCE S256**, `token_endpoint_auth_methods_supported: ["none"]` (**cliente público**, sem segredo), endpoint de revogação. **Não há `registration_endpoint`** (registro dinâmico de cliente não é anunciado).
- `POST /api/mcp` sem credencial → 401 com `WWW-Authenticate: Bearer ... resource_metadata=...` (conforme a especificação MCP).

**Conclusão — o que de fato depende da TI da ULBRA:** só **um `client_id` registrado para o ReATIVA com a `redirect_uri`** `https://crm-reativa.vercel.app/ulbra/conectado` (e uma de desenvolvimento, se quiserem). Tudo o mais é padrão e já está implementado: o operador autoriza **na tela da própria Mensageria**, com a conta dele; o ReATIVA recebe o código, troca pelo token com PKCE e guarda os tokens **cifrados**. Nenhum bloqueio presumido além desse registro.

## 2. O que a entrega faz (menor conjunto integrado)
**Histórico (leitura, credencial de backend, só leitura):**
- Edge Function `ulbra-historico` (nova; lógica `historico.ts` já preparada e testada). Botão **"Carregar histórico (1 chamada à Mensageria)"** na Central — nada é lido ao selecionar a conversa. Portão: cadastro ativo; **CPF confirmado** (vínculo ativo `alta_cpf` lido agora); **permissão** = dono da carteira ou responsável comprovado pelo atendimento (operador), ou perfil amplo (gestão); **orçamento reservado no banco antes da chamada** (`ulbra_historico_reservar`: 20 por operador/dia, reserva global de 100 que o histórico nunca gasta); saldo com mais de 15 min é renovado por 1 `meu_acesso` (reservado). Páginas de 20; "Carregar anteriores" = 1 chamada. Texto não é persistido.
**Resposta (envio, token DO OPERADOR, nunca a credencial central):**
- Edge Function `ulbra-conversa` (nova; `conexao.ts`, `envio.ts`, `oauth.ts`, `cripto.ts` testados sem rede). Ações: `conexao_iniciar` (PKCE + state, URL de autorização), `conexao_concluir` (troca do código, cifra AES-256-GCM, **1 `meu_acesso` da cota do operador para gravar quem é a pessoa e os escopos**), `conexao_estado`, `conexao_desconectar` (revogação no provedor + local), `envio_previa`, `envio_confirmar`.
- **Permissões** (lidas do banco no momento): identidade confirmada, operador é dono da carteira **ou** responsável do atendimento, janela de 24 h (última mensagem do aluno), conexão própria ativa. A Mensageria ainda exige que a pessoa seja **quem atende** o atendimento — a prévia devolve a recusa real quando não for.
- **Duas etapas na tela:** "Ver prévia (1 chamada da sua cota)" → a própria Mensageria devolve custo estimado (US$) e janela; só então "Confirmar envio" com **chave idempotente** por clique (repetir não reenvia; `FALHA_INCERTA` nunca reenvia sozinha). Envio real **só com `ULBRA_ENVIO_REAL=true`** no ambiente da função; sem isso, `BLOQUEADO: ENVIO_REAL_NAO_CONFIRMADO` mesmo com tudo configurado.
- Registro: `ulbra_envios` (status, id da mensagem, custo e janela da prévia) e linha `ULBRA_ENVIO` na `auditoria`.
- Página `/ulbra/conectado` (retorno do OAuth) — só entrega `code`/`state` à função; nenhum token passa pela tela.

## 3. Banco (migrations pendentes, NÃO aplicadas)
| Arquivo | sha256 `.sql.pendente` | rollback |
| --- | --- | --- |
| `20261110100000_ulbra_historico_orcamento` (tabela de uso diário + `ulbra_historico_reservar`, só service_role) | `163f3b551bd62f18dca519310b76e0cb58d78f4235bde7cff7ff7210bc82622b` | `1aa486a1…8b801` |
| `20261111140000_ulbra_conexao_individual_e_envio` (pedidos PKCE, conexões com tokens cifrados + pessoa/escopos, envios; RLS sem política para authenticated/anon; só service_role) — substitui a proposta 20261109170000, nunca aplicada | `fdfb781a83582163b38f0bf3bcbf6db96af5c24e9bc446bf30a4d0fa48bc50ab` | `04da9ea8…6d55f` |

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
4. Segredos `ULBRA_OAUTH_CLIENT_ID`, `ULBRA_OAUTH_REDIRECT_URI`, `ULBRA_TOKENS_CHAVE` (gestão, fora de transcript); publicar `ulbra-historico` e `ulbra-conversa` (verify_jwt ligado).
5. Validação de leitura com a gestão e com um operador (histórico de 1 conversa: 1 chamada).
6. Conexão de 1 operador piloto (1 `meu_acesso` da cota dele) e **prévia** de uma resposta (1 chamada) — sem `ULBRA_ENVIO_REAL`.
7. Primeiro envio real só pelo roteiro aprovado (destinatário interno, texto fixo, 1 mensagem, autoria conferida na Mensageria), ligando `ULBRA_ENVIO_REAL=true` para a janela e desligando depois, até decisão de liberação.

## 8. Fora deste pacote
Campanhas, criação de atendimentos, transferências, administração de operadores (ver `mensageria-ulbra-capacidades-mcp-2026-11-11.md`); coleta automática; o pacote de 12/11.
