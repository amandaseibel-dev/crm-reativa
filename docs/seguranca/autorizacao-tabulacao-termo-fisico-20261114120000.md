# Pacote — tabulação de termo físico restrita à gestão (20261114120000)

Status: **PENDENTE DE APROVAÇÃO EXPRESSA PARA APLICAÇÃO.** Este documento registra o pacote. Não autoriza, por si só, nenhuma execução em produção. Não há linha em `docs/seguranca/migracoes-aprovadas.tsv`.

## Escopo (mudança mínima)

- Duas linhas novas em `public.tabulacoes` (catálogo existente), `somente_gestao = true`, ativas, retorno `NENHUM`, próxima ação `CONTATAR`, `efeito_desfecho` nulo:
  - `TERMO_FISICO_EM_ANDAMENTO` — "Possui termo físico assinado, em andamento"
  - `TERMO_FISICO_ARQUIVADO` — "Termo físico arquivado, quitado"
- Trigger `aluno_mov_tabulacao_so_gestao` (BEFORE INSERT em `aluno_movimentacoes`) com função `aluno_movimentacao_tabulacao_so_gestao()`: recusa, no servidor, gravação de código `somente_gestao` por quem não é gestão (erro 42501 com mensagem "restrita à gestão"). Bypass: `service_role` (claim) e chamada sem `SET ROLE` (dono, migrações, RPCs de sistema).

**Não cria tabela nem RPC.** Não altera `alunos`, baixa, contato, fidelização, retorno, fila, nem efeito financeiro. O registro grava só no histórico (tipo `REGISTRO_ADMINISTRATIVO`, que não está em `eh_tipo_acionamento`).

## Artefatos

| PR | Branch | Commit (HEAD) |
|---|---|---|
| #954 (banco) | `feat/termo-fisico-registro-migracao` | a preencher no commit do pacote |
| #951 (front) | `feat/tabulacao-termo-fisico` | a preencher |

| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `fab2d078bcbb8ee78c4ffd625d278c041119cc639d9d9d7da4c645f53c6cd317` | 2979 |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `9c09136ace6a945293452a3f41ba95f66ab47db17ea75301413c68cb1dd2ac3d` | 654 |

Se algum arquivo mudar, este quadro precisa ser refeito.

## Pré-condições conferidas por leitura em produção (só SELECT)

- `usuario_e_gestao()`: três e-mails (`amanda.seibel@aelbra.com.br`, `cobranca04@aelbra.com.br`, `cobranca07@aelbra.com.br`), `SECURITY DEFINER`, `search_path = public`.
- `tabulacoes`: colunas conferidas (inclui `somente_gestao`, `efeito_desfecho`, `redireciona_para_email`, `criado_por`, `desativada_em`). Linhas `RETORNO_FINANCEIRO`, `JURIDICO` e outras já são `somente_gestao = true`; os dois códigos novos não existem ainda.
- `_encerramento_so_gestao()` (trigger em `alunos`): já lê `somente_gestao` do catálogo dinamicamente. Mesmo padrão da nova trigger.
- `trg_tabulacao_efeito_financeiro`: só dispara para códigos com `efeito_desfecho` preenchido. Linhas novas com `efeito_desfecho` nulo não geram efeito.
- `fn_atualizar_ultimo_acionamento`: só aciona quando `eh_tipo_acionamento(tipo)` é verdadeiro. `REGISTRO_ADMINISTRATIVO` não está na lista (12 tipos lidos em produção).
- Triggers de `aluno_movimentacoes` em produção: `trg_atualizar_ultimo_acionamento`, `trg_sincronizar_elogio_da_movimentacao`, `trg_zz_desfazer_cartao_tabulacao`. **Não conferido o corpo de `trg_zz_desfazer_cartao_tabulacao`** (ver limites).
- Policy `aluno_movimentacoes_insert` (operador só grava com o próprio e-mail; gestão grava tudo): lida.

## Prova antes de aplicar (não aplicado)

- Job `tabulacao-termo-fisico-gestao-sql` no CI (Postgres 17 descartável, dependências **simuladas**): migração, gestão permitida (Amanda, ADM, Fernanda), operador recusado (código exato, com espaço e minúsculas, código só-gestão já existente, `FINALIZACAO_ATENDIMENTO` com código restrito), operador grava tabulação comum, gestão inativa recusada pela RLS, histórico com autor/data/hora, ausência de efeitos (tipo não é acionamento, `efeito_desfecho` nulo, retorno `NENHUM`, próxima ação `CONTATAR`), rollback.
- Teste de recusa é checado por SQLSTATE (42501) e por texto da mensagem.

## NÃO verificado

- **Staging:** inacessível nesta conta. Nada contra o Supabase real.
- **PostgREST:** o `SET ROLE` do Supabase é simulado.
- **`trg_zz_desfazer_cartao_tabulacao`** em produção: corpo não lido; pode reagir a `FINALIZACAO_ATENDIMENTO` e não ao tipo novo. Precisa de leitura antes da aplicação.
- **Efeito de redirecionamento:** `trg_tabulacao_redireciona` (coluna `redireciona_para_email`) — nulo nas linhas novas; corpo não lido.
- **Gate A (`scripts/seguranca/auditoria_seguranca.sql`):** o script tem um defeito: o `ORDER BY` final, com expressão, é inválido depois de `UNION` no PostgreSQL (erro 0A000). Não roda como está. Execução de linha de base pendente após correção do script, com autorização.
- **Owner ou superuser** pode desabilitar a trigger; não coberto.
- **Operadores que tenham movimentações históricas com códigos só-gestão** (os 8 casos citados na função de encerramento foram feitos pela gestão): a trigger passa a recusar também o operador nesses códigos. Esperado, mas precisa confirmação.

## Reversão

Rollback (`.rollback.sql`): remove a trigger e a função; **desativa** (não apaga) as duas linhas do catálogo (`ativa = false`, `desativada_em`, `desativada_por = 'rollback_termo_fisico'`); o histórico já gravado permanece. Não há tabela nem RPC a reverter.

## Ordem de implantação (explícita)

1. Corrigir e rodar o Gate A (linha de base antes; após a aplicação, de novo), com autorização.
2. Ler `trg_zz_desfazer_cartao_tabulacao` e `trg_tabulacao_redireciona` em produção (só SELECT) e confirmar que não reagem ao tipo novo.
3. Aprovar a linha em `docs/seguranca/migracoes-aprovadas.tsv` (RUNBOOK §6, expiração e executor nominal). Não feito aqui.
4. Aplicar a migration (executor único, sessão principal) com autorização nominal.
5. Validação somente leitura: as duas linhas do catálogo existem com `somente_gestao = true`; a trigger existe; sem linhas novas no histórico.
6. **Só então** mesclar a #951 (front).
