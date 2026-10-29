-- Hardening de higiene: fixar search_path das 6 funções apontadas pelo advisor
-- `function_search_path_mutable`. Nenhuma é SECURITY DEFINER (risco baixo), mas é
-- a recomendação do linter e a correção é trivial e reversível: apenas define o
-- search_path de forma estável, SEM alterar o corpo/comportamento da função.
-- Idempotente e seguro; ignora função ausente (ex.: staging sem calibragem).

DO $$
DECLARE
  f record;
  assinaturas text[] := ARRAY[
    'public.acad_norm_txt(text)',
    'public.calibragem_auditoria_append_only()',
    'public.calibragem_indice_equilibrio(numeric[])',
    'public.calibragem_nivel_criticidade(integer,integer,numeric,boolean,boolean,jsonb)',
    'public.fmt_brl(numeric)',
    'public.snapshot_gerencial_e_gestao()'
  ];
  a text;
BEGIN
  FOREACH a IN ARRAY assinaturas LOOP
    IF to_regprocedure(a) IS NULL THEN
      RAISE NOTICE 'Função % ausente, ignorando.', a;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = public;', a);
    RAISE NOTICE 'search_path fixado em %', a;
  END LOOP;
END $$;
