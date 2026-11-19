-- Barreira de ESTADO em alunos, como em produção (texto lido em produção nesta sessão,
-- ver supabase/tests/tabulacao_termo_fisico_gestao/fixtures/prod_encerramento_so_gestao.sql (fixture de teste, não produção)).
-- Carrega a função REAL de produção e a trigger real. Roda antes da migração.
\i supabase/tests/tabulacao_termo_fisico_gestao/fixtures/prod_encerramento_so_gestao.sql
;
CREATE TRIGGER trg_encerramento_so_gestao BEFORE UPDATE OF status_atual, status_jornada, status_acionamento ON public.alunos FOR EACH ROW EXECUTE FUNCTION _encerramento_so_gestao();
