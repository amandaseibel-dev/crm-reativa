# Fixtures de teste — NÃO são migrations nem instruções de produção

`prod_encerramento_so_gestao.sql` contém `CREATE OR REPLACE` da função `_encerramento_so_gestao()`, transcrita de produção (leitura, md5 `ae0382…`). Ela existe só para o teste de barreira de estado.

- **Executável apenas em banco descartável de CI**, carregada por `00_barreira_producao.sql` com `\i`.
- **Não executar em produção.** Não é migration, não entra em `supabase/migrations/` e não é aplicada por nenhum comando do repositório.
- Conteúdo preservado sem alteração (SHA-256 `cae8f5422b93341fb62debd5e524d10182054ffca7a968cf5b749928ecd3aea9`).
