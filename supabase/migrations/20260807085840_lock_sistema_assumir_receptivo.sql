-- Trava anti-concorrência no receptivo: impede que 2 operadores assumam o MESMO
-- aluno ao mesmo tempo (antes o UPDATE era incondicional -> o 2º sobrescrevia o 1º
-- silenciosamente, e os dois trabalhavam o mesmo aluno).
--
-- Regra (validada em staging com tabela sintética, 4 cenários):
--   * Recusa APENAS se o aluno já está status_jornada='EM_ATENDIMENTO' por OUTRO
--     operador e o claim é recente (< 2h). Atômico: o 1º vence, o 2º recebe 0 linhas.
--   * Permite: aluno livre, aluno com trava expirada (>2h), e re-assumir o próprio.
--
-- Rollback imediato: 20260807140000_rollback_sistema_assumir_receptivo.sql

CREATE OR REPLACE FUNCTION public.sistema_assumir_receptivo(p_aluno_id uuid, p_status text, p_observacao text, p_data_retorno date DEFAULT NULL::date, p_hora_retorno text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare v_email text; v_nome text; v_n int; v_dono text; v_dono_nome text;
begin
  v_email := lower(coalesce(auth.jwt()->>'email','')); if v_email='' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  v_nome := internal.nome_operador_ativo(v_email); if v_nome is null then return jsonb_build_object('ok',false,'erro','NAO_E_OPERADOR_ATIVO'); end if;
  if coalesce(btrim(p_observacao),'')='' then return jsonb_build_object('ok',false,'erro','OBSERVACAO_OBRIGATORIA'); end if;
  if public.caso_saldo_zerado_real(p_aluno_id, null) then
    perform internal.encaminhar_saldo_zerado_confirmacao(p_aluno_id);
    return jsonb_build_object('ok',false,'erro','SALDO_ZERADO',
      'mensagem','Este aluno esta sem saldo em aberto. Encaminhado para Confirmacao de Pagamentos; nao entra na carteira de cobranca.');
  end if;

  -- TRAVA ATÔMICA: só assume se NÃO estiver em atendimento ativo por outro operador (<2h).
  update public.alunos set operador_nome=v_nome, operador_email=v_email, operador=v_nome,
      status_jornada=p_status, status_atual=p_status, status_acionamento=p_status,
      data_retorno=p_data_retorno, hora_retorno=p_hora_retorno, observacao=p_observacao,
      origem='Base receptiva', tipo_base='RECEPTIVA', atualizado_em=now()
   where id=p_aluno_id
     and not (
          status_jornada = 'EM_ATENDIMENTO'
      and responsavel_atual_email is not null
      and lower(responsavel_atual_email) <> v_email
      and atualizado_em > now() - interval '2 hours'
     );
  get diagnostics v_n = row_count;
  if v_n = 0 then
    select responsavel_atual_email, responsavel_atual_nome into v_dono, v_dono_nome
      from public.alunos where id=p_aluno_id;
    return jsonb_build_object('ok',false,'erro','JA_EM_ATENDIMENTO',
      'por', coalesce(v_dono_nome, v_dono, 'outro operador'),
      'mensagem','Este aluno ja esta em atendimento por '||coalesce(v_dono_nome, v_dono, 'outro operador')||'. Atualize a lista da base receptiva.');
  end if;

  perform internal.set_resp_aluno(p_aluno_id, v_email, v_nome, 'ASSUMIU_ATENDIMENTO', 'Assumiu pela Base Receptiva. Origem: assumir_receptivo.', v_email, v_nome);
  return jsonb_build_object('ok',true,'aluno_id',p_aluno_id);
end;$function$;
