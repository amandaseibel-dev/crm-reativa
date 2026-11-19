# Implantação da leitura do histórico ULBRA (procedimento VIGENTE)

Único procedimento operacional vigente. `pacote-historico-e-resposta-2026-11-11.md`, `piloto-token-pessoal-2026-11-17.md` e `corretiva-reserva-historico-2026-11-18.md` são histórico de revisão.

**Escopo:** leitura do histórico pela conexão individual do operador. Não configura envio nem OAuth. Cada etapa exige aceite específico. Nada é executado por este documento.

**Legenda:** [ARQ] hash do arquivo versionado, conferível no repositório. [PRÉ] pré-condição a conferir antes da etapa. [POS] verificação posterior à aplicação.

## 1. Arquivos revisados [ARQ]
Pasta: `supabase/aguardando_aprovacao/` (não `supabase/migrations/`). sha256 do conteúdo versionado:

| Ordem | Arquivo | sha256 | name de aplicação |
|---|---|---|---|
| 1 | `20261111140000_ulbra_conexao_individual_e_envio.sql.pendente` | `fcd270305358c69db33e25072c1c0288fd0cbf7dc129bd1b6147fef1dbb6e691` | `ulbra_conexao_individual_e_envio` |
| 2 | `20261116150000_ulbra_historico_reservar_portao_interno.sql.pendente` | `14c8a3a0f50b32023e05a28ec1db94b9419b8bbef89845fb9e35fff5eec6f9ff` | `ulbra_historico_reservar_portao_interno` |
| 3 | `20261117120000_ulbra_gravar_conexao_atomica.sql.pendente` | `a7d6f18375f6ee2408189f935906e6205ba805f345a4cef7f5a38dbd35dbd77a` | `ulbra_gravar_conexao_atomica` |

Rollbacks (mesma pasta, nomes completos `<versão>_<name>.rollback.sql`):
- `20261111140000_ulbra_conexao_individual_e_envio.rollback.sql` — `f6b8013e8c43ff2f917dbf8839ac103b93e53c991b299b1cd1bc83e09d8e760f`
- `20261116150000_ulbra_historico_reservar_portao_interno.rollback.sql` — `0ce5817536e8ff0fddf62ecb19d5611602741228d2a318ab799f8d0fd58c2d95`
- `20261117120000_ulbra_gravar_conexao_atomica.rollback.sql` — `8f3b4449b527bcfb6d1125b51371336ef1112d49a0e1b9f2933a22ff97d04942`

**Ordem (dependências verificadas pelo texto):** a 3 usa `ulbra_conexoes_operador`, criada pela 1 → 3 depois de 1. A 2 usa `ulbra_historico_reservar` e `ulbra_historico_uso`, criadas por `20261110100000` e sem dependência com 1 ou 3 → ordem cronológica 1 → 2 → 3.

**search_path (resolvido):** as migrations 2 e 3 e o rollback da 2 usam `SET search_path = public` fixo, conforme `PREMISSA_SEGURANCA_PROJETO.md` §4 (a 3 foi alinhada depois de decisão da gestão; a aplicada da 2 tinha `public, pg_temp`).

## 2. Pré-condições de produção [PRÉ] (não são hash de arquivo)
- `20261110100000_ulbra_historico_orcamento` aplicada (ledger `20261112111006`, `supabase/ledger/2026-11/INDICE.tsv`).
- Migration 1: o `service_role` precisa de INSERT em `public.auditoria` e de `BYPASSRLS`. O próprio arquivo aborta se faltarem.
- Migration 3: a tabela `ulbra_conexoes_operador` existe (criada pela 1). Não há pré-checagem no arquivo; a ordem é imposta pelo procedimento.
- `ULBRA_TOKENS_CHAVE`: observado AUSENTE na tela de Secrets em 18/11/2026. Não versionado. Conferir antes da etapa 7.

## 3. Ledger e md5 [POS]
- Nome de aplicação: o `name` da seção 1. A versão é a gerada pelo mecanismo, registrada após a aplicação.
- **md5:** o ledger registra md5 sobre os `statements` (`supabase/ledger/DUAS-TRILHAS.md`, Fluxo B). Este documento NÃO calcula esse valor: não o inventa. O md5 de referência deve ser obtido pelo método do próprio ledger, sobre o arquivo versionado, ANTES da aplicação, e registrado na seção 8. Sem ele, o passo 6 não tem critério de comparação.
- Registro do drift no ledger: PR própria, após validação (Fluxo B, passo 7; `supabase/ledger/LEIA-ME.md`, regra 4).

## 4. Sequência única (Fluxo B)
Executor: a sessão principal (CLAUDE.md, item 2). Aceite específico em cada etapa com ação.

1. **[PRÉ] Mesclar a PR** com CI concluído sem falha no head final e Guardião sem reprovação no mesmo head. Aceite específico.
2. **[PRÉ]** Deploy de produção `READY`.
3. **Aplicar a migration 1** por `apply_migration`. Aceite específico. Registrar a versão gerada.
4. **Aplicar a migration 2.** Aceite específico.
5. **Aplicar a migration 3.** Aceite específico.
6. **[POS] Validar antes de publicar:** `schema_migrations` com as três versões e os names; md5 do arquivo aplicado igual ao de referência (seção 3); portão presente na `ulbra_historico_reservar`; `authenticated` e `anon` sem EXECUTE; `service_role` com EXECUTE; tabelas e função das migrations 1 e 3. Qualquer divergência interrompe.
7. **[PRÉ] Segredo `ULBRA_TOKENS_CHAVE`.** Aceite específico. Conferir ausência antes.
8. **Publicar `ulbra-conversa`** com `verify_jwt`, a partir da `main`, após `docs/seguranca/CHECKLIST_SEGURANCA_DEPLOY.md`. Aceite específico.
9. **Configurar `ULBRA_HISTORICO_PILOTO_EMAILS`** com o operador piloto (`cobranca10@aelbra.com.br`). Aceite específico. Antes do cadastro.
10. **Cadastro do token** pelo próprio operador, com `ULBRA_HISTORICO_HABILITADO` DESLIGADA. O gate nega qualquer outro usuário antes de validar ou gravar.
11. Tetos da cota: opcionais; padrões 50 por operador e 500 global por dia.
12. **Ativar por último `ULBRA_HISTORICO_HABILITADO=true`.** Aceite específico. Só a partir daqui há leitura.
13. **[POS] Verificar:** uma conversa lida; `ULBRA_HISTORICO_LEITURA` gravado antes do texto; cota reservada antes da chamada à Mensageria.
14. **[POS] Ledger:** PR própria (seção 3).

**Janela a registrar:** o front publicado chama `ulbra-conversa` a partir do merge (passo 1). Antes do passo 8 a função não existe e a chamada falha. Depois do passo 12 há leitura. A trava de etapa da tela de período não foi verificada (ver seção 9).

## 5. Verificações já feitas [fonte]
- **Código:** `ulbra-conversa` não lê `ULBRA_MCP_TOKEN` em código executável. A única ocorrência fora de comentário está em testes que afirmam a ausência (`historico-sem-conexao.test.ts`, `index-historico-ligacao.test.ts`). A leitura usa só a conexão individual do operador.
- **Testes:** a suíte `supabase/functions/ulbra-conversa` foi executada localmente no commit `ab9cce24` (226 testes passaram). Esse commit não é o head final e não há log versionado. O CI do head final NÃO está concluído.
- **Corretiva em PGlite:** `supabase/tests/ulbra_historico_portao/run.mjs` foi executado localmente em banco em memória. Sem log versionado. Não é Postgres real.
- **CI do head final:** pendente de conclusão. O job agregado "testes, build e catracas" não está concluído. Não declarado verde.

## 6. Recuperação
- **Leitura:** `ULBRA_HISTORICO_HABILITADO` ausente ou `false` nega a leitura, sem chamada à Mensageria.
- **Acesso do piloto:** remover o e-mail de `ULBRA_HISTORICO_PILOTO_EMAILS` nega o acesso.
- **Rollbacks, ordem inversa (3 → 2 → 1), só antes de qualquer uso:** `20261111140000_..._rollback.sql` recusa com `ROLLBACK_RECUSADO_HA_HISTORICO` se houver conexões, prévias, envios ou pedidos. Depois do uso, a saída é desativar as flags, não rollback.
- **Rollback 2 (corretiva):** restaura a versão SEM portão. NÃO é recuperação automática; exige decisão expressa.
- **Não executar** o rollback de `20261110100000` (apaga `ulbra_historico_uso`).
- **Não restaurar** a função `ulbra-historico` v1.

## 7. Fora deste procedimento (pendências separadas)
- **Rotação do token central `ULBRA_MCP_TOKEN`:** pendência separada, sem executor nem prazo definidos. Não é pré-requisito do piloto. Nenhuma função de `ulbra-conversa` lê esse token. A validade atual não está comprovada nesta revisão.
- **Preparação do aluno e responsabilidade:** validação operacional posterior, sem atribuição artificial.
- **Regra dos cinco:** a decisão de alcance está confirmada pela responsável em `decisoes-integracao-ulbra.md` (seção "Aceite de governança"). Não há assinatura externa exigida pelos documentos consultados. Ainda não há aceite formal da gestão no sentido de ata; ver seção 9.

## 8. Mapeamento de aplicação [POS]
| Ordem | Arquivo | sha256 | name | versão gerada | md5 de referência | verificado em |
|---|---|---|---|---|---|---|
| 1 | 20261111140000 | fcd27030… | ulbra_conexao_individual_e_envio | (após aplicar) | (obter antes do passo 3) | (após aplicar) |
| 2 | 20261116150000 | 14c8a3a0… | ulbra_historico_reservar_portao_interno | (após aplicar) | (obter antes do passo 4) | (após aplicar) |
| 3 | 20261117120000 | a7d6f183… | ulbra_gravar_conexao_atomica | (após aplicar) | (obter antes do passo 5) | (após aplicar) |

## 9. Decisões e aceites exigidos (uma solicitação)
1. **Contas com leitura global** (`leitura.ts`: `amanda.seibel`, `cobranca04`): hoje dependem da lista do piloto para ler, porque a flag exige o piloto. Decidir se entram em `ULBRA_HISTORICO_PILOTO_EMAILS` (e, se sim, com aceite) ou se ficam fora desta etapa.
2. **search_path das migrations 2 e 3 (resolvido):** alinhadas a `public` (premissa §4), com novos hashes. A função da 3 é `SECURITY INVOKER`, mas a premissa §4 foi aplicada por inteiro, para não abrir exceção.
3. **Janela da tela de período** (`MensageriaPeriodo.jsx`): confirmar que a trava de etapa aplica-se à tela antes do passo 8.
4. **Regra dos cinco:** o aceite formal da gestão ainda não está registrado como ata. Decidir se o registro atual basta ou se a gestão assina o texto de `decisoes-integracao-ulbra.md`.
5. Aceites das etapas 1 a 12 (seção 4), cada um específico.
