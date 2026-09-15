-- ROLLBACK do motor generico de backfill da matricula Prime.
--
-- DESFAZ EM DUAS CAMADAS, e a ordem importa:
--   1. o DADO, lote a lote, usando a trilha -- so o que o backfill escreveu;
--   2. a ESTRUTURA.
--
-- Reverter o dado sem a trilha seria impossivel: `pagamentos.matricula` tambem
-- e preenchida pelo importador desde 28/08. A trilha e o que separa uma coisa
-- da outra -- por isso a reversao passa por ela, nunca por um update em massa.

-- 1) DADO -- descomente e nomeie o lote a reverter.
-- update public.pagamentos p
--    set matricula = null
--   from public.backfill_matricula_origem o
--  where o.pagamento_id = p.id
--    and o.lote = 'MATRICULA_SANTANDER_JUL_AGO_2026_A'
--    and p.matricula = o.matricula;   -- so se ainda for o valor que gravamos
-- delete from public.backfill_matricula_origem where lote = 'MATRICULA_SANTANDER_JUL_AGO_2026_A';
-- delete from public.backfill_matricula_lotes  where lote = 'MATRICULA_SANTANDER_JUL_AGO_2026_A';

-- 2) ESTRUTURA
-- A stage sai junto: ela e area de passagem, e o que sobra nela depois de um
-- lote que falhou e plano nao aplicado -- dado pessoal sem valor de auditoria.
-- A procedencia do que FOI aplicado vive em backfill_matricula_origem.
drop function if exists public.backfill_matricula_aplicar(text, text, integer);
drop table if exists public.backfill_matricula_stage;
drop table if exists public.backfill_matricula_origem;
drop table if exists public.backfill_matricula_lotes;
