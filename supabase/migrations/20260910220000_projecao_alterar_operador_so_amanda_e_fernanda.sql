-- Trocar o operador de um pagamento na Projecao passa a ser so de Amanda e
-- Fernanda (pedido da gestao em 10/09/2026). Sai a Amanda ADM (cobranca07):
-- esse ajuste decide para quem vai o honorario, e portanto a comissao -- quem
-- decide remuneracao e quem responde por ela.
--
-- O corpo e o mesmo de antes; muda so a lista de e-mails da primeira checagem.
create or replace function public.projecao_alterar_operador(
  p_pagamento_id uuid, p_novo_operador_email text, p_novo_operador_nome text, p_motivo text
) returns void
language plpgsql
security definer
set search_path = public
as $function$
DECLARE
  v_email text := lower(auth.email());
  v_operador_anterior text;
  v_mes_referencia text;
  v_retroativo boolean;
BEGIN
  IF v_email NOT IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br') THEN
    RAISE EXCEPTION 'Sem permissão para alterar o operador responsável.';
  END IF;

  SELECT operador_email, to_char(data_pagamento, 'YYYY-MM'), retroativo
    INTO v_operador_anterior, v_mes_referencia, v_retroativo
  FROM public.pagamentos WHERE id = p_pagamento_id;

  UPDATE public.pagamentos
     SET operador_email = lower(p_novo_operador_email),
         operador_nome = p_novo_operador_nome,
         operador_ajustado_manualmente = true
   WHERE id = p_pagamento_id;

  INSERT INTO public.historico_operador_projecao (pagamento_id, operador_anterior, operador_novo, alterado_por, motivo)
  VALUES (p_pagamento_id, v_operador_anterior, lower(p_novo_operador_email), v_email, p_motivo);

  INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  VALUES (v_email, 'ALTEROU_OPERADOR', 'pagamentos', p_pagamento_id,
          jsonb_build_object('operador_anterior', v_operador_anterior, 'operador_novo', lower(p_novo_operador_email),
                              'motivo', p_motivo, 'mes_referencia', v_mes_referencia));

  IF v_mes_referencia IS NOT NULL AND COALESCE(v_retroativo, false) = false THEN
    PERFORM public.projecao_snapshot_atualizar(v_mes_referencia);
  END IF;
END;
$function$;
