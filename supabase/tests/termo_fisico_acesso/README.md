# Teste de acesso — registro administrativo do termo físico

Roda no job `termo-fisico-acesso-sql` do CI, em Postgres 17 descartável, na ordem:

1. `01_ambiente.sql` — **simulação** das dependências do Supabase (ver abaixo);
2. migration `aguardando_aprovacao/20261113120000_aluno_termo_fisico_registro.sql.pendente`;
3. `02_acesso.sql` — privilégios por papel e comportamento de cada perfil;
4. rollback `aguardando_aprovacao/20261113120000_aluno_termo_fisico_registro.rollback.sql`;
5. `03_apos_rollback.sql` — histórico preservado, acessos revogados e triggers ativas;
6. migration de novo (reinstalação) e `04_reinstalacao.sql` — copia do histórico sem duplicar.

## O que é simulado (NÃO é o Supabase real)

- papéis `anon`, `authenticated`, `service_role` e privilégios padrão de `public`;
- `auth.jwt()` lendo `request.jwt.claims`;
- `usuarios` e `app_usuario_ativo()`;
- `usuario_e_gestao()` com o corpo lido em produção por `pg_get_functiondef` (três e-mails);
- `notificacoes` com RLS de leitura por destinatário e de escrita só para gestão.

## O que NÃO é coberto

- outros triggers, grants e extensões reais de produção;
- o comportamento do PostgREST (cabeçalhos, pool, erros HTTP);
- a configuração real do projeto no Supabase.

Por isso o teste prova o desenho do banco, não a instalação em produção. A conferência
das dependências reais é feita por leitura (`pg_get_functiondef`, `information_schema`),
e a validação após aplicação autorizada é descrita na PR de migration.
