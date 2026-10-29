-- Projeção Hora a Hora -- RPC leve: recuperado/honorarios por mes (ultimos 6 meses ate p_mes).
-- Usada pelo card "Recuperado por mês" na tela (mais leve que projecao_relatorio_pdf).
-- Gestao (amanda.seibel/cobranca04) ve o total; operador ve o proprio. Read-only.
-- Rollback: DROP FUNCTION public.projecao_serie_recuperado(text).

BEGIN;

CREATE OR REPLACE FUNCTION public.projecao_serie_recuperado(p_mes text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('mes',ym,'recuperado',recuperado,'honorarios',honorarios) ORDER BY ym),'[]'::jsonb)
  FROM (
    SELECT to_char(p.data_pagamento,'YYYY-MM') ym,
           round(sum(coalesce(p.valor_pago,0)),2) recuperado,
           round(sum(coalesce(p.valor_honorario,0)),2) honorarios
    FROM public.pagamentos p
    WHERE p.retroativo = false
      AND p.data_pagamento >= (to_date(p_mes||'-01','YYYY-MM-DD') - interval '5 months')
      AND p.data_pagamento <  (to_date(p_mes||'-01','YYYY-MM-DD') + interval '1 month')
      AND ( lower(coalesce(auth.email(),'')) IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br')
            OR lower(p.operador_email) = lower(coalesce(auth.email(),'')) )
    GROUP BY 1
  ) s;
$$;

COMMENT ON FUNCTION public.projecao_serie_recuperado(text) IS
  'Read-only leve: recuperado/honorarios por mes (ultimos 6 meses ate p_mes). Gestao total; operador proprio.';

COMMIT;
