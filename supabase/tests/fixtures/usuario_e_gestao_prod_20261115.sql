-- FIXTURE DE REFERENCIA (somente leitura, nao aplicada). Nao substitui a funcao em producao.
-- Origem: catalogo do projeto de producao ahattpqrjmhkzsmnbdzs, pg_get_functiondef(public.usuario_e_gestao).
-- Data da leitura: 2026-11-15. Hash md5 da definicao (pg_get_functiondef): af3d391f4234e6a352585777897568e4.
-- Dono: postgres. SECURITY DEFINER. search_path = public.
-- ACL efetiva: EXECUTE para authenticated, service_role, reativa_responsavel_executor; NAO para public nem anon.
-- Leitura feita so no catalogo; nenhum dado de aluno consultado.
CREATE OR REPLACE FUNCTION public.usuario_e_gestao()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$function$
