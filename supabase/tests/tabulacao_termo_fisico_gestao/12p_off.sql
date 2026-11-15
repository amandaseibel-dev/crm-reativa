-- RESTAURAÇÃO ADMINISTRATIVA (postgres): reverte a contenção. Roda sempre.
\set ON_ERROR_STOP on
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.rollback.sql
