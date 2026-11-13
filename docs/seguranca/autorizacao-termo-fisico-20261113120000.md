# Pacote — registro administrativo do termo físico (20261113120000)

Status: **PENDENTE DE APROVAÇÃO EXPRESSA PARA APLICAÇÃO.** Este documento registra o pacote. Não autoriza, por si só, nenhuma execução em produção. Não há linha em `docs/seguranca/migracoes-aprovadas.tsv`.

## Escopo

Cria a tabela `public.aluno_termo_fisico_eventos` (append-only), RLS, as RPCs `termo_fisico_ler` e `termo_fisico_registrar`, as triggers de bloqueio e avisos em `notificacoes` para os três e-mails de `usuario_e_gestao()`. Não altera alunos, movimentações, casos, fila, fidelização, retorno, acordos, parcelas, títulos, catálogo `tabulacoes` nem efeito financeiro.

## Artefatos (branch `feat/termo-fisico-registro-migracao`, PR #954)

| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261113120000_aluno_termo_fisico_registro.sql.pendente` | `898a989b85a965b95a14e925ef4d50d43e44fcc43bb18dc9afb2c1a08f8b6844` | 8118 |
| `supabase/aguardando_aprovacao/20261113120000_aluno_termo_fisico_registro.rollback.sql` | `8dcce04650aa8e65e98ab75230bd859ff92f9ab5cdf03b6ea1871a169e76aca9` | 1936 |

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

- Rollback (`.rollback.sql`): remove as RPCs, **renomeia** a tabela para `aluno_termo_fisico_eventos_descartada_20261113`, mantém as triggers e retira todo acesso dos papéis da aplicação. Não apaga dados.
- Reinstalação: documentada no próprio rollback (copia com `on conflict (id) do nothing`; a tabela arquivada continua sem acesso).

## Aprovação

Para aplicar, a gestão deve, no momento da aprovação, publicar em `docs/seguranca/migracoes-aprovadas.tsv` uma linha com `status=pendente`, `expira_em` de 30 minutos a partir da aprovação e o executor nominal, conforme `docs/RUNBOOK-MIGRATIONS.md` §6. Esta etapa **não** publica essa linha.

O nome da migration segue `<14 dígitos>_<descrição>`. A versão é gravada pelo relógio UTC do `apply_migration` (§6).
