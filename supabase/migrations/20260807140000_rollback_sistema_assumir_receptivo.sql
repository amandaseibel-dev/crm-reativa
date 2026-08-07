-- ROLLBACK da trava anti-concorrência (20260807140001). Restaura a versão ANTERIOR
-- de sistema_assumir_receptivo (UPDATE incondicional, sem guard). Aplicar SÓ se a
-- trava causar problema operacional. Mantido para reversão imediata.

CREATE OR REPLACE FUNCTION public.sistema_assumir_receptivo(p_aluno_id uuid, p_status text, p_observacao text, p_data_retorno date DEFAULT NULL::date, p_hora_retorno text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare v_email text; v_nome text;
begin
  v_email := lower(coalesce(auth.jwt()->>'email','')); if v_email='' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  v_nome := internal.nome_operador_ativo(v_email); if v_nome is null then return jsonb_build_object('ok',false,'erro','NAO_E_OPERADOR_ATIVO'); end if;
  if coalesce(btrim(p_observacao),'')='' then return jsonb_build_object('ok',false,'erro','OBSERVACAO_OBRIGATORIA'); end if;
  if public.caso_saldo_zerado_real(p_aluno_id, null) then
    perform internal.encaminhar_saldo_zerado_confirmacao(p_aluno_id);
    return jsonb_build_object('ok',false,'erro','SALDO_ZERADO',
      'mensagem','Este aluno esta sem saldo em aberto. Encaminhado para Confirmacao de Pagamentos; nao entra na carteira de cobranca.');
  end if;
  update public.alunos set operador_nome=v_nome, operador_email=v_email, operador=v_nome,
      status_jornada=p_status, status_atual=p_status, status_acionamento=p_status,
      data_retorno=p_data_retorno, hora_retorno=p_hora_retorno, observacao=p_observacao,
      origem='Base receptiva', tipo_base='RECEPTIVA', atualizado_em=now() where id=p_aluno_id;
  perform internal.set_resp_aluno(p_aluno_id, v_email, v_nome, 'ASSUMIU_ATENDIMENTO', 'Assumiu pela Base Receptiva. Origem: assumir_receptivo.', v_email, v_nome);
  return jsonb_build_object('ok',true,'aluno_id',p_aluno_id);
end;$function$;
