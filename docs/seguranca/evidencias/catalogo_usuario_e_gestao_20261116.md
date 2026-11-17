# Evidência de catálogo — `public.usuario_e_gestao()` (somente leitura, 16/11/2026)

**Procedimento:** consulta de leitura em `pg_proc` / `pg_namespace` no projeto de produção (`ahattpqrjmhkzsmnbdzs`). Nenhum DDL, nenhum DML, nenhuma alteração de grant ou de Auth.

## Resultado

| Atributo | Valor |
|---|---|
| Nome e overloads | `usuario_e_gestao`, 1 overload em `public` |
| Dono | `postgres` |
| Segurança | `SECURITY DEFINER` |
| `search_path` (proconfig) | `search_path=public` |
| Volatilidade | `STABLE` (`s`) |
| ACL (proacl) | `{postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres, reativa_responsavel_executor=X/postgres}` |
| Execute para `PUBLIC` ou `anon` | **não concedido** (não aparece na ACL) |
| `md5(prosrc)` | `889cfa4a82e9046b4322e8c85ee07b7d` |

Corpo (evidência de leitura anterior, `docs/seguranca/evidencias/prod_usuario_e_gestao.sql`): `select lower(coalesce(auth.jwt()->>'email','')) in ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br');`

## Versionamento no repositório

- Nenhuma migration em `supabase/migrations/` cria ou substitui `public.usuario_e_gestao`. A busca por `create ... function ... usuario_e_gestao` no repositório não encontra definição.
- Nenhum arquivo do ledger (`supabase/ledger/`) define a função; os arquivos que a citam apenas a usam.
- Conclusão: a função existe em produção sem migration versionada que a crie. Ela é chamada pela migration `20261114120000` (testes e gatilho), por isso é dependência desta #954.

## Decisão de regularização (sem migration executável)

- **Não** criar migration `create or replace` para esta função: `CREATE OR REPLACE` restaura grants padrão e poderia remover o `reativa_responsavel_executor` e outros grants existentes (ver premissa de grants de função nova em `docs/seguranca/`).
- A regularização é **documental**: este arquivo é o registro versionado do catálogo e do corpo. Uma migration de reconciliação só será proposta, como `.pendente`, depois de a gestão decidir o conjunto exato de e-mails e o conjunto exato de grants, e com verificação de ACL antes e depois.

## Pontos para a gestão decidir (não resolvidos aqui)

- O corpo inclui `cobranca07@aelbra.com.br`. Outras partes do repositório tratam essa conta de forma distinta (por exemplo, a lista da `ulbra-historico` retirou `cobranca07`). A decisão de alcance não é desta #954.
- O papel `reativa_responsavel_executor` tem `EXECUTE` na função e na ACL. Não há evidência neste arquivo de que ele seja usado por cliente com `SET ROLE` (ver bloqueio 4 da v2).
