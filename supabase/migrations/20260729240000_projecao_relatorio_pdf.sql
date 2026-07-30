-- Projeção Hora a Hora -- RPC de leitura para EXPORTAÇÃO em PDF (read-only, leve).
-- Gestão (amanda.seibel / cobranca04) vê o TOTAL da empresa + ranking por operador,
-- por unidade e dias de maior recuperação. Operador vê SOMENTE os próprios números.
-- Fonte: public.pagamentos (retroativo=false). Nao altera nada. Uma passada por mes.
-- Rollback: DROP FUNCTION public.projecao_relatorio_pdf(text).

BEGIN;

CREATE OR REPLACE FUNCTION public.projecao_relatorio_pdf(p_mes text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_out jsonb;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND public.perfil_do_usuario_atual() IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: requer usuario ativo.' USING ERRCODE='42501';
  END IF;

  WITH base AS (
    SELECT p.id, p.data_pagamento AS dia, lower(p.operador_email) AS op_email,
           initcap(lower(nullif(btrim(p.operador_nome),''))) AS op_nome,
           coalesce(p.valor_pago,0) AS vp, coalesce(p.valor_honorario,0) AS vh,
           coalesce(nullif(upper(public.unaccent(coalesce(a.unidade,''))),''),'') AS unidade
    FROM public.pagamentos p
    LEFT JOIN public.alunos a ON a.id = p.aluno_id
    WHERE p.retroativo = false
      AND to_char(p.data_pagamento,'YYYY-MM') = p_mes
      AND (v_gestao OR lower(p.operador_email) = v_email)
  ),
  tot AS (SELECT round(sum(vp),2) recuperado, round(sum(vh),2) honorarios, count(*) pagamentos, count(distinct dia) dias FROM base),
  ope AS (SELECT op_email, min(op_nome) operador, count(*) pagamentos, round(sum(vp),2) recuperado, round(sum(vh),2) honorarios
          FROM base WHERE op_email IS NOT NULL GROUP BY op_email),
  uni AS (SELECT unidade, count(*) pagamentos, round(sum(vp),2) recuperado, round(sum(vh),2) honorarios
          FROM base WHERE unidade <> '' GROUP BY unidade),
  dia AS (SELECT dia, count(*) pagamentos, round(sum(vp),2) recuperado, round(sum(vh),2) honorarios
          FROM base GROUP BY dia)
  SELECT jsonb_build_object(
    'mes', p_mes,
    'e_gestao', v_gestao,
    'operador_nome', CASE WHEN v_gestao THEN NULL ELSE (SELECT min(operador) FROM ope) END,
    'total', (SELECT to_jsonb(t) FROM tot t),
    'por_operador', CASE WHEN v_gestao THEN
        (SELECT coalesce(jsonb_agg(jsonb_build_object('operador',operador,'pagamentos',pagamentos,'recuperado',recuperado,'honorarios',honorarios) ORDER BY recuperado DESC),'[]'::jsonb) FROM ope)
      ELSE '[]'::jsonb END,
    'por_unidade', CASE WHEN v_gestao THEN
        (SELECT coalesce(jsonb_agg(jsonb_build_object('unidade',unidade,'pagamentos',pagamentos,'recuperado',recuperado,'honorarios',honorarios) ORDER BY recuperado DESC),'[]'::jsonb) FROM uni)
      ELSE '[]'::jsonb END,
    'dias_maior', (SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (
        SELECT jsonb_build_object('dia',dia,'pagamentos',pagamentos,'recuperado',recuperado,'honorarios',honorarios) x
        FROM dia ORDER BY recuperado DESC LIMIT 10) q),
    'evolucao', (SELECT coalesce(jsonb_agg(jsonb_build_object('dia',dia,'recuperado',recuperado,'honorarios',honorarios) ORDER BY dia),'[]'::jsonb) FROM dia),
    'atualizado_em', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.projecao_relatorio_pdf(text) IS
  'Read-only. Dados da Projecao Hora a Hora para exportacao PDF. Gestao (amanda.seibel/cobranca04) ve total+ranking+unidade+dias; operador ve so o proprio.';

COMMIT;
