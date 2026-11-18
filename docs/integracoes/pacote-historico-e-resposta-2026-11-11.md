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

## 5. Custos por ação (cota: 50/dia por operador e 500/dia global, por padrão)
| Ação | Quem paga | Chamadas |
| --- | --- | --- |
| Carregar histórico / anteriores | conexão individual do operador (não a credencial de backend) | 1 por página (+1 `meu_acesso` se a medida do saldo venceu) |
| Conectar a conta | operador | 1 (`meu_acesso`, prova de autoria) |
| Ver prévia | operador | 1 |
| Confirmar envio | operador | 1 |
| Renovar/revogar token | — | 0 (servidor OAuth, não é o MCP) |

## 6. Testes (sem rede)
- Lógica: `oauth.test.ts` (PKCE, URL, troca/renovação/revogação com fetch simulado, retorno do navegador), `cripto` (AES-GCM), `conexao.test.ts` (11), `envio.test.ts` (45), `leitura.test.ts` (17). Não há mais `historico.test.ts`: a função `ulbra-historico` foi removida do repositório.
- Tela: `ulbraConversaCliente.test.js` (chamadas com JWT, mapeamento, prévia), `ConversaUlbra.test.jsx` (duas etapas, idempotência, falha incerta, bloqueio), `UlbraConectado.test.jsx`, `CentralUlbra.test.jsx` (histórico só com clique, conectar abre a URL, prévia → confirmação com chave, carteira interna sem histórico/envio), `CentralConversas.test.jsx`.
- CI: `deno check` de `ulbra-conversa` (job `ulbra-conversa-deno-check`); `ulbra-historico` foi removida do repositório e não tem job. Teste de acesso da RPC: job `ulbra-historico-portao-pglite` (npm ci + run.mjs).
- **Não provado:** forma exata das respostas de `meu_acesso`/`enviar_mensagem_whatsapp` (campos de custo/janela/id); a função trata ausências sem inventar valores e a prévia mostra "validade não informada" (custo não exibido).

## 7. Ordem de implantação
A ordem única está na seção "Ordem de implantação da leitura", no fim deste documento. Esta seção não define ordem.

## 8. Fora deste pacote
Campanhas, criação de atendimentos, transferências, administração de operadores (ver a documentação de capacidades da Mensageria (arquivo a localizar; referência anterior quebrada)); coleta automática; o pacote de 12/11.

## Leitura global do histórico (decisão da gestão, 16/11)
- Alcance: `amanda.seibel@aelbra.com.br` (gestão) e `cobranca04@aelbra.com.br` (supervisão, Fernanda): leitura global. Só leitura.
- `cobranca07@aelbra.com.br` (Amanda ADM) e demais operadores: somente carteira ou responsabilidade.
- Regra: `temLeituraGlobal` em `supabase/functions/ulbra-conversa/leitura.ts`. E-mail exato do JWT (sem prefixo), usuário ativo obrigatório, não reutiliza `usuario_e_gestao()`.
- Não amplia envio, transferência ou atuação. A conexão individual continua obrigatória; a leitura global não usa credencial central.

## Migration corretiva 20261116150000 (pré-requisito do passo de leitura; NÃO aplicada)
- Efeito exato: recria `ulbra_historico_reservar` com portão interno: aceita apenas `auth.role() = 'service_role'`, e recusa qualquer outro papel com 42501. Nossa chamada usa a chave de service_role, então PASSA; a corretiva bloqueia chamadas indevidas por outro papel, caso o EXECUTE seja concedido por engano.
- Portanto é pré-requisito do passo de leitura (premissa de portão interno), não do cadastro de token.
- Testes: `supabase/tests/ulbra_historico_portao/run.mjs` (PGlite, job `ulbra-historico-portao-pglite`) cobre o portão.
- Arquivos: `.sql.pendente` e `.rollback.sql` em `supabase/aguardando_aprovacao/`. Hashes na seção de migrations pendentes.
- Rollback: restaura a versão SEM portão. Não é recuperação automática.

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

Contenção da v1 (`ulbra-historico`): CONCLUÍDA (função excluída pelo painel; ausente da listagem; endpoint HTTP 404). A contenção da v1 não substitui a corretiva: o portão interno da RPC de reserva é pré-requisito do passo de leitura.

Sequência de implantação: ver "Ordem de implantação da leitura" (ÚNICA, no fim deste documento). A corretiva 20261116150000 é pré-requisito do passo de leitura.

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

**Pré-condição da revogação:** a busca em `src/` e `supabase/functions/` não encontrou INSERT em `auditoria` feito com a sessão do usuário. `src/pages/ProjecaoHoraHora.jsx:631-632` só faz SELECT. Os inserts encontrados nas edge functions usam `service_role`: `supabase/functions/ulbra-conversa/index.ts:263`, `supabase/functions/ulbra-consultar/index.ts:95` e `supabase/functions/prime-portador/index.ts:306` (cliente `supa` com a chave de service role, linhas 118-120).

**Inventário de funções SQL NÃO fechado.** Consulta de `pg_proc` em produção (17/11) encontrou cerca de 60 funções cujo corpo menciona `auditoria` em insert; a maioria é `SECURITY DEFINER`, mas o modo de cada uma não foi conferido em todas. Uma função `SECURITY INVOKER` confirmada, `_titulo_em_confirmacao_protegido()`, insere em `auditoria` e é executável por `authenticated`. Por isso o inventário precisa ser concluído antes de qualquer revogação.

Correção mínima (rascunho, NÃO aplicado): (1) concluir o inventário; (2) `REVOKE INSERT, UPDATE, DELETE ON public.auditoria FROM authenticated`. Rollback: `GRANT INSERT, UPDATE, DELETE ON public.auditoria TO authenticated`. Exige aprovação específica e validação do grant final.

## Pré-requisito de contenção — atendido
- A contenção da v1 está concluída (ver acima). Não há pré-requisito pendente para o piloto por esse motivo.

## Tabela de migrations (conferida em 17/11/2026, leitura de produção sem escrita)
| Migration | Estado em produção | Arquivos (sha256) | Dependências / ordem |
|---|---|---|---|
| `20261110100000_ulbra_historico_orcamento` | APLICADA (ledger `20261112111006`); tabela `ulbra_historico_uso` e `ulbra_historico_reservar` existem, dono postgres, sem portão | pendente original `163f3b55…`; rollback `1aa486a1…` | Histórica. NÃO reaplicar nem editar. |
| `20261111140000_ulbra_conexao_individual_e_envio` | NÃO APLICADA (tabelas `ulbra_conexoes_pedidos`, `ulbra_conexoes_operador`, `ulbra_envio_previas`, `ulbra_envios` e função `ulbra_conferir_envio` ausentes) | pendente `fcd27030…`; rollback `f6b8013e…` | Depende de `ulbra_vinculos`/`ulbra_conversas` já existentes. Aplicação exige aprovação. |
| `20261116150000_ulbra_historico_reservar_portao_interno` | NÃO APLICADA (sem registro no ledger) | pendente `1b448d8b…`; rollback `be7b2c64…` | Depende de `20261110100000` aplicada (pré-condição checa a função). Aplicação exige aprovação. |
| `20261117120000_ulbra_gravar_conexao_atomica` | NÃO APLICADA | pendente `dcd8df53…`; rollback `8f3b4449…` (sha256 de `supabase/aguardando_aprovacao/`, em `279dc9f9`) | Depende de `20261111140000`. Aplicação exige aprovação. |

Localização dos arquivos: `supabase/aguardando_aprovacao/` (convenção do repositório para migrations pendentes de aprovação; não estão em `supabase/migrations/`, por isso não passam pelo CI de migrations nem pelo ledger). Essa localização é decisão pendente da gestão (R4).

Ordem: ver "Ordem de implantação da leitura" (única).

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

## Ordem de implantação
Ver "Ordem de implantação da leitura", no fim deste documento. A tabela anterior foi removida por divergir.

## Pacote de implantação consolidado da leitura (consolidado em 18/11/2026, head de revisão)

**Escopo:** leitura do histórico com token pessoal por operador. Envio DESLIGADO. Nenhuma migration está aplicada ou aprovada por este documento.

### Migrations pendentes (sha256 completo dos arquivos revisados, em `supabase/aguardando_aprovacao/`)

| Migration | Arquivo | sha256 |
|---|---|---|
| `20261111140000_ulbra_conexao_individual_e_envio` | `.sql.pendente` | `fcd270305358c69db33e25072c1c0288fd0cbf7dc129bd1b6147fef1dbb6e691` |
| `20261111140000_ulbra_conexao_individual_e_envio` | `.rollback.sql` | `f6b8013e8c43ff2f917dbf8839ac103b93e53c991b299b1cd1bc83e09d8e760f` |
| `20261117120000_ulbra_gravar_conexao_atomica` | `.sql.pendente` | `dcd8df5388cbdc5e2c20576b0dd9044b23dcd9667ad8f230f2e653b461671ed8` |
| `20261117120000_ulbra_gravar_conexao_atomica` | `.rollback.sql` | `8f3b4449b527bcfb6d1125b51371336ef1112d49a0e1b9f2933a22ff97d04942` |
| `20261116150000_ulbra_historico_reservar_portao_interno` (corretiva; pré-requisito do passo de leitura) | `.sql.pendente` | `1b448d8b0c2be6b5feca9e1900fa772b919c22da62d0752540e20cbd02f58402` |
| `20261116150000_ulbra_historico_reservar_portao_interno` (corretiva) | `.rollback.sql` | `be7b2c64ad7d7e0c4dddb1627a3989678dcbd80537edfd59814f2538e2517113` |

Migrations já aplicadas e fora deste pacote: `20261110100000_ulbra_historico_orcamento` (ledger `20261112111006`). Não reaplicar, e não executar o rollback dela.

### Ordem de aplicação
Ver "Ordem de implantação da leitura" (única). Não há outra ordem neste documento.

### Cobertura de CI (o que roda, em qual ordem)
- **Job `ulbra-conexao-envio-sql`** (Postgres 17): `supabase/tests/ulbra_conexao_envio/run.cjs` aplica `20261111140000` (`.sql.pendente`) e testa persistência, consumo único, concorrência, guarda e rollback (`.rollback.sql`), inclusive a recusa de rollback com histórico.
- **Step "Atomicidade da gravação de conexão" do job `ulbra-conexao-envio-sql`** (Postgres 17): `supabase/tests/ulbra_conexao_token/run.cjs` aplica `20261111140000` e, em seguida, `20261117120000` (ordem correta). Cobre concorrência de cadastro e conclusão OAuth.
  - **Adicionado nesta rodada:** asserções de grants (anon e authenticated sem EXECUTE; service_role com EXECUTE; PUBLIC sem EXECUTE), de `SECURITY INVOKER` e de `search_path = public, pg_temp`, e teste de ROLLBACK da `20261117120000` em transação descartada (remove só a função e preserva a tabela).
  - **Limite:** esses testes só rodam no CI; não foram executados localmente (não há Postgres local neste ambiente).
- **Job `ulbra-historico-portao-pglite`**: `supabase/tests/ulbra_historico_portao/run.mjs` cobre a corretiva `20261116150000` (PGlite, não Postgres real).

### Promoção e ledger (procedimento POSTERIOR, NÃO executado)
Padrão do repositório: `supabase/ledger/DUAS-TRILHAS.md` (Fluxo B, o padrão) e `supabase/ledger/LEIA-ME.md`. A `20261117120000` cai no Fluxo B porque a função `ulbra-conversa` (nova nesta PR) depende dela (dependência simultânea de backend e banco).
Os passos de mesclagem, `READY`, aplicação, validação e publicação estão na seção "Ordem de implantação da leitura" (ÚNICA). Esta subseção acrescenta só a etapa de ledger, executada DEPOIS da aplicação e da validação:
- Registro do drift no ledger em PR própria: `supabase/ledger/2026-11/<timestamp>__<name>.sql`, com o `.sql` byte a byte igual aos `statements` e explicação em arquivo `__NOTA.md` ao lado. Atualizar `INDICE.tsv`.
- Versão: `apply_migration` gera o timestamp que fica em `supabase_migrations.schema_migrations`. O arquivo de ledger usa o `name` que produção registrou (`supabase/ledger/LEIA-ME.md`, regra 4). A correspondência entre a versão gerada e o nome do arquivo é conferida na validação (md5 prova apenas o conteúdo; a conferência de versão e nome é feita em `schema_migrations` (DUAS-TRILHAS.md, Fluxo B, passo 6).
- **Vetado nos dois fluxos:** `supabase db push`, `supabase db pull`, `supabase migration repair`, e escrita manual em `schema_migrations`.
- Os arquivos pendentes NÃO devem ser copiados para `supabase/migrations/` para contornar a revisão (a catraca de migrations reprova o sufixo `__` nesse diretório).

### Pré-requisitos de configuração (NÃO são defeito de código)
- **`ULBRA_TOKENS_CHAVE` ausente** no Supabase de produção (conferido em 18/11 pela tela de Secrets, só nomes). Sem ela, nenhuma conexão individual é gravada. Criar só com aprovação específica.
- Flags de servidor desligadas: `ULBRA_HISTORICO_HABILITADO`, `ULBRA_ENVIO_REAL`, `ULBRA_CONTRATO_PREVIA_CONFIRMADO` (ausentes, por conferência de nomes).
- `ULBRA_OAUTH_CLIENT_ID` e `ULBRA_OAUTH_REDIRECT_URI` ausentes: OAuth fica indisponível no piloto (por configuração).
- `ULBRA_HISTORICO_PILOTO_EMAILS` ainda não configurada: a leitura só existe depois dela, com a lista restrita ao operador piloto.

### Ordem de implantação da leitura (ÚNICA; Fluxo B; nenhuma etapa libera leitura antes dos pré-requisitos)
1. **Mesclar** a PR (aprovação específica). O front publicado só consulta `historico_capacidade`; sem a flag de servidor, nada é lido.
2. Esperar o deploy de produção ficar `READY`.
3. **Aplicar, nesta ordem e uma vez cada, por `apply_migration`** (aprovação específica para cada uma): (a) `20261111140000`; (b) `20261117120000`; (c) `20261116150000` (corretiva do portão; pré-requisito do passo de leitura). A `20261110100000` já está aplicada e não é reaplicada.
4. **Publicar** `ulbra-conversa` com `verify_jwt` a partir da `main` (aprovação específica). Sem `ULBRA_TOKENS_CHAVE`, as ações de conexão respondem 503 `CONEXAO_NAO_CONFIGURADA`.
5. **Configurar** `ULBRA_TOKENS_CHAVE` (aprovação específica; pré-requisito de implantação, hoje AUSENTE).
6. **Configurar** `ULBRA_HISTORICO_PILOTO_EMAILS=cobranca10@aelbra.com.br` (aprovação específica). Antes do cadastro: sem ela, o cadastro é negado (`PILOTO_NAO_AUTORIZADO`).
7. **Cadastro** do token do operador piloto, pelo próprio operador, com `ULBRA_HISTORICO_HABILITADO` ainda DESLIGADA.
8. **Configurar** `ULBRA_HISTORICO_TETO_OPERADOR_DIA` e `ULBRA_HISTORICO_TETO_GLOBAL_DIA` (opcionais; padrões 50 e 500).
9. **Ativar por último** `ULBRA_HISTORICO_HABILITADO=true` (aprovação específica). Só a partir daqui há leitura.

### Verificação
- Antes de qualquer flag: `historico_capacidade` e `historico_ler` respondem negado com `HISTORICO_DESLIGADO`, sem chamada à Mensageria.
- Com o piloto: leitura de uma conversa permitida, auditoria gravada, e negativa para usuário fora da lista.

### Recuperação
- Desligar `ULBRA_HISTORICO_HABILITADO` (ou remover da lista) restaura o estado negado imediatamente.
- Remover a função pública `ulbra-conversa` é a contenção de último recurso.
- Rollbacks, na ordem inversa: `20261116150000` → `20261117120000` → `20261111140000`. O rollback da `20261111140000` recusa se houver histórico (conexões, prévias ou envios).
- **Não** executar o rollback de `20261110100000` (apaga `ulbra_historico_uso`).
- **Não** restaurar a função `ulbra-historico` v1 (contida).

### Bloqueios restantes (antes de qualquer aplicação)
- Aprovação específica para cada migration, para a publicação, para o segredo e para as flags.
- Inventário das funções SQL que inserem em `auditoria` (não fechado) antes de qualquer revogação de grant (A3).
- B5 (ordem envio vs confirmação): bloqueio obrigatório do envio real, separado do piloto de leitura.
- Localização das migrations (R4): decisão de gestão. Hoje ficam em `supabase/aguardando_aprovacao/`, por convenção do repositório.

**Consultas de produção de 17/11/2026 (somente leitura), versionadas em `docs/seguranca/consultas-producao-ulbra-2026-11-17.sql`.** Os resultados citados acima foram obtidos com essas consultas. A "cerca de 60 funções" vem da consulta (3); a INVOKER `_titulo_em_confirmacao_protegido()` vem da consulta (4), que mostra `insert into public.auditoria` e dono `postgres`.

### Correções desta rodada (comportamento coberto por testes locais, não executados nesta revisão (ver o CI do head))
- **Cadastro de token restrito ao piloto, no servidor:** `conexao_token_pessoal` nega com `PILOTO_NAO_AUTORIZADO` (403) ANTES de validar ou gravar, se o usuário não estiver em `ULBRA_HISTORICO_PILOTO_EMAILS` (lista ausente = negado). Independe de `ULBRA_HISTORICO_HABILITADO`. Testes (t1), (t2), (t3).
- **Cota OBRIGATÓRIA antes da chamada externa:** adaptador de cota ausente nega com 503 `COTA_INDISPONIVEL` antes de qualquer chamada à Mensageria (teste unitário `historico-cota-obrigatoria.test.ts`).  `historico_ler` reserva 1 unidade em `ulbra_historico_reservar` (service_role, migration `20261110100000`, já aplicada em produção) antes de chamar a Mensageria. Esgotada = 429 `COTA_ESGOTADA`; falha ao reservar = 503 `COTA_INDISPONIVEL`. Tetos por dia (fuso de São Paulo) por variáveis: `ULBRA_HISTORICO_TETO_OPERADOR_DIA` (padrão 50) e `ULBRA_HISTORICO_TETO_GLOBAL_DIA` (padrão 500). **Configuração ainda não definida em produção.** Testes (q1), (q2), (q3).
- **Falha de banco na autorização:** usuário, conexão, conversa, vínculo, casos e responsáveis negam com 503 `AUTORIZACAO_INDISPONIVEL`, sem texto, sem liberar acesso e sem dados no log (só passo e código). Testado no handler: usuário (u1), conexão (u2) e conversa (b1). Vínculo, casos e responsáveis: cobertos no código, sem teste de handler nesta rodada. Erro na verificação de encerramento de caso nega o dono.
- **Teto inválido (não numérico, zero ou negativo):** a cota nega com 503 `COTA_INDISPONIVEL`, sem chamada à Mensageria. Teste (q4).
- **Retentativa de revogação:** cada token é tentado até duas vezes antes de se considerar a revogação pendente (`grant-retry.test.ts`, `grant.test.ts`).
- **Credencial órfã (decisão pendente, NÃO aceita pela gestão):** a pendência de revogação grava na auditoria SOMENTE METADADOS (`ULBRA_OAUTH_REVOGACAO_PENDENTE`, contagem de tokens candidatos). Nenhum token é guardado, nem cifrado. Recuperar a revogação exige armazenamento restrito próprio, que depende de migration e aprovação específicas. OAuth permanece DESABILITADO no piloto.
- **Não há teste de handler para a pendência de revogação**: o caminho de OAuth exige PKCE e não é executado pelos testes de handler. Coberto só em unidade (`grant`).
- **Pré-requisitos adicionais:** `ULBRA_HISTORICO_PILOTO_EMAILS` (ainda não configurada), `ULBRA_HISTORICO_TETO_OPERADOR_DIA` e `ULBRA_HISTORICO_TETO_GLOBAL_DIA` (opcionais; padrões acima).
