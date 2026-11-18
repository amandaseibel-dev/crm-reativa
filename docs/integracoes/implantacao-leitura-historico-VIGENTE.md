# Implantação da leitura do histórico ULBRA (procedimento VIGENTE)

Único procedimento operacional vigente. `pacote-historico-e-resposta-2026-11-11.md`, `piloto-token-pessoal-2026-11-17.md` e `corretiva-reserva-historico-2026-11-18.md` são histórico de revisão e não definem ordem nem configuração.

**Escopo congelado:** leitura do histórico pela conexão individual do operador. Não configura envio nem OAuth. Cada etapa abaixo exige aceite específico; nada é executado por este documento.

**Legenda:** [ARQ] = hash do arquivo revisado (verificável no repositório). [PRÉ] = pré-condição a conferir antes da etapa. [POS] = verificação posterior à aplicação (não existe antes dela).

## 1. Arquivos revisados (ARQ)
Pasta: `supabase/aguardando_aprovacao/` (não `supabase/migrations/`). sha256 do conteúdo no repositório:

| Ordem | Arquivo | sha256 | name de aplicação |
|---|---|---|---|
| 1 | `20261111140000_ulbra_conexao_individual_e_envio.sql.pendente` | `fcd270305358c69db33e25072c1c0288fd0cbf7dc129bd1b6147fef1dbb6e691` | `ulbra_conexao_individual_e_envio` |
| 2 | `20261116150000_ulbra_historico_reservar_portao_interno.sql.pendente` | `1b448d8b0c2be6b5feca9e1900fa772b919c22da62d0752540e20cbd02f58402` | `ulbra_historico_reservar_portao_interno` |
| 3 | `20261117120000_ulbra_gravar_conexao_atomica.sql.pendente` | `dcd8df5388cbdc5e2c20576b0dd9044b23dcd9667ad8f230f2e653b461671ed8` | `ulbra_gravar_conexao_atomica` |

Rollbacks (mesma pasta): `20261111140000.rollback.sql` `f6b8013e8c43ff2f917dbf8839ac103b93e53c991b299b1cd1bc83e09d8e760f`; `20261116150000.rollback.sql` `be7b2c64ad7d7e0c4dddb1627a3989678dcbd80537edfd59814f2538e2517113`; `20261117120000.rollback.sql` `8f3b4449b527bcfb6d1125b51371336ef1112d49a0e1b9f2933a22ff97d04942`.

**Ordem e dependências (verificadas pelo texto dos arquivos):**
- `20261117120000` usa `ulbra_conexoes_operador`, criada por `20261111140000` → a 3 vem depois da 1.
- `20261116150000` usa `ulbra_historico_reservar` e `ulbra_historico_uso`, criadas por `20261110100000` → independe da 1 e da 3.
- Sem dependência entre 2 e 1/3: ordem cronológica. Logo: 1 → 2 → 3.

## 2. Definições de produção (PRÉ / POS, não ARQ)
- **Pré-condição a conferir antes da etapa 3:** `20261110100000_ulbra_historico_orcamento` aplicada (ledger `20261112111006`, `supabase/ledger/2026-11/INDICE.tsv`).
- **[PRÉ] Migration 1:** o `service_role` precisa de INSERT em `public.auditoria` e de `BYPASSRLS`. O próprio arquivo aborta se faltarem.
- **[PRÉ] Migration 2:** a função `ulbra_historico_reservar` existe; a definição aplicada ainda não tem o portão.
- **[PRÉ] `ULBRA_TOKENS_CHAVE`:** observado AUSENTE na tela de Secrets em 18/11/2026. Não versionado. Conferir de novo antes da etapa 7.
- **[POS] Definição após a aplicação da 2:** portão presente; `authenticated` e `anon` sem EXECUTE; `service_role` com EXECUTE.

## 3. Registro no ledger (POS, após validação)
- Nome de aplicação: o `name` da tabela da seção 1. A versão é a gerada pelo mecanismo, registrada após a aplicação. NÃO é antecipada.
- Md5 de referência: o método do repositório é `md5(array_to_string(statements, E'\n'))` (`supabase/ledger/DUAS-TRILHAS.md`). O valor de referência é obtido da aplicação, não antes dela.
- Registro do drift: PR própria, depois da validação, conforme `supabase/ledger/DUAS-TRILHAS.md` (Fluxo B, passo 7) e `supabase/ledger/LEIA-ME.md` (regra 4: nome que produção registrou).

## 4. Sequência única (Fluxo B)
Executor: a sessão principal (CLAUDE.md, item 2). Cada etapa tem aceite próprio.

1. **[PRÉ] Mesclar a PR:** CI concluído sem falha no head final e Guardião sem reprovação no mesmo head. Aceite específico.
2. **[PRÉ]** Deploy de produção `READY`.
3. **Aplicar a migration 1** (`20261111140000`) por `apply_migration`. Aceite específico. Registrar a versão gerada (seção 3).
4. **Aplicar a migration 2** (`20261116150000`). Aceite específico.
5. **Aplicar a migration 3** (`20261117120000`). Aceite específico.
6. **[POS] Validar antes de publicar:** `schema_migrations` com as três versões e os names; md5 aplicado igual ao de referência (seção 3); portão, grants e tabelas conforme a seção 2. Divergência interrompe.
7. **[PRÉ] Segredo `ULBRA_TOKENS_CHAVE`:** aceite específico; conferir ausência antes.
8. **Publicar `ulbra-conversa`** com `verify_jwt`, a partir da `main`, após o checklist `docs/seguranca/CHECKLIST_SEGURANCA_DEPLOY.md`. Aceite específico.
9. **Configurar `ULBRA_HISTORICO_PILOTO_EMAILS`** com a identidade do operador piloto (`cobranca10@aelbra.com.br`). Aceite específico. Antes do cadastro.
10. **Cadastro do token** pelo próprio operador, com `ULBRA_HISTORICO_HABILITADO` DESLIGADA. O gate nega qualquer outro usuário antes de validar ou gravar.
11. Tetos da cota: opcionais; padrões 50 por operador e 500 global por dia.
12. **Ativar por último** `ULBRA_HISTORICO_HABILITADO=true`. Aceite específico. Só a partir daqui há leitura.
13. **[POS] Verificar:** uma conversa lida; `ULBRA_HISTORICO_LEITURA` gravado antes do texto; cota reservada antes da chamada à Mensageria.
14. **[POS] Ledger:** PR própria (seção 3).

## 5. Verificações já feitas (fonte indicada)
- **Código:** `ulbra-conversa` não lê `ULBRA_MCP_TOKEN` em código executável. A única ocorrência fora de comentário é a de testes que afirmam a ausência (`historico-sem-conexao.test.ts`, `index-historico-ligacao.test.ts`). A leitura usa só a conexão individual do operador.
- **Testes locais:** 226 testes do `supabase/functions/ulbra-conversa` passaram no commit `ab9cce24`. Não reconferidos no head final.
- **Corretiva em banco em memória (PGlite):** `node supabase/tests/ulbra_historico_portao/run.mjs <raiz>` passou nesta revisão. Sem log versionado.
- **CI do head final:** pendente de conclusão. Não declarado verde.

## 6. Recuperação
- **Leitura:** `ULBRA_HISTORICO_HABILITADO` ausente ou `false` nega a leitura imediatamente, sem chamada à Mensageria.
- **Acesso do piloto:** remover o e-mail de `ULBRA_HISTORICO_PILOTO_EMAILS` nega o acesso.
- **Rollbacks, ordem inversa (3 → 2 → 1), só antes de qualquer uso:** `20261111140000.rollback.sql` recusa com `ROLLBACK_RECUSADO_HA_HISTORICO` se houver conexões, prévias, envios ou pedidos. Depois do uso (passo 10 em diante), a saída é desativar as flags, não rollback.
- **Corretiva (2):** o rollback restaura a versão SEM portão. Não é recuperação automática. Exige decisão expressa.
- **Não executar** o rollback de `20261110100000` (apaga `ulbra_historico_uso`).
- **Não restaurar** a função `ulbra-historico` v1.
- **Leitura global:** as contas fixas em `leitura.ts` têm leitura global, independente da lista do piloto. A lista só restringe quem pode ler; não concede leitura global.

## 7. Fora deste procedimento (pendências separadas)
- **Rotação do token central `ULBRA_MCP_TOKEN`:** pendência separada, sem decisão de executor ou prazo. Não é pré-requisito do piloto. Consumidores no código da `ulbra-conversa`: nenhum. Os demais consumidores precisam de inventário da gestão. A validade atual do token não está comprovada nesta revisão.
- **Preparação do aluno e responsabilidade:** validação operacional posterior. Sem atribuição artificial.
- **Regra dos cinco:** mudanças Prime seguem a regra. Mensageria não exige atualização artificial dos artefatos Prime. Registro e aceite formal: `decisoes-integracao-ulbra.md`, seção "Aceite pendente".

## 8. Mapeamento de aplicação (POS, preencher após aplicar)
| Ordem | Arquivo | sha256 (ARQ) | name | versão gerada | md5 de referência | verificado em |
|---|---|---|---|---|---|---|
| 1 | 20261111140000 | fcd27030… | ulbra_conexao_individual_e_envio | (após aplicar) | (após aplicar) | (após aplicar) |
| 2 | 20261116150000 | 1b448d8b… | ulbra_historico_reservar_portao_interno | (após aplicar) | (após aplicar) | (após aplicar) |
| 3 | 20261117120000 | dcd8df53… | ulbra_gravar_conexao_atomica | (após aplicar) | (após aplicar) | (após aplicar) |

## 9. Aceites exigidos (uma solicitação; cada etapa com aceite próprio)
1. Mesclar a PR (CI verde e Guardião sem reprovação no mesmo head).
2. Aplicar a migration 1, depois a 2, depois a 3.
3. Criar `ULBRA_TOKENS_CHAVE`.
4. Publicar `ulbra-conversa`.
5. Configurar `ULBRA_HISTORICO_PILOTO_EMAILS=cobranca10@aelbra.com.br`.
6. Ativar `ULBRA_HISTORICO_HABILITADO=true`.
