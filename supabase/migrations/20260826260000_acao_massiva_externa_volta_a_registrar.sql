-- Registrar ação feita por fora volta a ser permitido.
--
-- Amanda, 26/08/2026: "as externas precisam sair", "não pelo CRM", "fizemos
-- ações via excel", "no nosso whatsapp não faremos nunca ação" e "somente pela
-- aba ações massivas que é externo".
--
-- O QUE A TRAVA MIRAVA. Depois do número banido, entrou aqui um RAISE que
-- recusava o canal WHATSAPP com "o disparo sai fora do controle de cadência e
-- não entra no teto diário do número".
--
-- O QUE ELA PEGAVA DE VERDADE. Esta função NÃO dispara nada. Conferido: não
-- enfileira mensagem, não chama o gateway, não toca em tabela de WhatsApp. Ela
-- grava histórico e agenda o retorno de 10 dias -- a própria descrição que ela
-- escreve no histórico diz "Ação de estímulo enviada POR FORA DO CRM".
--
-- Ou seja, a trava não impedia envio nenhum: impedia o REGISTRO de um envio
-- feito por fora, no Excel. O efeito era o pior possível -- a ação acontecia, e
-- o CRM não ficava sabendo: aluno não marcado como acionado, sem retorno
-- agendado, fora da régua de acompanhamento.
--
-- A REGRA CONTINUA VALENDO onde ela é de verdade: disparar em massa pelo nosso
-- número segue proibido, e a proibição mora no gateway -- que é quem dispara.
-- Aqui o canal "WHATSAPP" significa apenas "o contato usado foi telefone".
--
-- Nada mais foi tocado: mesma permissão (gestão ou executor), mesma exclusão de
-- quem está aguardando confirmação financeira, mesma regra de só mexer em caso
-- sem operador vinculado.
--
-- Provado em produção e desfeito: canal WHATSAPP registrou 1 aluno e 1
-- movimentação.

create or replace function public.registrar_acao_massiva(
  p_aluno_ids text[], p_canal text, p_arquivo text,
  p_registrado_por_nome text, p_registrado_por_email text)
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
  -- proibicao mora no gateway, que e quem dispara. Aqui o canal 'WHATSAPP' quer
  -- dizer apenas que o contato usado foi telefone.

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
           data_ultimo_acionamento = v_agora
     WHERE id = v_id::uuid AND responsavel_atual_email IS NULL;

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

comment on function public.registrar_acao_massiva(text[], text, text, text, text) is
  'Registra que uma acao de estimulo foi enviada POR FORA do CRM (planilha) e agenda o retorno de 10 dias. NAO dispara nada: nao enfileira mensagem, nao chama o gateway. Disparar em massa pelo nosso numero segue proibido no gateway, que e quem dispara -- aqui o canal WHATSAPP significa apenas que o contato usado foi telefone.';
