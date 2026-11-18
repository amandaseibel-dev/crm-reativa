# Dependências lidas em produção — carteira_prioridade_bordero

Leitura somente, em 18/11/2026, projeto `ahattpqrjmhkzsmnbdzs`. Nenhuma alteração.

| Objeto | Assinatura | Retorno | Security | Owner | search_path | md5 da definição | ACL |
|---|---|---|---|---|---|---|---|
| `usuario_e_gestao` | `()` | `boolean` | DEFINER | postgres | public | af3d391f4234e6a352585777897568e4 | postgres, authenticated, service_role, reativa_responsavel_executor |
| `aluno_elegibilidade_cobranca` | `(p_aluno_id uuid)` | `elegibilidade_cobranca` | DEFINER | postgres | public | d87c10aac1d733bbf2bdd4683265f3e3 | postgres, service_role (sem authenticated) |

Observações:
- `usuario_e_gestao()` concede gestão por lista fixa de três e-mails no corpo da função.
- `aluno_elegibilidade_cobranca()` não tem EXECUTE para `authenticated`; por isso a RPC nova a chama como definer.
- O corpo completo das duas funções está na leitura de 18/11/2026 (fonte: `pg_get_functiondef`). Reconferir o md5 antes de aplicar a migration.
