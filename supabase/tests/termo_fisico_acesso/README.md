# Teste de acesso — registro do termo físico

Roda a migration `20261113120000_aluno_termo_fisico_registro.sql` (e, opcionalmente,
o rollback) num Postgres **local em memória** (pglite), com um stub do Supabase:
papéis `anon`, `authenticated`, `service_role`, privilégios padrão do schema `public`,
`auth.jwt()`, RLS de `notificacoes` e a função `usuario_e_gestao()` com o mesmo corpo
lido em produção (três e-mails).

**Não toca em nenhum banco real.** Não está no CI.

Como rodar (fora do repositório, para não adicionar dependência ao projeto):

```bash
mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @electric-sql/pglite@0.2
node /caminho/do/repo/supabase/tests/termo_fisico_acesso/teste-acesso.mjs \
  /caminho/do/repo/supabase/migrations/20261113120000_aluno_termo_fisico_registro.sql \
  /caminho/do/repo/supabase/migrations/20261113120000_aluno_termo_fisico_registro.rollback.sql
```

O que cobre: privilégios por papel (tabela e funções), comportamento de cada perfil
(anon, operador, ADM, Fernanda, Amanda gestora), avisos só para os destinatários,
UPDATE/DELETE/TRUNCATE bloqueados até para o dono, rollback que preserva o histórico
e reinstalação sem duplicar.

**Não cobre:** a execução no Supabase real (staging), os grants reais depois de
aplicar, nem o corpo de `usuario_e_gestao()` em produção (conferido à parte, por leitura).
