# Evidência de catálogo — `public.usuario_e_gestao()` (somente leitura, 16/11/2026)

**Procedimento:** consulta de leitura em `pg_proc` / `pg_namespace` no projeto de produção. Nenhum DDL, nenhum DML, nenhuma alteração de grant ou de Auth.

## Resultado

| Atributo | Valor |
|---|---|
| Nome e overloads | `usuario_e_gestao`, 1 overload em `public` |
| Dono | `postgres` |
| Segurança | `SECURITY DEFINER` |
| `search_path` (proconfig) | `search_path=public` |
| Volatilidade | `STABLE` (`s`) |
| ACL (proacl) | `postgres`, `authenticated`, `service_role` e `reativa_responsavel_executor` com EXECUTE (sem `PUBLIC` nem `anon`) |
| `md5(prosrc)` | `889cfa4a82e9046b4322e8c85ee07b7d` |

O corpo é uma comparação do e-mail do JWT com uma lista fixa de três identificadores institucionais. **A lista não é reproduzida neste documento.** A cópia exata fica em acesso restrito; a referência (SHA-256 e tamanho) está em `docs/seguranca/evidencias/REFERENCIA_prod_usuario_e_gestao.md`.

## Versionamento no repositório

- Nenhuma migration em `supabase/migrations/` cria ou substitui `public.usuario_e_gestao`.
- Nenhum arquivo do ledger (`supabase/ledger/`) define a função; os arquivos que a citam apenas a usam.
- A função existe em produção sem migration versionada. A migration `20261114120000` a usa; por isso é dependência de implantação desta entrega.

## Limites da reprodução

- **No CI, a função é um stub** em `supabase/tests/tabulacao_termo_fisico_gestao/01_ambiente.sql`, com identificadores de teste. Os testes de gestão provam a lógica de autorização com esse stub, **não** a lista nem as permissões reais de produção.
- A instalação em banco descartável exige que a função já exista. A migration verifica isso e falha explicitamente se faltar (pré-condições de `usuario_e_gestao()`, `app_usuario_ativo()` e `tabulacoes`). A migration nunca cria essas dependências.

## Decisão de regularização (sem migration executável)

- **Não** criar migration `create or replace` para esta função: `CREATE OR REPLACE` restaura grants padrão e poderia alterar o `reativa_responsavel_executor` e outros grants existentes.
- A regularização é documental. Uma migration de reconciliação só será proposta depois de a gestão decidir a lista de identificadores e os grants, com verificação de ACL antes e depois.

## Pendências

- **Cópia exata com identificadores institucionais:** retirada do repositório e mantida em acesso restrito (ver referência). Ação: a gestão define o destino de equipe.
- O papel `reativa_responsavel_executor` tem EXECUTE. Não há evidência de que cliente o assuma com `SET ROLE` (ver bloqueio do papel na v2).
- Os identificadores da lista de gestão não são usados nem decididos por esta entrega. Qualquer alteração de alcance é decisão da gestão, fora desta #954.
