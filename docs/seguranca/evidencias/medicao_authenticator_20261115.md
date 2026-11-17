# Medição do authenticator — produção (somente leitura)

Projeto: ahattpqrjmhkzsmnbdzs · Medido em: 2026-11-15 18:35:00 UTC · Consulta: leitura de pg_roles e pg_auth_members. Nenhum papel, grant, Auth ou dado foi alterado.

## pg_roles
| papel | rolinherit | rolcanlogin | rolbypassrls |
|---|---|---|---|
| authenticator | false | true | false |
| authenticated | true | false | false |
| anon | true | false | false |
| service_role | true | false | true |

## pg_auth_members (membro = authenticator)
| papel | admin_option | inherit_option | set_option |
|---|---|---|---|
| anon | false | false | true |
| authenticated | false | false | true |
| service_role | false | false | true |

## Conclusão
NOINHERIT representa este projeto: o authenticator não herda privilégios de anon, authenticated ou service_role; só alcança um papel via SET ROLE. A variante INHERIT é cenário defensivo, testado separadamente, e não descreve produção.
