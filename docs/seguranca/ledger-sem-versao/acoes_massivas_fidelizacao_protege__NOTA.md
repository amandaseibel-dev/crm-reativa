# SEM-VERSAO — acoes_massivas_fidelizacao_protege(timestamptz, timestamptz)

**Objeto existente em produção sem migration no repositório e sem versão em `schema_migrations`.**

- Investigação 16/11/2026, leitura em produção: nenhum statement de `supabase_migrations.schema_migrations` contém `acoes_massivas_fidelizacao_protege`.
- Definição viva em produção: md5 `cfab30b8673b09965a1f7098cd25e31b` (`pg_get_functiondef`). O arquivo `SEM-VERSAO__acoes_massivas_fidelizacao_protege.sql` é esse texto exato, verificado pelo teste de banco.
- É uma função SQL `STABLE`, **não** SECURITY DEFINER, sem dado. Chamada pela função de e-mails.
- **ACL efetiva:** `EXECUTE` para `anon` e `public` (ACL com `=X`). Não é objeto desta PR. Registrado para decisão própria (sugestão: revogar `anon`/`public`, se não houver chamador anônimo).

**Pendência para a gestão:** a versão em que foi criada não é conhecida. Não inventar versão. Decidir se o registro vira linha no `INDICE.tsv` (com `arquivo = -`) quando houver a versão.

Não reaplicar. Este arquivo só registra a definição.
