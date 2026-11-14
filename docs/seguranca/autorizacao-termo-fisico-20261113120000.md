# Pacote — registro administrativo do termo físico (20261113120000)

Status: **PENDENTE DE APROVAÇÃO EXPRESSA PARA APLICAÇÃO.** Este documento registra o pacote. Não autoriza, por si só, nenhuma execução em produção. Não há linha em `docs/seguranca/migracoes-aprovadas.tsv`.

## Escopo

Cria a tabela `public.aluno_termo_fisico_eventos` (append-only), RLS, as RPCs `termo_fisico_ler` e `termo_fisico_registrar`, as triggers de bloqueio e avisos em `notificacoes` para os três e-mails de `usuario_e_gestao()`. Não altera alunos, movimentações, casos, fila, fidelização, retorno, acordos, parcelas, títulos, catálogo `tabulacoes` nem efeito financeiro.

## Artefatos (branch `feat/termo-fisico-registro-migracao`, PR #954, commit 4727c6f7705eea0a8401cd2db3f174f22696e55b)

| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261113120000_aluno_termo_fisico_registro.sql.pendente` | `463079e521bdb50bf6dfa8177f2e5b8d6514ade62bd328ae681cac57a1c8a5e1` | 8540 |
| `supabase/aguardando_aprovacao/20261113120000_aluno_termo_fisico_registro.rollback.sql` | `8c0ac2be1b7526f227f17b945c6afe02a2065aa4c83263da87bcbac76eb300fb` | 2221 |

O SHA-256 acima vale para o commit da PR. Se o arquivo mudar, este quadro precisa ser refeito.

## Pré-condições conferidas por leitura em produção

- `usuario_e_gestao()`: `pg_get_functiondef`, só SELECT. Três e-mails (`amanda.seibel@aelbra.com.br`, `cobranca04@aelbra.com.br`, `cobranca07@aelbra.com.br`), `SECURITY DEFINER`, `search_path = public`.
- `notificacoes`: colunas conferidas por `information_schema`; sem `CHECK` em `tipo`.
- Versão `20261113120000`: ausente em `supabase/migrations` e em `supabase/aguardando_aprovacao` na branch base.
- A função `usuario_e_gestao()` **não está versionada no repositório** (confirmado por busca). Por isso a conferência em produção é a única prova do corpo dela.

## Prova antes de aplicar

- Job `termo-fisico-acesso-sql` (Postgres 17 isolado, dependências **simuladas**, ver `supabase/tests/termo_fisico_acesso/README.md`): aplica a migration, roda o acesso por papel, o rollback, a reinstalação e a conferência de privilégios. Não substitui teste em staging.
- Staging não acessível nesta conta: os testes de perfis contra o Supabase real ficam como pendência.

## Efeito e reversão

- Rollback (`.rollback.sql`): remove as RPCs, **renomeia** a tabela e o índice (`aluno_termo_fisico_eventos_descartada_20261113` e `..._descartada_20261113_aluno_idx`), mantém as triggers e retira todo acesso dos papéis da aplicação, inclusive PUBLIC. Não apaga dados.
- Reinstalação: documentada no próprio rollback (copia com `on conflict (id) do nothing`; a tabela arquivada continua sem acesso; o índice volta com o nome original, porque foi renomeado no rollback).

## Aviso de notificação (decisão pendente da gestão)

A policy `notificacoes_select` em produção (lida por leitura) libera a linha a `usuario_e_gestao_fila()`, que inclui os perfis `gerencia`, `supervisor` e `administrativo`. Por isso o aviso **não leva** `aluno_id`, situação nem autor: mensagem genérica, "Registro administrativo atualizado". Mesmo assim, esses perfis veem que existe um aviso de termo físico. Restringir isso exige mudar a policy existente, que afeta outros fluxos. Alternativa: não notificar pelo canal (a gestão combina por fora). **Decisão necessária antes da aplicação.**

## Aprovação

Para aplicar, a gestão deve, no momento da aprovação, publicar em `docs/seguranca/migracoes-aprovadas.tsv` uma linha com `status=pendente`, `expira_em` de 30 minutos a partir da aprovação e o executor nominal, conforme `docs/RUNBOOK-MIGRATIONS.md` §6. Esta etapa **não** publica essa linha.

O nome da migration segue `<14 dígitos>_<descrição>`. A versão é gravada pelo relógio UTC do `apply_migration` (§6).
