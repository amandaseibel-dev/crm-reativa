-- Resumo da atualização cadastral, para a tela em Ferramentas.
--
-- Existe separada de `prime_cadastro_pendentes` porque aquela devolve CPF e é
-- só do service_role. Esta devolve CONTAGEM, sem PII, e a gestão pode ler para
-- saber quanto falta antes de disparar a coleta.
--
-- APLICADA EM PROD em 2026-08-24.

create or replace function public.prime_cadastro_resumo()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  v_out jsonb;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: restrito a gestao.' USING ERRCODE='42501';
  END IF;

  WITH devedores AS (
    SELECT DISTINCT lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.acordos_titulos t
     WHERE lower(coalesce(t.status,'')) = 'em_aberto'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND length(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g')) = 11
  ),
  coletados AS (
    SELECT DISTINCT cpf FROM public.prime_contratos
     WHERE coletado_em > now() - interval '7 days'
  )
  SELECT jsonb_build_object(
    'devedores',      (SELECT count(*) FROM devedores),
    'ja_coletados',   (SELECT count(*) FROM devedores d WHERE EXISTS (SELECT 1 FROM coletados c WHERE c.cpf = d.cpf)),
    'pendentes',      (SELECT count(*) FROM devedores d WHERE NOT EXISTS (SELECT 1 FROM coletados c WHERE c.cpf = d.cpf)),
    'contratos',      (SELECT count(*) FROM public.prime_contratos),
    'titulos_com_semestre', (SELECT count(*) FROM public.prime_titulo_semestre WHERE semestre IS NOT NULL),
    'contatos_da_prime',    (SELECT count(*) FROM public.aluno_contatos WHERE origem = 'prime'),
    'ultima_coleta',  (SELECT max(coletado_em) FROM public.prime_contratos)
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

revoke all on function public.prime_cadastro_resumo() from public;
grant execute on function public.prime_cadastro_resumo() to authenticated, service_role;
