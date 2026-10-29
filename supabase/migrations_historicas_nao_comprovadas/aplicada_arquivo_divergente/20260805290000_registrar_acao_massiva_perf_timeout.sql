-- ============================================================================
-- registrar_acao_massiva — corrige TIMEOUT em lotes maiores
-- ============================================================================
-- SINTOMA: "Gerar Excel e registrar ação" falhava em lotes maiores. A função
-- chamava public.aluno_em_confirmacao_pagamento(id) DENTRO do loop, uma vez por
-- aluno. Essa função faz `aluno_id::text = ...` / `a.id::text = ...` (cast anula
-- o índice → seq scan): ~2,7s POR chamada. Sem statement_timeout próprio, herda
-- o padrão de 8s do papel `authenticated` → estoura já com poucas dezenas.
--
-- CORREÇÃO (mesma ideia da prévia 20260805020000):
--   1) statement_timeout próprio de 60s;
--   2) calcula o conjunto "em confirmação" UMA vez, restrito aos ids do lote,
--      com a MESMA lógica canônica de aluno_em_confirmacao_pagamento;
--   3) usa o índice PK: compara `alunos.id` (uuid) contra ids do lote castando o
--      TEXT->uuid (nunca uuid->text, que anula o índice) — vale p/ o conjunto de
--      confirmação, o UPDATE do loop e a coleta de contatos.
--
-- Sem mudança de comportamento: mesmo gate, mesma autoria (JWT), mesmos updates,
-- movimentações, contatos e retorno. Só performance + timeout.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.registrar_acao_massiva(
  p_aluno_ids text[], p_canal text, p_arquivo text,
  p_registrado_por_nome text, p_registrado_por_email text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public' SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_id text;
  v_retorno date := (current_date + 10);
  v_agora timestamptz := now();
  v_tipo text := CASE WHEN p_canal = 'WHATSAPP' THEN 'ACAO_MASSIVA_EXTERNA' ELSE 'ACAO_MASSIVA_EXTERNA_EMAIL' END;
  v_registrados text[] := '{}';
  v_excluidos_conf int := 0; v_excluidos jsonb := '[]'::jsonb; v_mov int := 0;
  v_sistema boolean := (auth.role() = 'service_role')
                       OR (auth.jwt() IS NULL AND session_user IN ('postgres','reativa_responsavel_executor'));
  v_autor_email text; v_autor_nome text; v_contatos jsonb;
  v_conf_ids text[];   -- ids do lote que estão em confirmação (calculado 1x)
BEGIN
  -- GATE: só gestão autenticada ou executor técnico. p_registrado_por_email é IGNORADO.
  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.' USING ERRCODE = '42501';
  END IF;

  -- AUTORIA CONFIÁVEL: só do JWT (ou SISTEMA quando executor técnico).
  IF v_sistema THEN
    v_autor_email := 'SISTEMA'; v_autor_nome := 'SISTEMA';
  ELSE
    v_autor_email := lower(coalesce(auth.email(), ''));
    v_autor_nome  := coalesce(nullif(auth.jwt() ->> 'name',''), v_autor_email);
  END IF;

  -- Conjunto "em confirmação" calculado UMA vez (canônico = aluno_em_confirmacao_pagamento),
  -- restrito aos ids do lote: 2 seq scans totais em vez de 2 por aluno.
  SELECT COALESCE(array_agg(DISTINCT cid), '{}') INTO v_conf_ids
  FROM (
    SELECT s.aluno_id::text AS cid
      FROM public.solicitacoes_confirmacao_pagamento s
     WHERE s.status IN ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
       AND s.aluno_id::text = ANY(COALESCE(p_aluno_ids, '{}'::text[]))
    UNION
    SELECT a.id::text
      FROM public.alunos a
     WHERE a.id = ANY(COALESCE(p_aluno_ids, '{}'::text[])::uuid[])   -- PK index (text->uuid)
       AND public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
  ) u;

  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
    IF v_id = ANY(v_conf_ids) THEN
      v_excluidos_conf := v_excluidos_conf + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Aguardando confirmação financeira');
      CONTINUE;
    END IF;

    UPDATE public.alunos
       SET data_retorno = v_retorno,
           status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_ultimo_acionamento = v_agora
     WHERE id = v_id::uuid AND responsavel_atual_email IS NULL;   -- PK index (text->uuid)

    IF FOUND THEN
      INSERT INTO public.aluno_movimentacoes
        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
      VALUES (v_id, v_tipo,
        'Ação de estímulo enviada por fora do CRM via '
          || CASE WHEN p_canal = 'WHATSAPP' THEN 'WhatsApp' ELSE 'e-mail' END
          || ' (planilha ' || COALESCE(p_arquivo, '-')
          || '), sem operador vinculado. Retorno agendado para ' || to_char(v_retorno, 'DD/MM/YYYY') || '.',
        v_autor_nome, v_autor_email, v_agora);
      v_mov := v_mov + 1; v_registrados := v_registrados || v_id;
    ELSE
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso com operador vinculado ou inexistente');
    END IF;
  END LOOP;

  -- Contatos completos SÓ dos efetivamente registrados (p/ a planilha de envio).
  v_contatos := COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
    FROM public.alunos a WHERE a.id = ANY(v_registrados::uuid[])), '[]'::jsonb);  -- PK index

  RETURN jsonb_build_object(
    'registrados', COALESCE(array_length(v_registrados, 1), 0),
    'ids_registrados', to_jsonb(v_registrados),
    'excluidos_confirmacao', v_excluidos_conf,
    'movimentacoes_criadas', v_mov,
    'autor_email', v_autor_email,
    'executado_por', CASE WHEN v_sistema THEN 'SISTEMA' ELSE 'USUARIO' END,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.registrar_acao_massiva(text[],text,text,text,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.registrar_acao_massiva(text[],text,text,text,text) TO authenticated, service_role;
