# Implantação da leitura do histórico ULBRA (procedimento VIGENTE)

Este é o ÚNICO procedimento vigente. Os documentos `pacote-historico-e-resposta-2026-11-11.md`, `piloto-token-pessoal-2026-11-17.md` e `corretiva-reserva-historico-2026-11-18.md` são HISTÓRICO DE REVISÃO: não definem ordem nem configuração. Em caso de conflito, vale este documento.

**Escopo:** leitura do histórico pela conexão individual do operador. Este procedimento não configura envio nem OAuth (configuração não definida aqui; o estado atual de produção não foi verificado). Nenhuma etapa aqui é executada sem aprovação específica.

## 1. Arquivos, hashes e ordem
Todos em `supabase/aguardando_aprovacao/` (não em `supabase/migrations/`). Hashes sha256 do conteúdo revisado:

| Ordem | Arquivo | sha256 | name de aplicação |
|---|---|---|---|
| 1 | `20261111140000_ulbra_conexao_individual_e_envio.sql.pendente` | `fcd270305358c69db33e25072c1c0288fd0cbf7dc129bd1b6147fef1dbb6e691` | `ulbra_conexao_individual_e_envio` |
| 2 | `20261116150000_ulbra_historico_reservar_portao_interno.sql.pendente` | `1b448d8b0c2be6b5feca9e1900fa772b919c22da62d0752540e20cbd02f58402` | `ulbra_historico_reservar_portao_interno` |
| 3 | `20261117120000_ulbra_gravar_conexao_atomica.sql.pendente` | `dcd8df5388cbdc5e2c20576b0dd9044b23dcd9667ad8f230f2e653b461671ed8` | `ulbra_gravar_conexao_atomica` |

Rollbacks (`.rollback.sql`, mesma pasta): `20261111140000` `f6b8013e8c43ff2f917dbf8839ac103b93e53c991b299b1cd1bc83e09d8e760f`; `20261116150000` `be7b2c64ad7d7e0c4dddb1627a3989678dcbd80537edfd59814f2538e2517113`; `20261117120000` `8f3b4449b527bcfb6d1125b51371336ef1112d49a0e1b9f2933a22ff97d04942`.

**Justificativa da ordem (verificada pelo texto dos arquivos):** a `20261117120000` usa `ulbra_conexoes_operador`, criada pela `20261111140000`. A `20261116150000` depende apenas de objetos da `20261110100000`, já aplicada. Entre a 1 e a 3, a corretiva (2) fica no meio por ser cronológica e não ter dependência com as demais.

**Pré-condição:** `20261110100000_ulbra_historico_orcamento` aplicada (ledger `20261112111006`).

## 2. Nomes e ledger
- Name de aplicação: o `name` fixo da tabela acima. A VERSÃO é a gerada pelo mecanismo na aplicação e NÃO é antecipada aqui.
- Mapeamento arquivo → sha256 → name → versão gerada: preencher após cada aplicação, em `docs/integracoes/implantacao-leitura-historico-VIGENTE.md` (seção 7).
- Ledger: registro do drift em PR própria, após validação, conforme `supabase/ledger/DUAS-TRILHAS.md` (Fluxo B, passo 7) e `supabase/ledger/LEIA-ME.md` (regra 4: nome que produção registrou).

## 3. Sequência única
Fluxo B (`supabase/ledger/DUAS-TRILHAS.md`). Cada passo tem aprovação própria. Executor: a sessão principal (CLAUDE.md, item 2). Nenhum passo é executado nesta revisão.

1. **Checks verdes no head final** (CI concluído, sem falha) e **Guardião sem reprovação** no mesmo head. Ação: mesclar — aprovação específica.
2. Aguardar o deploy de produção ficar `READY`.
3. **Aplicar a migration 1** (`20261111140000`) por `apply_migration` — aprovação específica. Depois, registrar a versão gerada.
4. **Aplicar a migration 2** (`20261116150000`, corretiva do portão) — aprovação específica.
5. **Aplicar a migration 3** (`20261117120000`) — aprovação específica.
6. **Validar em leitura antes de qualquer publicação:** `schema_migrations` com as três versões e os names; md5 do `.sql` aplicado igual ao arquivo revisado; portão presente na `ulbra_historico_reservar`; `authenticated` e `anon` sem EXECUTE; `service_role` com EXECUTE; tabelas e função da 1 e 3 presentes. Qualquer divergência interrompe.
7. **Configurar o segredo `ULBRA_TOKENS_CHAVE`** — aprovação específica. Pré-requisito de implantação; hoje AUSENTE (ver seção 6).
8. **Publicar `ulbra-conversa`** com `verify_jwt`, a partir da `main`, após o checklist `docs/seguranca/CHECKLIST_SEGURANCA_DEPLOY.md` — aprovação específica.
9. **Configurar `ULBRA_HISTORICO_PILOTO_EMAILS=cobranca10@aelbra.com.br`** — aprovação específica. ANTES do cadastro do token.
10. **Cadastro do token** pelo próprio operador piloto, com `ULBRA_HISTORICO_HABILITADO` DESLIGADA. O gate do piloto nega qualquer outro usuário antes de validar ou gravar.
11. Tetos da cota (opcionais; padrões 50 por operador e 500 global por dia).
12. **Ativar por último** `ULBRA_HISTORICO_HABILITADO=true` — aprovação específica. Só a partir daqui há leitura.
13. **Verificar:** uma conversa lida; registro `ULBRA_HISTORICO_LEITURA` gravado antes do texto; cota reservada antes da chamada à Mensageria.
14. **Ledger** (PR própria), conforme seção 2.

**Não configurar nesta implantação:** `ULBRA_ENVIO_REAL`, `ULBRA_CONTRATO_PREVIA_CONFIRMADO`, `ULBRA_OAUTH_CLIENT_ID`, `ULBRA_OAUTH_REDIRECT_URI`.

## 4. Verificações (com fonte)
- **Código:** `ulbra-conversa` não lê `ULBRA_MCP_TOKEN` em código executável (grep; a única ocorrência fora de comentário é a dos testes que afirmam a ausência: `historico-sem-conexao.test.ts`, `index-historico-ligacao.test.ts`). Leitura usa só a conexão individual do operador.
- **Testes locais (vitest, pasta `supabase/functions/ulbra-conversa`):** 226 testes passaram no commit `ab9cce24`. Não reconferidos no head final.
- **Teste da corretiva local (PGlite, em memória):** `node supabase/tests/ulbra_historico_portao/run.mjs <raiz>` passou em todas as asserções em execução local nesta revisão (sem log versionado).
- **CI do head final:** jobs `ulbra-conexao-envio-sql` (run.cjs de envio e de token, Postgres 17), `ulbra-historico-portao-pglite`, `ulbra-conversa-deno-check`, e `testes, build e catracas`. Status: registrar pelo CI do head final. NÃO declarar verde antes da conclusão.

## 5. Recuperação
- **Flag:** `ULBRA_HISTORICO_HABILITADO` ausente ou `false` nega a leitura imediatamente (sem chamada à Mensageria).
- **Pré-requisito da migration 1:** o `service_role` precisa de INSERT em `public.auditoria` e de `BYPASSRLS` (checagens de pré-condição do próprio arquivo; aborta se faltarem).
- **Leitura global (fora da lista):** `leitura.ts` fixa a leitura global para `amanda.seibel.com.br` e `cobranca04.com.br`. Incluir um e-mail em `ULBRA_HISTORICO_PILOTO_EMAILS` NÃO concede leitura global a esse e-mail; a lista só restringe quem pode ler.
- **Lista do piloto:** remover o e-mail de `ULBRA_HISTORICO_PILOTO_EMAILS` nega o acesso.
- **Rollbacks, ordem inversa de aplicação (3 → 2 → 1), SOMENTE antes de qualquer uso: `20261111140000.rollback.sql` recusa (`ROLLBACK_RECUSADO_HA_HISTORICO`) se houver conexões, prévias, envios ou pedidos. Depois do uso (passo 10 em diante), a saída é desativar as flags, não rollback. A corretiva (2) restaura a versão SEM portão: NÃO é recuperação automática e exige decisão expressa. O rollback de `20261110100000` NÃO deve ser executado (apaga `ulbra_historico_uso`).
- **Não restaurar** a função `ulbra-historico` v1.

## 6. Pré-requisitos e pendências separadas
- **`ULBRA_TOKENS_CHAVE`:** AUSENTE em produção segundo a tela de Secrets (observado em 18/11/2026; não versionado). Pré-requisito de implantação (passo 7).
- **Rotação do token central `ULBRA_MCP_TOKEN`:** PENDÊNCIA SEPARADA. Não faz parte deste procedimento, não é pré-requisito dele e não está decidida. A validade atual do token e a exposição de 07/11 NÃO estão comprovadas nesta revisão. Consumidores identificados por leitura de código: nenhum na `ulbra-conversa`; outras funções devem ser inventariadas pela gestão antes da rotação. Executor e prazo: decisão da gestão.
- **Preparação do aluno e responsabilidade:** fora deste procedimento; validação operacional posterior, sem atribuição artificial.
- **Regra dos cinco:** Mensageria não exige atualização artificial dos artefatos Prime. Fonte: decisão de 17/11/2026 registrada em `decisoes-integracao-ulbra.md` (fonte: mensagem da gestão nesta sessão). Mudanças Prime seguem a regra.
- **Identidades:** apenas as necessárias para configurar e testar o piloto: `cobranca10@aelbra.com.br` (operador piloto). Demais nomes nos documentos históricos não são identidades de implantação.

## 7. Mapeamento de aplicação (preencher após aplicar)
| Ordem | Arquivo | sha256 | name | versão gerada | registrada em |
|---|---|---|---|---|---|
| 1 | 20261111140000 | fcd27030… | ulbra_conexao_individual_e_envio | (a registrar) | (a registrar) |
| 2 | 20261116150000 | 1b448d8b… | ulbra_historico_reservar_portao_interno | (a registrar) | (a registrar) |
| 3 | 20261117120000 | dcd8df53… | ulbra_gravar_conexao_atomica | (a registrar) | (a registrar) |

## 8. Ações que exigem o seu aceite
1. Mesclar a PR (após CI verde no head final e Guardião sem reprovação).
2. Aplicar a migration 1, depois a 2, depois a 3 (uma aprovação para cada).
3. Criar `ULBRA_TOKENS_CHAVE`.
4. Publicar `ulbra-conversa`.
5. Configurar `ULBRA_HISTORICO_PILOTO_EMAILS=cobranca10@aelbra.com.br`.
6. Ativar `ULBRA_HISTORICO_HABILITADO=true`.
7. Decisão separada: rotação do token central (fora deste procedimento).
