CREATE OR REPLACE FUNCTION public.acoes_massivas_fidelizacao_protege(p_dua timestamp with time zone, p_agora timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT p_dua IS NOT NULL
     AND (p_dua AT TIME ZONE 'America/Sao_Paulo')::date + 10 >= (p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
$function$
