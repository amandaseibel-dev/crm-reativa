-- PREPARAÇÃO ADMINISTRATIVA (postgres): aluno com código restrito já gravado + contenção aplicada.
\set ON_ERROR_STOP on
update public.alunos set status_atual = 'TERMO_FISICO_ARQUIVADO' where id = 'a0000000-0000-0000-0000-000000000042';
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.sql.pendente
