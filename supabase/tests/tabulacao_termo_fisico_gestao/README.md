# Tabulação de termo físico restrita à gestão — testes

Job `tabulacao-termo-fisico-gestao-sql` (Postgres 17 descartável). Dois caminhos:

**Caminho A — com histórico:** `01_ambiente.sql` → migração → `02_tabulacao.sql` (gestão permitida,
operador recusado com todas as variantes, desfazer recusado inteiro, anon/sem perfil/diretoria,
escopo, triagem, não acionamento) → rollback **deve falhar** (há histórico) → `03_rollback_recusado.sql`
(nada removido nem alterado).

**Caminho B — banco limpo:** reinicia o schema → `01_ambiente.sql` → migração → rollback (deve passar)
→ `04_rollback_limpo.sql` (linhas, trigger e função removidas; demais tabulações intactas).

Barreira de estado (alunos): `00_barreira_producao.sql` carrega a função de produção (`supabase/tests/tabulacao_termo_fisico_gestao/fixtures/prod_encerramento_so_gestao.sql` (fixture de teste, não produção)) e a trigger real; `05_barreira_alunos.sql` roda com papel de LOGIN, porque a função deixa passar `session_user = postgres`.

Simulado (não é o Supabase real): papéis e privilégios padrão de `public`; `auth.jwt()`/`auth.role()`;
`usuarios`/`app_usuario_ativo()`; `usuario_e_gestao()` com o corpo lido em produção; `eh_tipo_acionamento()`
com a lista lida em produção; `tabulacoes` e `aluno_movimentacoes` com colunas de produção (subconjunto
de linhas). A policy de UPDATE de `aluno_movimentacoes` é simulada: a de produção não está versionada.

Coberto no CI com PostgREST 16.5 real (job `tabulação termo físico`, passo PostgREST). Não coberto: RLS real, grants reais, outros triggers de produção, locale de produção,
staging (inacessível nesta conta).
