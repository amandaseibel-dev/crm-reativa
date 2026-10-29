-- Relatorio 2026/1 sem negociacao -- VERSAO PROD-SAFE (autonoma; sem dependencias de staging).
-- Substitui a versao que referenciava objetos exclusivos de staging
-- (caso_bloqueado_confirmacao_importada, v_import_revisao_manual, bloqueios_pagamento_importado).
-- Dependencias (todas existem em producao): acordos_titulos, acordo_titulo_vinculo, casos,
--   solicitacoes_confirmacao_pagamento, normalizar_status_acionamento(text).
--
-- "Em confirmacao" usa a tabela REAL solicitacoes_confirmacao_pagamento (AGUARDANDO_CONFIRMACAO,
--   motivo de import de pagamentos). SOMENTE LEITURA (STABLE, sem escrita, via CTEs -- sem TEMP TABLE).
-- Restrito a gestao. Rollback: DROP FUNCTION.

BEGIN;

CREATE OR REPLACE FUNCTION public.relatorio_mensalidades_2026_1_sem_negociacao()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br');
  v_out jsonb;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT v_gestao THEN
    RAISE EXCEPTION 'Acesso negado: relatorio restrito a gestao.' USING ERRCODE='42501';
  END IF;

  WITH eleg AS (
    SELECT t.id, t.aluno_id, extract(month from t.vencimento)::int AS mes,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) AS saldo
    FROM public.acordos_titulos t
    WHERE t.vencimento between date '2026-01-01' and date '2026-06-30'
      AND upper(coalesce(t.situacao,'')) = 'ABERTO'
      AND lower(coalesce(t.status,'')) = 'em_aberto'
      AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
      AND t.acordo_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.acordo_titulo_vinculo v WHERE v.titulo_id = t.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.casos c
        WHERE c.aluno_id = t.aluno_id
          AND public.normalizar_status_acionamento(coalesce(c.status_atual,c.status_acionamento,c.status_jornada))
              = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'])
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
        WHERE s.aluno_id = t.aluno_id::text
          AND s.status = 'AGUARDANDO_CONFIRMACAO'
          AND s.motivo ILIKE 'Gerado do import de pagamentos Santander%'
      )
  ),
  por_mes AS (
    SELECT g.mes AS mes_numero,
      (array['','Janeiro','Fevereiro','Marco','Abril','Maio','Junho'])[g.mes] AS mes_nome,
      count(distinct e.aluno_id) AS alunos_unicos,
      count(e.id) AS mensalidades_sem_negociacao,
      round(coalesce(sum(e.saldo),0),2) AS saldo_sem_negociacao
    FROM generate_series(1,6) g(mes)
    LEFT JOIN eleg e ON e.mes = g.mes
    GROUP BY g.mes
  ),
  tot AS (
    SELECT count(distinct aluno_id) AS alunos, count(*) AS mens, round(coalesce(sum(saldo),0),2) AS saldo FROM eleg
  ),
  conf AS (
    SELECT count(distinct s.aluno_id) AS n
    FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status='AGUARDANDO_CONFIRMACAO' AND s.motivo ILIKE 'Gerado do import de pagamentos Santander%'
  )
  SELECT jsonb_build_object(
    'meses', (SELECT coalesce(jsonb_agg(p ORDER BY p.mes_numero),'[]'::jsonb) FROM por_mes p),
    'alunos_unicos_semestre', (SELECT alunos FROM tot),
    'mensalidades_total', (SELECT mens FROM tot),
    'saldo_total', (SELECT saldo FROM tot),
    'casos_em_confirmacao', (SELECT n FROM conf),
    'casos_em_revisao_manual', 0,
    'atualizado_em', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.relatorio_mensalidades_2026_1_sem_negociacao() IS
  'Read-only, prod-safe. Mensalidades originais 2026/1 sem negociacao (exclui em confirmacao de import via solicitacoes_confirmacao_pagamento). Restrito a gestao.';

COMMIT;
