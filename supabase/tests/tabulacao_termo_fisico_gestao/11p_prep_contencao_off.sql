-- RESTAURAÇÃO ADMINISTRATIVA (postgres): reverte a contenção e devolve o aluno ao estado de origem. Roda sempre.
\set ON_ERROR_STOP on
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.rollback.sql
update public.alunos set status_atual = 'CONTATAR' where id = 'a0000000-0000-0000-0000-000000000042';
