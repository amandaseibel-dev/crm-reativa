-- Acao massiva CONTA como acionamento, e alcanca quem tem dono e nunca foi tocado.
--
-- Amanda, 27/08/2026: "todos os acionamentos da operacao ou acao massiva devem
-- contar".
--
-- ERRO MEU DE INTERPRETACAO, corrigido no mesmo minuto. Ela observou que "os
-- casos com acao massiva entrou na contagem de acionados" e eu li como
-- reclamacao -- cheguei a tirar `data_ultimo_acionamento` do registro. Era o
-- contrario: ela estava CONFIRMANDO o comportamento. Alcancar o aluno e
-- alcancar o aluno; o que muda e o canal, nao o fato.
--
-- FICA a correcao util que veio junto, essa sim um defeito real: o UPDATE
-- exigia `responsavel_atual_email IS NULL`, entao aluno COM dono era recusado
-- com "Caso com operador vinculado" -- mesmo nunca tendo sido acionado. Isso
-- contradizia a previa (migration 20260827300000), que passou a alcancar
-- nunca-acionado com dono: a lista mostrava o aluno e o registro o rejeitava na
-- hora de gravar. Agora as duas pontas concordam.
--
-- Sao 1.138 alunos que tinham dono e nunca foram acionados -- 1.076 com
-- telefone. So no semestre corrente sao 160 de 377. Eram invisiveis dos dois
-- lados: o operador nao acionou e a acao massiva nao alcancava.

create or replace function public.registrar_acao_massiva(
  p_aluno_ids text[],
  p_canal text,
  p_arquivo text,
  p_registrado_por_nome text,
  p_registrado_por_email text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
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
  v_conf_ids text[];
BEGIN
  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.' USING ERRCODE = '42501';
  END IF;

  -- Esta funcao NAO dispara nada: gera o registro de uma acao que aconteceu POR
  -- FORA (planilha). Disparar em massa pelo nosso numero segue proibido, e essa
  -- proibicao mora no gateway, que e quem dispara.

  IF v_sistema THEN
    v_autor_email := 'SISTEMA'; v_autor_nome := 'SISTEMA';
  ELSE
    v_autor_email := lower(coalesce(auth.email(), ''));
    v_autor_nome  := coalesce(nullif(auth.jwt() ->> 'name',''), v_autor_email);
  END IF;

  SELECT COALESCE(array_agg(DISTINCT cid), '{}') INTO v_conf_ids
  FROM (
    SELECT s.aluno_id::text AS cid
      FROM public.solicitacoes_confirmacao_pagamento s
     WHERE s.status IN ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
       AND s.aluno_id = ANY(COALESCE(p_aluno_ids, '{}'::text[]))
    UNION
    SELECT a.id::text
      FROM public.alunos a
     WHERE a.id = ANY(COALESCE(p_aluno_ids, '{}'::text[])::uuid[])
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
           retorno_origem = 'AUTOMATICO',
           status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           -- Acao massiva CONTA como acionamento: alcancar o aluno e alcancar o
           -- aluno, por operador ou por planilha.
           data_ultimo_acionamento = v_agora
     WHERE id = v_id::uuid
       -- Sem dono, OU com dono e nunca acionado. Ter dono nao quer dizer que
       -- alguem trabalhou o caso.
       AND (responsavel_atual_email IS NULL OR data_ultimo_acionamento IS NULL);

    IF FOUND THEN
      INSERT INTO public.aluno_movimentacoes
        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
      VALUES (v_id, v_tipo,
        'Ação de estímulo enviada por fora do CRM via '
          || CASE WHEN p_canal = 'WHATSAPP' THEN 'WhatsApp' ELSE 'e-mail' END
          || ' (planilha ' || COALESCE(p_arquivo, '-')
          || '). Retorno agendado para ' || to_char(v_retorno, 'DD/MM/YYYY') || '.',
        v_autor_nome, v_autor_email, v_agora);
      v_mov := v_mov + 1; v_registrados := v_registrados || v_id;
    ELSE
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso já acionado por operador, ou inexistente');
    END IF;
  END LOOP;

  v_contatos := COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
    FROM public.alunos a WHERE a.id = ANY(v_registrados::uuid[])), '[]'::jsonb);

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
