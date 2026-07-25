-- Importação de pagamentos -> 100% para revisão manual na Fila de Confirmação.
--
-- PROBLEMA (causa dos pagamentos ocultos):
--   A RPC projecao_importar_pagamentos só criava solicitação de confirmação
--   no caso retroativo (p_retroativo = true) E somente quando o nome do aluno
--   batia com EXATAMENTE 1 aluno (qtd_matches = 1), com status
--   AGUARDANDO_CONFIRMACAO. Consequências:
--     - importação diária (p_retroativo = false) não gerava NENHUMA
--       solicitação -> o pagamento entrava em `pagamentos` e nunca aparecia
--       na Fila de Confirmação;
--     - nome ambíguo (vários alunos com o mesmo nome) era descartado;
--     - nome não localizado era descartado.
--   Esses pagamentos só apareciam num fluxo paralelo agrupado por nome
--   (pagamentos_nao_identificados / aba "Não identificados"), que agrupa
--   várias linhas por aluno e mostra apenas o mês corrente -- escondendo os
--   demais.
--
-- SOLUÇÃO:
--   Toda linha importada (após a deduplicação atual) gera UMA solicitação
--   individual em solicitacoes_confirmacao_pagamento, com status
--   PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO e título/parcela/acordo VAZIOS.
--   O sistema não decide dívida, não baixa, não quita, não gera reposição e
--   não altera responsável. Amanda/Fernanda identificam manualmente.
--
--   Resolução do aluno (sem escolher automaticamente por valor/data):
--     - match de nome único   -> vincula só o aluno (aluno_id preenchido);
--     - nome ambíguo          -> aluno_ambiguo = true + candidatos p/ escolha;
--     - nome não localizado   -> aluno_id nulo, sem candidatos (busca manual).
--
--   Deduplicação preservada: chave (numero_parcela_completo, valor_pago,
--   data_pagamento) e o unique parcial em pagamento_id impedem solicitação
--   duplicada da mesma linha.

BEGIN;

-- 1) Campos novos na fila para suportar aluno ambíguo/não-localizado e
--    preservar/exibir a linha de origem sem depender de join.
ALTER TABLE public.solicitacoes_confirmacao_pagamento
  ADD COLUMN IF NOT EXISTS aluno_ambiguo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS aluno_candidatos jsonb,
  ADD COLUMN IF NOT EXISTS titulo_numero text,
  ADD COLUMN IF NOT EXISTS numero_parcela_completo text,
  ADD COLUMN IF NOT EXISTS dados_origem jsonb;

COMMENT ON COLUMN public.solicitacoes_confirmacao_pagamento.aluno_ambiguo IS
  'true quando a importação encontrou mais de um aluno com o mesmo nome; exige seleção manual.';
COMMENT ON COLUMN public.solicitacoes_confirmacao_pagamento.aluno_candidatos IS
  'Lista de alunos candidatos [{id,nome,cpf,matricula,unidade}] para escolha manual quando aluno_ambiguo.';
COMMENT ON COLUMN public.solicitacoes_confirmacao_pagamento.dados_origem IS
  'Linha original do arquivo importado (jsonb), preservada para auditoria/exibição.';

-- 2) Redefine a RPC de importação. Mantém intactos: permissão, dedup por
--    (numero_parcela_completo, valor_pago, data_pagamento), gravação em
--    pagamentos, atualização de importacoes e rh_acompanhamento_diario e a
--    auditoria. Substitui o bloco retroativo-only por um bloco universal que
--    envia 100% dos pagamentos para revisão manual.
CREATE OR REPLACE FUNCTION public.projecao_importar_pagamentos(
  p_arquivo_nome text,
  p_usuario text,
  p_linhas jsonb,
  p_mes_referencia text,
  p_retroativo boolean DEFAULT false,
  p_substituir_importacao_id uuid DEFAULT NULL::uuid,
  p_motivo_substituicao text DEFAULT NULL::text
)
 RETURNS TABLE(importacao_id uuid, linhas_gravadas integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(auth.email());
  v_importacao_id uuid;
  v_qtd integer := 0;
  v_dia_pagamento date;
  v_meses_afetados text[];
  v_meses_antigos text[];
  v_ja_existe uuid;
BEGIN
  IF v_email NOT IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br') THEN
    RAISE EXCEPTION 'Sem permissão para importar a planilha de pagamentos.';
  END IF;

  SELECT mode() WITHIN GROUP (ORDER BY (v->>'data_pagamento')::date)
    INTO v_dia_pagamento
  FROM jsonb_array_elements(p_linhas) v
  WHERE (v->>'data_pagamento') IS NOT NULL;

  IF p_substituir_importacao_id IS NOT NULL THEN
    PERFORM 1 FROM public.importacoes i WHERE i.id = p_substituir_importacao_id AND i.status = 'CONCLUIDO';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Importação a ser substituída não encontrada ou já não está mais válida.';
    END IF;

    SELECT array_agg(DISTINCT to_char(p.data_pagamento, 'YYYY-MM'))
      INTO v_meses_antigos
    FROM public.pagamentos p
    WHERE p.importacao_id = p_substituir_importacao_id;

    UPDATE public.importacoes i
       SET status = 'SUBSTITUIDA', substituido_por = v_email, substituido_em = now(),
           motivo_substituicao = p_motivo_substituicao
     WHERE i.id = p_substituir_importacao_id;

    INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    VALUES (v_email, 'SUBSTITUIU_IMPORTACAO', 'importacoes', p_substituir_importacao_id,
            jsonb_build_object('motivo', p_motivo_substituicao, 'meses_afetados', v_meses_antigos));
  ELSE
    SELECT i.id INTO v_ja_existe
    FROM public.importacoes i
    WHERE i.mes_referencia = p_mes_referencia AND i.arquivo_nome = p_arquivo_nome AND i.status = 'CONCLUIDO'
    LIMIT 1;
    IF v_ja_existe IS NOT NULL THEN
      RAISE EXCEPTION 'IMPORTACAO_DUPLICADA:%', v_ja_existe;
    END IF;
  END IF;

  INSERT INTO public.importacoes (
    tipo, referencia, arquivo_nome, usuario, qtd_registros, status, retroativo,
    mes_referencia, dia_pagamento, substitui_importacao_id
  )
  VALUES (
    CASE WHEN p_retroativo THEN 'PROJECAO_RETROATIVA' ELSE 'PROJECAO_DIARIA' END,
    p_arquivo_nome || '-' || now()::text, p_arquivo_nome, p_usuario, jsonb_array_length(p_linhas),
    'EM_PROCESSAMENTO', p_retroativo, p_mes_referencia, v_dia_pagamento, p_substituir_importacao_id
  )
  RETURNING id INTO v_importacao_id;

  WITH linhas AS (
    SELECT
      (v->>'data_pagamento')::date AS data_pagamento,
      COALESCE((v->>'valor_pago')::numeric, 0) AS valor_pago,
      COALESCE((v->>'valor_honorario')::numeric, 0) AS valor_honorario,
      v->>'tipo_pagamento' AS tipo_pagamento,
      lower(v->>'operador_email') AS operador_email,
      v->>'operador_nome' AS operador_nome,
      v->>'aluno_nome' AS aluno_nome,
      v->>'cpf' AS cpf,
      v->>'titulo_numero' AS titulo_numero,
      v->>'numero_parcela_completo' AS numero_parcela_completo,
      v AS dados,
      ord
    FROM jsonb_array_elements(p_linhas) WITH ORDINALITY AS t(v, ord)
  ),
  linhas_final AS (
    -- Chave = parcela + valor + data. Dois pagamentos diferentes na mesma
    -- parcela (ex: titulo 65643) sao mantidos; so linhas identicas colapsam.
    (
      SELECT DISTINCT ON (numero_parcela_completo, valor_pago, data_pagamento)
        data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
        operador_email, operador_nome, aluno_nome, cpf, titulo_numero,
        numero_parcela_completo, dados
      FROM linhas
      WHERE numero_parcela_completo IS NOT NULL
      ORDER BY numero_parcela_completo, valor_pago, data_pagamento, ord DESC
    )
    UNION ALL
    (
      SELECT
        data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
        operador_email, operador_nome, aluno_nome, cpf, titulo_numero,
        numero_parcela_completo, dados
      FROM linhas
      WHERE numero_parcela_completo IS NULL
    )
  ),
  ins AS (
    INSERT INTO public.pagamentos (
      data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
      operador_email, operador_nome, aluno_nome, cpf, titulo_numero,
      numero_parcela_completo, dados, importacao_id, retroativo
    )
    SELECT
      data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
      operador_email, operador_nome, aluno_nome, cpf, titulo_numero,
      numero_parcela_completo, dados, v_importacao_id, p_retroativo
    FROM linhas_final
    ON CONFLICT (numero_parcela_completo, valor_pago, data_pagamento) WHERE numero_parcela_completo IS NOT NULL
    DO UPDATE SET
      valor_honorario = excluded.valor_honorario,
      tipo_pagamento = excluded.tipo_pagamento,
      aluno_nome = excluded.aluno_nome,
      cpf = excluded.cpf,
      titulo_numero = excluded.titulo_numero,
      dados = excluded.dados,
      importacao_id = excluded.importacao_id,
      retroativo = excluded.retroativo,
      operador_email = CASE WHEN public.pagamentos.operador_ajustado_manualmente
                             THEN public.pagamentos.operador_email ELSE excluded.operador_email END,
      operador_nome = CASE WHEN public.pagamentos.operador_ajustado_manualmente
                            THEN public.pagamentos.operador_nome ELSE excluded.operador_nome END
    RETURNING 1
  )
  SELECT count(*) INTO v_qtd FROM ins;

  UPDATE public.importacoes i SET status = 'CONCLUIDO' WHERE i.id = v_importacao_id;

  IF NOT p_retroativo THEN
    SELECT array_agg(DISTINCT to_char((v->>'data_pagamento')::date, 'YYYY-MM'))
      INTO v_meses_afetados
    FROM jsonb_array_elements(p_linhas) v
    WHERE (v->>'data_pagamento') IS NOT NULL;

    SELECT array_agg(DISTINCT m) INTO v_meses_afetados
    FROM unnest(COALESCE(v_meses_afetados, ARRAY[]::text[]) || COALESCE(v_meses_antigos, ARRAY[]::text[])) m;

    INSERT INTO public.rh_acompanhamento_diario (
      mes_referencia, operador_email, operador_nome,
      valor_recuperado_acumulado, valor_honorarios_acumulado, alunos_pagos_qtd, fonte_arquivo
    )
    SELECT
      to_char(p.data_pagamento, 'YYYY-MM'), p.operador_email, max(p.operador_nome),
      sum(p.valor_pago), sum(p.valor_honorario), count(*), p_arquivo_nome
    FROM public.pagamentos p
    WHERE to_char(p.data_pagamento, 'YYYY-MM') = ANY(v_meses_afetados)
      AND p.operador_email IS NOT NULL
      AND p.retroativo = false
    GROUP BY to_char(p.data_pagamento, 'YYYY-MM'), p.operador_email
    ON CONFLICT (mes_referencia, operador_email) DO UPDATE SET
      valor_recuperado_acumulado = excluded.valor_recuperado_acumulado,
      valor_honorarios_acumulado = excluded.valor_honorarios_acumulado,
      alunos_pagos_qtd = excluded.alunos_pagos_qtd,
      fonte_arquivo = excluded.fonte_arquivo,
      atualizado_em = now();
  END IF;

  -- ==========================================================================
  -- 100% dos pagamentos importados -> Fila de Confirmação (revisão manual).
  --
  -- Uma solicitação individual por pagamento (nunca agrupar por nome).
  -- NÃO decide dívida: titulo_id/parcela_id/acordo_id ficam NULL. Não baixa,
  -- não quita, não gera reposição, não altera responsável, não escolhe dívida
  -- por valor/data. Só vincula o aluno quando o nome bate com segurança.
  -- O unique parcial em pagamento_id + ON CONFLICT DO NOTHING garantem que
  -- reimportar a mesma linha (dedup) não cria confirmação duplicada.
  -- Aplica-se tanto à importação diária quanto à retroativa.
  -- ==========================================================================
  WITH pg AS (
    SELECT
      p.id AS pagamento_id, p.aluno_nome, p.cpf, p.valor_pago, p.data_pagamento,
      p.operador_email, p.operador_nome, p.titulo_numero, p.numero_parcela_completo,
      p.dados, public.normalizar_nome_pessoa(p.aluno_nome) AS nome_norm
    FROM public.pagamentos p
    WHERE p.importacao_id = v_importacao_id
  ),
  cand AS (
    SELECT
      pg.pagamento_id,
      count(al.id) AS qtd,
      (array_agg(al.id ORDER BY al.nome, al.id))[1] AS unico_id,
      (array_agg(al.cpf ORDER BY al.nome, al.id))[1] AS unico_cpf,
      jsonb_agg(
        jsonb_build_object('id', al.id, 'nome', al.nome, 'cpf', al.cpf,
                           'matricula', al.matricula, 'unidade', al.unidade)
        ORDER BY al.nome, al.id
      ) FILTER (WHERE al.id IS NOT NULL) AS candidatos
    FROM pg
    LEFT JOIN public.alunos al
      ON coalesce(trim(pg.aluno_nome), '') <> ''
     AND coalesce(trim(al.nome), '') <> ''
     AND public.normalizar_nome_pessoa(al.nome) = pg.nome_norm
    GROUP BY pg.pagamento_id
  )
  INSERT INTO public.solicitacoes_confirmacao_pagamento (
    id, aluno_id, aluno_nome, aluno_cpf, aluno_ambiguo, aluno_candidatos,
    operador_email, operador_nome, valor_informado, data_pagamento, tipo_pagamento,
    titulo_numero, numero_parcela_completo, dados_origem,
    motivo, status, pagamento_id, criado_em, atualizado_em
  )
  SELECT
    gen_random_uuid(),
    CASE WHEN c.qtd = 1 THEN c.unico_id::text ELSE NULL END,
    pg.aluno_nome,
    CASE WHEN c.qtd = 1 THEN COALESCE(NULLIF(trim(pg.cpf), ''), c.unico_cpf) ELSE pg.cpf END,
    (c.qtd > 1),
    CASE WHEN c.qtd > 1 THEN c.candidatos ELSE NULL END,
    pg.operador_email, pg.operador_nome, pg.valor_pago, pg.data_pagamento,
    NULL,  -- tipo_pagamento: não decidir automaticamente (mensalidade/acordo/quitação)
    pg.titulo_numero, pg.numero_parcela_completo, pg.dados,
    CASE
      WHEN c.qtd = 1 THEN 'Pagamento importado — aluno localizado. Identifique manualmente a dívida (mensalidade, parcela de acordo, entrada ou quitação).'
      WHEN c.qtd > 1 THEN 'Pagamento importado — nome de aluno AMBÍGUO. Selecione o aluno correto entre os candidatos.'
      ELSE 'Pagamento importado — aluno NÃO localizado. Busque manualmente por nome, matrícula ou CPF.'
    END,
    'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO',
    pg.pagamento_id, now(), now()
  FROM pg
  JOIN cand c ON c.pagamento_id = pg.pagamento_id
  ON CONFLICT (pagamento_id) WHERE pagamento_id IS NOT NULL DO NOTHING;

  INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  VALUES (v_email, 'IMPORTOU', 'importacoes', v_importacao_id,
          jsonb_build_object('arquivo_nome', p_arquivo_nome, 'mes_referencia', p_mes_referencia,
                              'dia_pagamento', v_dia_pagamento, 'qtd_registros', v_qtd,
                              'retroativo', p_retroativo, 'substituiu', p_substituir_importacao_id));

  RETURN QUERY SELECT v_importacao_id, v_qtd;
END;
$function$;

COMMIT;
