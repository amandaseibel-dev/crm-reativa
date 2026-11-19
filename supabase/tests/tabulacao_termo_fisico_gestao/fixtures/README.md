# Fixtures de teste — NÃO são migrations nem instruções de produção

`prod_encerramento_so_gestao.sql` contém `CREATE OR REPLACE` da função `_encerramento_so_gestao()`, transcrita de produção (leitura).

- **md5 do corpo da função** (`md5(prosrc)`, o que a comparação de produção usa): `ae0382adc0eaf11fbe68d9ed0fc4a9b4`.
- **hash do arquivo** (`sha256sum`): `cae8f5422b93341fb62debd5e524d10182054ffca7a968cf5b749928ecd3aea9`. São grandezas diferentes; não confundir.
- Executável **apenas em banco descartável de CI**, carregada por `00_barreira_producao.sql` com `\i`.
- **Não executar em produção.** Não é migration, não entra em `supabase/migrations/` e nenhum comando do repositório a aplica.
