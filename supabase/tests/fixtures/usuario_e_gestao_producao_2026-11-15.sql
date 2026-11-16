-- FIXTURE DE REFERÊNCIA — NÃO É MIGRATION.
-- Função: public.usuario_e_gestao()
-- Origem: leitura de pg_get_functiondef no projeto de produção ahattpqrjmhkzsmnbdzs, somente leitura,
--         em 15/11/2026. Texto reproduzido sem alteração de lógica.
-- Uso: carregada pelos testes SQL de efetividade_caixa_resumo_semestre (01_ambiente.sql) para que o
--      portão de gestão seja a definição de produção comprovada, e não uma cópia escrita à mão.
-- Não substitui a função de produção. Nenhuma migration cria ou altera esta função.
--
-- Checagem adicional de usuário ativo NÃO está aqui: ela é feita pela RPC, em usuarios.ativo.
--
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
$function$;
