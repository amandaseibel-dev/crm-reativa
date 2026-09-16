CREATE OR REPLACE FUNCTION public.acoes_massivas_filtros()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'unidades', COALESCE((
      SELECT jsonb_agg(valor ORDER BY qtd DESC)
      FROM (SELECT unidade AS valor, count(*) AS qtd FROM public.alunos
            WHERE unidade IS NOT NULL AND unidade <> '' GROUP BY unidade) u), '[]'::jsonb),
    'cursos', COALESCE((
      SELECT jsonb_agg(valor ORDER BY qtd DESC)
      FROM (SELECT curso AS valor, count(*) AS qtd FROM public.alunos
            WHERE curso IS NOT NULL AND curso <> '' GROUP BY curso) c), '[]'::jsonb),
    'situacoes_academicas', COALESCE((
      SELECT jsonb_agg(valor ORDER BY qtd DESC)
      FROM (SELECT btrim(situacao_academica) AS valor, count(*) AS qtd FROM public.alunos
            WHERE situacao_academica IS NOT NULL AND btrim(situacao_academica) <> ''
            GROUP BY btrim(situacao_academica)) s), '[]'::jsonb)
  );
$function$
