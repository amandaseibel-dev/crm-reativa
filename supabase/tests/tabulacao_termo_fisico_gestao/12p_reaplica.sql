-- REAPLICAÇÃO (postgres): on -> off -> on deve ser idempotente; estado final verificado.
\set ON_ERROR_STOP on
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.sql.pendente
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.sql.pendente
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.rollback.sql
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.rollback.sql
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.sql.pendente
do $$ begin
  if (select count(*) from public.termo_fisico_contencao) <> 1 or not (select contencao_ativa from public.termo_fisico_contencao where id) then
    raise exception 'FALHOU reaplicação: estado final não é contido'; end if;
end $$;
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.rollback.sql
