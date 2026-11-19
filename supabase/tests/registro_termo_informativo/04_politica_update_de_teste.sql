-- PREPARAÇÃO (postgres, banco descartável): cria uma policy de UPDATE SOMENTE de teste, para exercitar o gatilho
-- na transição. Não existe em produção e é removida em 06.
\set ON_ERROR_STOP on
create policy teste_update_permissivo on aluno_movimentacoes for update to authenticated using (true) with check (true);
