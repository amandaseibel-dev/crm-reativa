-- Projeção Hora a Hora — dois ajustes na RPC public.projecao_dashboard:
--
-- (A) Amanda ADM (cobranca07@aelbra.com.br = "Amanda Borges", ativo) deixa de
--     ser tratada como operadora comum na VISUALIZAÇÃO administrativa:
--       * ranking da equipe e "maior pagamento" passam a ser calculados para
--         ela (antes só p/ amanda.seibel/cobranca04);
--       * histórico dia a dia passa a ser filial (empresa toda) para ela.
--     NÃO altera fórmulas, metas, comissão nem os cálculos financeiros:
--     os somatórios individuais dela (honorário do mês, comissão 8%, painel
--     "Meu painel (Amanda ADM)") continuam exatamente como antes (por e-mail).
--     Nenhum outro operador é afetado.
--
-- (B) Filtro de unidade/estabelecimento OPCIONAL: novo parâmetro p_unidade
--     (default NULL = "Todos"). Quando NULL, o comportamento é IDÊNTICO ao
--     atual (nenhuma linha é filtrada). Quando preenchido, todos os
--     somatórios de pagamentos passam a considerar apenas os pagamentos de
--     alunos daquela unidade (via FK pagamentos.aluno_id -> alunos.id).
--     Usa EXISTS (não JOIN) para não duplicar linhas.
--
-- Assinatura: acrescenta apenas o 3º parâmetro opcional; chamadas existentes
-- com 2 argumentos continuam funcionando e o FORMATO DE RETORNO é o mesmo.
-- Rollback correspondente em: supabase/rollbacks/20260725120000_projecao_amanda_adm_admin_e_filtro_unidade_down.sql

DROP FUNCTION IF EXISTS public.projecao_dashboard(text, text);

CREATE OR REPLACE FUNCTION public.projecao_dashboard(p_mes text, p_operador_email text DEFAULT NULL::text, p_unidade text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(auth.email());
  v_e_gestao_dados boolean := lower(auth.email()) IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br');
  -- (A) Amanda ADM: só ela; libera a VISUALIZAÇÃO administrativa (ranking e
  -- histórico filial), sem tocar nos cálculos individuais/comissão dela.
  v_e_admin_amanda boolean := v_email = 'cobranca07@aelbra.com.br';
  v_email_individual text := CASE
    WHEN v_e_gestao_dados AND p_operador_email IS NOT NULL THEN lower(p_operador_email)
    ELSE v_email
  END;
  v_hoje date := current_date;
  v_recuperado_hoje numeric;
  v_honorario_hoje numeric;
  v_acumulado_mes numeric;
  v_honorario_mes numeric;
  v_recuperado_hoje_filial numeric;
  v_acumulado_mes_filial numeric;
  v_honorario_hoje_filial numeric;
  v_honorario_mes_filial numeric;
  v_meta_recuperacao numeric;
  v_meta_honorario numeric;
  v_meta jsonb;
  v_dias_uteis_restantes integer;
  v_dias_uteis_passados integer;
  v_dias_uteis_total_mes integer;
  v_ranking jsonb;
  v_historico_dia jsonb;
  v_direto_valor numeric;
  v_direto_honorario numeric;
  v_meta_honorario_individual numeric;
  v_projecao_honorario_individual numeric;
  v_percentual_projecao_individual numeric;
  v_percentual_meta_individual_realizado numeric;
  v_projecao_honorario_filial numeric;
  v_percentual_projecao_filial numeric;
  v_inicio_mes date := to_date(p_mes || '-01', 'YYYY-MM-DD');
  v_fim_mes date := (v_inicio_mes + interval '1 month' - interval '1 day')::date;
  v_m1_valor numeric; v_m1_percentual numeric;
  v_m2_valor numeric; v_m2_percentual numeric;
  v_m3_valor numeric; v_m3_percentual numeric;
  v_m4_valor numeric; v_m4_percentual numeric;
  v_comissao_estimada_individual numeric := 0;
  v_faixa_atual text;
  v_pct_faixa numeric;
  v_recuperado_mes_amanda_adm numeric;
  v_comissao_amanda_adm numeric;
  v_maior_pagamento jsonb;
  v_qtd_pagamentos_hoje_filial integer;
  v_emails_ranking text[] := ARRAY[
    'cobranca03@aelbra.com.br', 'cobranca05@aelbra.com.br', 'cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br', 'cobranca10@aelbra.com.br', 'cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br', 'cobranca12@aelbra.com.br', 'cobranca07@aelbra.com.br'
  ];
BEGIN
  SELECT COALESCE(sum(valor_pago), 0), COALESCE(sum(valor_honorario), 0)
    INTO v_recuperado_hoje, v_honorario_hoje
  FROM public.pagamentos
  WHERE data_pagamento = v_hoje
    AND retroativo = false
    AND (v_e_gestao_dados OR lower(operador_email) = v_email)
    AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade));

  SELECT COALESCE(sum(valor_pago), 0), COALESCE(sum(valor_honorario), 0)
    INTO v_acumulado_mes, v_honorario_mes
  FROM public.pagamentos
  WHERE to_char(data_pagamento, 'YYYY-MM') = p_mes
    AND (
      (p_operador_email IS NOT NULL AND lower(operador_email) = v_email_individual)
      OR (p_operador_email IS NULL AND (v_e_gestao_dados OR lower(operador_email) = v_email))
    )
    AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade));

  SELECT COALESCE(sum(valor_pago), 0), COALESCE(sum(valor_honorario), 0)
    INTO v_recuperado_hoje_filial, v_honorario_hoje_filial
  FROM public.pagamentos
  WHERE data_pagamento = v_hoje
    AND retroativo = false
    AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade));

  SELECT count(*)
    INTO v_qtd_pagamentos_hoje_filial
  FROM public.pagamentos
  WHERE data_pagamento = v_hoje
    AND retroativo = false
    AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade));

  SELECT COALESCE(sum(valor_pago), 0), COALESCE(sum(valor_honorario), 0)
    INTO v_acumulado_mes_filial, v_honorario_mes_filial
  FROM public.pagamentos
  WHERE to_char(data_pagamento, 'YYYY-MM') = p_mes
    AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade));

  SELECT meta_operacional, meta_honorario,
         m1_valor, m1_percentual, m2_valor, m2_percentual,
         m3_valor, m3_percentual, m4_valor, m4_percentual,
         jsonb_build_object(
           'meta_operacional', meta_operacional, 'meta_unidades', meta_unidades, 'meta_honorario', meta_honorario,
           'm1_valor', m1_valor, 'm1_percentual', m1_percentual,
           'm2_valor', m2_valor, 'm2_percentual', m2_percentual,
           'm3_valor', m3_valor, 'm3_percentual', m3_percentual,
           'm4_valor', m4_valor, 'm4_percentual', m4_percentual,
           'atualizado_por', atualizado_por, 'atualizado_em', atualizado_em
         )
    INTO v_meta_recuperacao, v_meta_honorario,
         v_m1_valor, v_m1_percentual, v_m2_valor, v_m2_percentual,
         v_m3_valor, v_m3_percentual, v_m4_valor, v_m4_percentual, v_meta
  FROM public.metas_projecao WHERE mes_referencia = p_mes;
  v_meta_recuperacao := COALESCE(v_meta_recuperacao, 0);
  v_meta_honorario := COALESCE(v_meta_honorario, 0);
  v_m1_valor := COALESCE(v_m1_valor, 0); v_m1_percentual := COALESCE(v_m1_percentual, 0);
  v_m2_valor := COALESCE(v_m2_valor, 0); v_m2_percentual := COALESCE(v_m2_percentual, 0);
  v_m3_valor := COALESCE(v_m3_valor, 0); v_m3_percentual := COALESCE(v_m3_percentual, 0);
  v_m4_valor := COALESCE(v_m4_valor, 0); v_m4_percentual := COALESCE(v_m4_percentual, 0);
  v_meta := COALESCE(v_meta, jsonb_build_object(
    'meta_operacional', 0, 'meta_unidades', 0, 'meta_honorario', 0,
    'm1_valor', 0, 'm1_percentual', 0, 'm2_valor', 0, 'm2_percentual', 0,
    'm3_valor', 0, 'm3_percentual', 0, 'm4_valor', 0, 'm4_percentual', 0,
    'atualizado_por', null, 'atualizado_em', null
  ));

  SELECT count(*) INTO v_dias_uteis_restantes
  FROM generate_series(v_hoje, v_fim_mes, interval '1 day') d WHERE extract(isodow FROM d) < 6;
  SELECT count(*) INTO v_dias_uteis_total_mes
  FROM generate_series(v_inicio_mes, v_fim_mes, interval '1 day') d WHERE extract(isodow FROM d) < 6;
  SELECT count(*) INTO v_dias_uteis_passados
  FROM generate_series(v_inicio_mes, LEAST(v_hoje, v_fim_mes), interval '1 day') d WHERE extract(isodow FROM d) < 6;

  v_projecao_honorario_filial := CASE WHEN v_dias_uteis_passados > 0
    THEN round((v_honorario_mes_filial / v_dias_uteis_passados) * v_dias_uteis_total_mes, 2)
    ELSE v_honorario_mes_filial END;
  v_percentual_projecao_filial := CASE WHEN v_meta_honorario > 0
    THEN round((v_projecao_honorario_filial / v_meta_honorario) * 100, 2) ELSE 0 END;

  IF (NOT v_e_gestao_dados OR p_operador_email IS NOT NULL) AND v_email_individual <> 'cobranca07@aelbra.com.br' THEN
    v_meta_honorario_individual := v_m4_valor;
    v_percentual_meta_individual_realizado := CASE WHEN v_meta_honorario_individual > 0
      THEN round((v_honorario_mes / v_meta_honorario_individual) * 100, 2) ELSE 0 END;
    v_projecao_honorario_individual := CASE WHEN v_dias_uteis_passados > 0
      THEN round((v_honorario_mes / v_dias_uteis_passados) * v_dias_uteis_total_mes, 2)
      ELSE v_honorario_mes END;
    v_percentual_projecao_individual := CASE WHEN v_meta_honorario_individual > 0
      THEN round((v_projecao_honorario_individual / v_meta_honorario_individual) * 100, 2) ELSE 0 END;

    v_pct_faixa := CASE
      WHEN v_m4_valor > 0 AND v_honorario_mes >= v_m4_valor THEN v_m4_percentual
      WHEN v_m3_valor > 0 AND v_honorario_mes >= v_m3_valor THEN v_m3_percentual
      WHEN v_m2_valor > 0 AND v_honorario_mes >= v_m2_valor THEN v_m2_percentual
      WHEN v_m1_valor > 0 AND v_honorario_mes >= v_m1_valor THEN v_m1_percentual
      ELSE 0
    END;
    v_comissao_estimada_individual := round(v_honorario_mes * (v_pct_faixa / 100.0), 2);

    v_faixa_atual := CASE
      WHEN v_m4_valor > 0 AND v_honorario_mes >= v_m4_valor THEN 'Faixa 4 (' || v_m4_percentual || '%)'
      WHEN v_m3_valor > 0 AND v_honorario_mes >= v_m3_valor THEN 'Faixa 3 (' || v_m3_percentual || '%)'
      WHEN v_m2_valor > 0 AND v_honorario_mes >= v_m2_valor THEN 'Faixa 2 (' || v_m2_percentual || '%)'
      WHEN v_m1_valor > 0 AND v_honorario_mes >= v_m1_valor THEN 'Faixa 1 (' || v_m1_percentual || '%)'
      ELSE 'Abaixo da faixa mínima (0%)'
    END;
  END IF;

  IF v_email_individual = 'cobranca07@aelbra.com.br' AND (NOT v_e_gestao_dados OR p_operador_email IS NOT NULL) THEN
    SELECT COALESCE(sum(valor_pago), 0) INTO v_recuperado_mes_amanda_adm
    FROM public.pagamentos
    WHERE to_char(data_pagamento, 'YYYY-MM') = p_mes AND operador_email = 'cobranca07@aelbra.com.br'
      AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade));
    v_comissao_amanda_adm := round(v_honorario_mes * 0.08, 2);
    v_comissao_estimada_individual := v_comissao_amanda_adm;
    v_faixa_atual := 'ADM — 8% sobre honorários';
  END IF;

  IF v_e_gestao_dados OR v_e_admin_amanda THEN
    SELECT jsonb_agg(t ORDER BY t.valor_honorario DESC) INTO v_ranking
    FROM (
      SELECT lower(operador_email) AS operador_email, max(operador_nome) AS operador_nome,
             sum(valor_pago) AS valor_recuperado, sum(valor_honorario) AS valor_honorario
      FROM public.pagamentos
      WHERE to_char(data_pagamento, 'YYYY-MM') = p_mes AND retroativo = false
        AND lower(operador_email) = ANY(v_emails_ranking)
        AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade))
      GROUP BY lower(operador_email)
    ) t;

    SELECT jsonb_build_object(
             'operador_email', lower(p.operador_email), 'operador_nome',  p.operador_nome,
             'valor', p.valor_pago, 'data_pagamento', p.data_pagamento
           )
      INTO v_maior_pagamento
    FROM public.pagamentos p
    WHERE to_char(p.data_pagamento, 'YYYY-MM') = p_mes AND p.retroativo = false
      AND lower(p.operador_email) = ANY(v_emails_ranking) AND p.valor_pago > 0
      AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = p.aluno_id AND al.unidade = p_unidade))
    ORDER BY p.valor_pago DESC, p.data_pagamento ASC, lower(p.operador_email) ASC
    LIMIT 1;
  ELSE
    v_ranking := '[]'::jsonb;
    v_maior_pagamento := 'null'::jsonb;
  END IF;

  SELECT COALESCE(sum(valor_pago), 0), COALESCE(sum(valor_honorario), 0)
    INTO v_direto_valor, v_direto_honorario
  FROM public.pagamentos
  WHERE to_char(data_pagamento, 'YYYY-MM') = p_mes AND retroativo = false
    AND (v_e_gestao_dados OR lower(operador_email) = v_email)
    AND (operador_email IS NULL OR NOT (lower(operador_email) = ANY(v_emails_ranking)))
    AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade));

  SELECT jsonb_agg(t ORDER BY t.dia) INTO v_historico_dia
  FROM (
    SELECT data_pagamento AS dia, sum(valor_pago) AS valor_recuperado, sum(valor_honorario) AS valor_honorario
    FROM public.pagamentos
    WHERE to_char(data_pagamento, 'YYYY-MM') = p_mes
      AND (
        (p_operador_email IS NOT NULL AND lower(operador_email) = v_email_individual)
        OR (p_operador_email IS NULL AND (v_e_gestao_dados OR v_e_admin_amanda OR lower(operador_email) = v_email))
      )
      AND (p_unidade IS NULL OR EXISTS (SELECT 1 FROM public.alunos al WHERE al.id = pagamentos.aluno_id AND al.unidade = p_unidade))
    GROUP BY data_pagamento
  ) t;

  RETURN jsonb_build_object(
    'mes_referencia', p_mes,
    'recuperado_hoje', v_recuperado_hoje, 'honorario_hoje', v_honorario_hoje,
    'acumulado_mes', v_acumulado_mes, 'honorario_mes', v_honorario_mes,
    'recuperado_hoje_filial', v_recuperado_hoje_filial, 'acumulado_mes_filial', v_acumulado_mes_filial,
    'honorario_hoje_filial', v_honorario_hoje_filial, 'honorario_mes_filial', v_honorario_mes_filial,
    'qtd_pagamentos_hoje_filial', v_qtd_pagamentos_hoje_filial,
    'meta_recuperacao', v_meta_recuperacao, 'meta_honorario', v_meta_honorario,
    'percentual_meta', CASE WHEN v_meta_honorario > 0 THEN round((v_honorario_mes_filial / v_meta_honorario) * 100, 2) ELSE 0 END,
    'percentual_meta_filial', CASE WHEN v_meta_honorario > 0 THEN round((v_honorario_mes_filial / v_meta_honorario) * 100, 2) ELSE 0 END,
    'valor_restante_meta', GREATEST(v_meta_honorario - v_honorario_mes_filial, 0),
    'dias_uteis_restantes', v_dias_uteis_restantes,
    'media_diaria_necessaria', CASE WHEN v_dias_uteis_restantes > 0 THEN round(GREATEST(v_meta_honorario - v_honorario_mes_filial, 0) / v_dias_uteis_restantes, 2) ELSE 0 END,
    'meta_honorario_individual', v_meta_honorario_individual,
    'percentual_meta_individual_realizado', v_percentual_meta_individual_realizado,
    'projecao_honorario_individual', v_projecao_honorario_individual,
    'percentual_projecao_individual', v_percentual_projecao_individual,
    'projecao_honorario_filial', v_projecao_honorario_filial,
    'percentual_projecao_filial', v_percentual_projecao_filial,
    'dias_uteis_passados', v_dias_uteis_passados, 'dias_uteis_total_mes', v_dias_uteis_total_mes,
    'comissao_estimada_individual', v_comissao_estimada_individual, 'faixa_atual', v_faixa_atual,
    'recuperado_mes_amanda_adm', v_recuperado_mes_amanda_adm, 'comissao_amanda_adm', v_comissao_amanda_adm,
    'ranking_equipe', COALESCE(v_ranking, '[]'::jsonb),
    'maior_pagamento_individual', COALESCE(v_maior_pagamento, 'null'::jsonb),
    'direto_valor_recuperado', v_direto_valor, 'direto_valor_honorario', v_direto_honorario,
    'historico_dia_a_dia', COALESCE(v_historico_dia, '[]'::jsonb),
    'e_gestao', v_e_gestao_dados, 'config_metas', v_meta,
    'operador_selecionado_email', CASE WHEN p_operador_email IS NOT NULL THEN v_email_individual ELSE NULL END,
    'recuperado_reativa_hoje', v_recuperado_hoje_filial, 'recuperado_reativa_mes', v_acumulado_mes_filial
  );
END;
$function$;

-- Mantém os mesmos privilégios de execução da função anterior.
GRANT EXECUTE ON FUNCTION public.projecao_dashboard(text, text, text) TO authenticated, service_role;

-- Helper SOMENTE-LEITURA para popular o seletor de unidade (opção "Todos" +
-- as unidades distintas). Evita puxar os 17k alunos para o cliente só para
-- extrair ~36 unidades. Não altera dados nem regras.
CREATE OR REPLACE FUNCTION public.projecao_unidades_disponiveis()
 RETURNS TABLE(unidade text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT a.unidade
  FROM public.alunos a
  WHERE a.unidade IS NOT NULL AND btrim(a.unidade) <> ''
  ORDER BY 1;
$function$;

GRANT EXECUTE ON FUNCTION public.projecao_unidades_disponiveis() TO authenticated, service_role;
