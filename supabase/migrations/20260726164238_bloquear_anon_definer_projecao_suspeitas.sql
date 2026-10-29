-- Remediação de segurança (LGPD): eliminar os 5 alertas restantes do Security
-- Advisor classificados como `anon_security_definer_function_executable`.
-- Escopo ESTRITO: revogar EXECUTE de anon/PUBLIC nas 5 funções SECURITY DEFINER
-- abaixo e, nas 4 expostas via API, PREPENDER um gate de identidade que reusa os
-- controles centrais já existentes. NÃO altera nenhuma fórmula, filtro, valor,
-- cálculo, dado ou regra operacional. Não trata Storage, views SECURITY DEFINER,
-- policies always-true nem os 161 alertas de `authenticated_*` (fora de escopo).
--
-- Idempotente: CREATE OR REPLACE / REVOKE / GRANT são repetíveis.
-- Rollback: supabase/rollbacks/20260726180000_bloquear_anon_definer_projecao_suspeitas_down.sql
--
-- As 5 funções e seu uso real mapeado:
--   projecao_dashboard(text,text,text)          -> telas MeuDashboard (todos os
--       operadores, dados próprios escopados por auth.email() dentro do corpo) e
--       ProjecaoHoraHora. Chamada interna por obter_metricas_tv_reativa (DEFINER),
--       que injeta claims da gestora antes de chamar -> gate passa por ela.
--   projecao_unidades_disponiveis()             -> filtro de unidades em
--       ProjecaoHoraHora. Retorna apenas nomes de unidade (sem dado pessoal).
--   projecao_suspeitas_pagamentos_duplicados()  -> componente
--       SuspeitasPagamentosDuplicados, montado só quando usuario.podeGerir
--       (gestão). Retorna dados sensíveis -> restrito à GESTÃO.
--   registrar_decisao_suspeita_duplicidade(...) -> escrita de decisão no mesmo
--       componente. Já possuía allowlist interna de gestão; acrescenta exigência
--       de cadastro ATIVO via controle central, sem nova allowlist.
--   trg_detectar_suspeita_duplicidade()         -> EXCLUSIVAMENTE função do
--       trigger AFTER INSERT `pagamentos_detectar_suspeita_dup` em public.pagamentos.
--       Não deve ser chamável diretamente pela API.
--
-- Controles centrais reutilizados (nada de e-mail hardcoded novo):
--   public.perfil_do_usuario_atual()  -> retorna perfil só se cadastrado E ativo,
--                                        senão NULL (bloqueia sem-cadastro/inativo).
--   public.usuario_e_gestao()         -> allowlist central de gestão já existente.
-- Bypass de service_role preservado em todos os gates (auth.role()='service_role').
-- Cadeia interna função->função ocorre em contexto DEFINER (owner=postgres): o
-- EXECUTE é avaliado como postgres, então revogar de anon/authenticated não quebra
-- o trigger nem a chamada de obter_metricas_tv_reativa.

------------------------------------------------------------------------------
-- 1) projecao_dashboard  -> exige usuário AUTENTICADO e com CADASTRO ATIVO.
--    Corpo IDÊNTICO ao atual; apenas o gate é prepend logo após BEGIN.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.projecao_dashboard(p_mes text, p_operador_email text DEFAULT NULL::text, p_unidade text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(auth.email());
  v_e_gestao_dados boolean := lower(auth.email()) IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br');
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
  -- GATE (LGPD/segurança): exige usuário AUTENTICADO, com CADASTRO ATIVO.
  -- service_role (jobs/backends) e o painel TV (obter_metricas_tv_reativa, que
  -- injeta claims da gestora) preservados. Corpo abaixo IDÊNTICO ao atual.
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    IF public.perfil_do_usuario_atual() IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: requer usuário autenticado e cadastro ativo (usuario=%).', coalesce(auth.email(),'(anonimo)') USING ERRCODE = '42501';
    END IF;
  END IF;
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

  IF v_e_gestao_dados THEN
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
        OR (p_operador_email IS NULL AND (v_e_gestao_dados OR lower(operador_email) = v_email))
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

REVOKE EXECUTE ON FUNCTION public.projecao_dashboard(text,text,text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.projecao_dashboard(text,text,text) TO authenticated, service_role;

------------------------------------------------------------------------------
-- 2) projecao_unidades_disponiveis -> exige usuário AUTENTICADO e ATIVO.
--    Convertida de LANGUAGE sql para plpgsql apenas para prepender o gate; a
--    consulta (DISTINCT unidade) é IDÊNTICA à atual.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.projecao_unidades_disponiveis()
 RETURNS TABLE(unidade text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    IF public.perfil_do_usuario_atual() IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: requer usuário autenticado e cadastro ativo (usuario=%).', coalesce(auth.email(),'(anonimo)') USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN QUERY
    SELECT DISTINCT a.unidade
    FROM public.alunos a
    WHERE a.unidade IS NOT NULL AND btrim(a.unidade) <> ''
    ORDER BY 1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.projecao_unidades_disponiveis() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.projecao_unidades_disponiveis() TO authenticated, service_role;

------------------------------------------------------------------------------
-- 3) projecao_suspeitas_pagamentos_duplicados -> restrito à GESTÃO autorizada e
--    ATIVA (tela SuspeitasPagamentosDuplicados só monta para gestão). Convertida
--    de LANGUAGE sql para plpgsql apenas para prepender o gate; a consulta que
--    monta o JSON é IDÊNTICA à atual.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.projecao_suspeitas_pagamentos_duplicados()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    IF NOT (public.usuario_e_gestao() AND public.perfil_do_usuario_atual() IS NOT NULL) THEN
      RAISE EXCEPTION 'Acesso negado: requer gestão autorizada e ativa (usuario=%).', coalesce(auth.email(),'(anonimo)') USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'titulo_numero')), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', s.id, 'chave_grupo', s.chave_grupo, 'titulo_numero', s.titulo_numero, 'status', s.status,
        'exige_conferencia_manual', s.exige_conferencia_manual,
        'pagamento_sugerido_manter_id', s.pagamento_sugerido_manter_id,
        'pagamento_sugerido_duplicado_id', s.pagamento_sugerido_duplicado_id,
        'pagamento_manter_id', s.pagamento_manter_id, 'pagamento_duplicado_id', s.pagamento_duplicado_id,
        'motivo', s.motivo, 'decidido_por_email', s.decidido_por_email, 'decidido_por_nome', s.decidido_por_nome, 'decidido_em', s.decidido_em,
        'linhas', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'pagamento_id', p.id, 'aluno_nome', p.aluno_nome, 'numero_parcela_completo', p.numero_parcela_completo,
            'titulo_numero', p.titulo_numero, 'valor_pago', p.valor_pago, 'valor_honorario', p.valor_honorario,
            'data_pagamento', p.data_pagamento, 'operador_nome', p.operador_nome, 'operador_email', p.operador_email,
            'arquivo', i.arquivo_nome, 'import_status', COALESCE(i.status, '(sem importacao)'),
            'sugerido_manter', (p.id = s.pagamento_sugerido_manter_id),
            'sugerido_duplicado', (p.id = s.pagamento_sugerido_duplicado_id)
          ) ORDER BY p.valor_pago DESC, p.created_at ASC), '[]'::jsonb)
          FROM public.pagamentos p LEFT JOIN public.importacoes i ON i.id = p.importacao_id
          WHERE p.numero_parcela_completo = s.chave_grupo AND p.retroativo = false AND p.valor_pago > 0
            AND NOT (COALESCE(p.dados,'{}'::jsonb) ? 'estornado_em')
        )
      ) x FROM public.suspeitas_pagamento_duplicado s
    ) t
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.projecao_suspeitas_pagamentos_duplicados() FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.projecao_suspeitas_pagamentos_duplicados() TO authenticated, service_role;

------------------------------------------------------------------------------
-- 4) registrar_decisao_suspeita_duplicidade -> gate de GESTÃO + cadastro ATIVO
--    prepend; mantém a allowlist e a auditoria já existentes. Corpo IDÊNTICO.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_decisao_suspeita_duplicidade(p_suspeita_id uuid, p_decisao text, p_pagamento_manter_id uuid, p_pagamento_duplicado_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_email text := lower(auth.email()); v_nome text; s public.suspeitas_pagamento_duplicado%ROWTYPE;
BEGIN
  -- GATE (LGPD/segurança): exige GESTÃO autorizada E cadastro ATIVO.
  -- Reusa controles centrais existentes; sem allowlist nova. service_role preservado.
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    IF NOT (public.usuario_e_gestao() AND public.perfil_do_usuario_atual() IS NOT NULL) THEN
      RAISE EXCEPTION 'Acesso negado: requer gestão autorizada e ativa (usuario=%).', coalesce(auth.email(),'(anonimo)') USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_email NOT IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br') THEN
    RAISE EXCEPTION 'Sem permissão para validar suspeitas de pagamento duplicado.'; END IF;
  IF p_decisao NOT IN ('LEGITIMO','DUPLICIDADE_CONFIRMADA') THEN RAISE EXCEPTION 'Decisão inválida: %', p_decisao; END IF;
  IF COALESCE(btrim(p_motivo),'') = '' THEN RAISE EXCEPTION 'Motivo é obrigatório.'; END IF;
  SELECT * INTO s FROM public.suspeitas_pagamento_duplicado WHERE id = p_suspeita_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Suspeita não encontrada.'; END IF;
  IF p_decisao = 'DUPLICIDADE_CONFIRMADA' THEN
    IF p_pagamento_manter_id IS NULL OR p_pagamento_duplicado_id IS NULL THEN RAISE EXCEPTION 'Informe qual linha manter e qual é a duplicada.'; END IF;
    IF p_pagamento_manter_id = p_pagamento_duplicado_id THEN RAISE EXCEPTION 'A linha a manter e a duplicada não podem ser a mesma.'; END IF;
    PERFORM 1 FROM public.pagamentos WHERE id = p_pagamento_manter_id AND numero_parcela_completo = s.chave_grupo;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linha a manter não pertence a este grupo.'; END IF;
    PERFORM 1 FROM public.pagamentos WHERE id = p_pagamento_duplicado_id AND numero_parcela_completo = s.chave_grupo;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linha duplicada não pertence a este grupo.'; END IF;
  END IF;
  SELECT registrado_por_nome INTO v_nome FROM public.aluno_movimentacoes WHERE registrado_por_email = v_email ORDER BY registrado_em DESC LIMIT 1;
  UPDATE public.suspeitas_pagamento_duplicado SET status = p_decisao,
    pagamento_manter_id = CASE WHEN p_decisao='DUPLICIDADE_CONFIRMADA' THEN p_pagamento_manter_id ELSE NULL END,
    pagamento_duplicado_id = CASE WHEN p_decisao='DUPLICIDADE_CONFIRMADA' THEN p_pagamento_duplicado_id ELSE NULL END,
    motivo = p_motivo, decidido_por_email = v_email, decidido_por_nome = COALESCE(v_nome, v_email), decidido_em = now(),
    pagamentos_analisados = COALESCE((SELECT jsonb_agg(p.id::text) FROM public.pagamentos p
      WHERE p.numero_parcela_completo = s.chave_grupo AND p.retroativo = false AND COALESCE(p.valor_pago,0) > 0
        AND NOT (COALESCE(p.dados,'{}'::jsonb) ? 'estornado_em')), '[]'::jsonb),
    atualizado_em = now()
  WHERE id = p_suspeita_id;
  INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  VALUES (v_email, 'TRIAGEM_SUSPEITA_DUPLICIDADE', 'suspeitas_pagamento_duplicado', p_suspeita_id,
          jsonb_build_object('chave_grupo', s.chave_grupo, 'decisao', p_decisao, 'manter', p_pagamento_manter_id, 'duplicado', p_pagamento_duplicado_id, 'motivo', p_motivo));
  RETURN jsonb_build_object('ok', true, 'id', p_suspeita_id, 'status', p_decisao);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.registrar_decisao_suspeita_duplicidade(uuid,text,uuid,uuid,text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.registrar_decisao_suspeita_duplicidade(uuid,text,uuid,uuid,text) TO authenticated, service_role;

------------------------------------------------------------------------------
-- 5) trg_detectar_suspeita_duplicidade -> função EXCLUSIVA de trigger.
--    Não deve ser chamável diretamente pela API. Nenhuma alteração de corpo:
--    apenas revoga EXECUTE de anon, authenticated e PUBLIC. O trigger AFTER
--    INSERT continua disparando normalmente (execução de trigger não checa o
--    privilégio EXECUTE da função). postgres/service_role preservados.
------------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.trg_detectar_suspeita_duplicidade() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.trg_detectar_suspeita_duplicidade() TO service_role;
