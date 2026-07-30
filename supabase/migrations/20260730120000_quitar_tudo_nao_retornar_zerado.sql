-- P0 hotfix: "Quitar tudo" / Confirmar pagamento zera a ficha mas o caso volta
-- para os operadores.
--
-- Causa raiz: a pertinência de um caso às filas do operador é decidida por
-- NOT public.caso_encerrado_operacional(casos.*), que só reconhece encerramento
-- quando algum status normaliza para {PAGO, QUITADO, QUITACAO, QUITADO MANUAL,
-- SEM SALDO EM ABERTO}. O fluxo de confirmação (confirmar_baixa_caso) grava
-- apenas status_financeiro='QUITADO_CONFIRMACAO' (fora do conjunto) e não toca
-- status_atual/acionamento/jornada; e quando devolve quitou=false e o saldo
-- zera depois, nada reencerra o caso. Resultado: ficha zerada, caso ativo.
--
-- Correção (abordagem "gravar status reconhecido"): uma RPC atômica e idempotente
-- que valida permissão, bloqueia a solicitação (FOR UPDATE), recalcula o saldo
-- canônico e, SOMENTE quando zero, encerra o caso com status_acionamento/jornada
-- = 'SEM_SALDO_EM_ABERTO' (branch incondicional de caso_encerrado_operacional,
-- imune à divergência cpf x aluno_id) e status_atual='QUITADO'. Não apaga
-- registros financeiros; preserva o responsável histórico.

CREATE OR REPLACE FUNCTION public.confirmar_pagamento_solicitacao(
  p_confirmacao_id uuid,
  p_observacao text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_email      text := lower(coalesce(auth.jwt()->>'email',''));
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
  v_s          record;
  v_aluno_id   uuid;
  v_det        jsonb;
  v_tem_pend   boolean;
  v_agora      timestamptz := now();
  v_data       date;
  v_nome       text;
begin
  -- 1) Permissão (espelha confirmar_baixa_caso): gestão financeira ativa.
  if not v_is_service then
    if not (public.usuario_e_gestao() and public.perfil_do_usuario_atual() is not null) then
      raise exception 'Acesso negado: confirmar_pagamento_solicitacao exige gestao financeira ativa (usuario=%).',
        coalesce(nullif(v_email,''),'(anonimo)') using errcode = '42501';
    end if;
  end if;

  -- 2/3) Lock da solicitação (anti condição de corrida / duplo clique).
  select * into v_s
    from public.solicitacoes_confirmacao_pagamento
   where id = p_confirmacao_id
   for update;
  if not found then
    raise exception 'Solicitacao % nao encontrada.', p_confirmacao_id using errcode = 'P0002';
  end if;

  -- 4) IDEMPOTÊNCIA: já finalizada => retorna resultado seguro, sem efeitos.
  if v_s.status not in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO') then
    return jsonb_build_object(
      'ja_processado', true,
      'status', v_s.status,
      'quitou', (
        v_s.status = 'PAGAMENTO_CONFIRMADO'
        and v_s.aluno_id is not null
        and coalesce(
              (public.aluno_saldo_pendente_detalhe(nullif(v_s.aluno_id,'')::uuid, v_s.id) ->> 'tem_pendencia')::boolean,
              true) = false
      )
    );
  end if;

  v_aluno_id := nullif(v_s.aluno_id,'')::uuid;
  v_data     := coalesce(v_s.data_pagamento, v_agora::date);

  -- 5) Recalcula o saldo canônico ignorando esta própria confirmação.
  if v_aluno_id is not null then
    v_det      := public.aluno_saldo_pendente_detalhe(v_aluno_id, v_s.id);
    v_tem_pend := coalesce((v_det->>'tem_pendencia')::boolean, true);
  else
    v_det      := jsonb_build_object('erro','sem_aluno_id');
    v_tem_pend := true; -- sem aluno_id não há como quitar; só registra recebimento.
  end if;

  -- 6) Registra SEMPRE o recebimento (não baixa a dívida por si só).
  update public.solicitacoes_confirmacao_pagamento
     set status         = 'PAGAMENTO_CONFIRMADO',
         observacao_adm = nullif(btrim(
                            coalesce(observacao_adm,'') ||
                            case when coalesce(p_observacao,'') <> ''
                                 then ' — ' || p_observacao else '' end), ''),
         confirmado_por = coalesce(nullif(v_email,''), confirmado_por),
         confirmado_em  = v_agora,
         atualizado_em  = v_agora
   where id = p_confirmacao_id;

  -- 7) Saldo pendente: mantém o caso na carteira, sem quitar e sem reposição.
  if v_tem_pend then
    insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe)
    values (v_aluno_id, 'CONFIRMACAO_PAGAMENTO', (v_det->>'total')::numeric, v_det);
    return jsonb_build_object('quitou', false, 'motivo','SALDO_PENDENTE', 'detalhe', v_det);
  end if;

  -- 8) Saldo ZERO confirmado: encerra o caso com status RECONHECIDO e retira das
  --    filas. 'SEM_SALDO_EM_ABERTO' aciona o branch incondicional de
  --    caso_encerrado_operacional (não depende de saldo_titulos_aberto por cpf).
  select responsavel_atual_nome into v_nome from public.alunos where id = v_aluno_id;

  update public.casos
     set status_atual        = 'QUITADO',
         status_acionamento  = 'SEM_SALDO_EM_ABERTO',
         status_jornada      = 'SEM_SALDO_EM_ABERTO',
         status_financeiro   = 'QUITADO_CONFIRMACAO',
         total_em_aberto     = 0,
         quitado_em          = v_data,
         valor_quitado       = coalesce(v_s.valor_informado, valor_quitado, 0),
         origem_quitacao     = 'CONFIRMACAO_PAGAMENTO',
         caso_atualizado_por = coalesce(nullif(v_email,''),'sistema_confirmacao_pagamento'),
         caso_atualizado_em  = v_agora
   where aluno_id = v_aluno_id;

  -- Espelha no aluno (a ficha e as telas legadas leem daqui). Preserva o
  -- responsável histórico para auditoria; apenas tira das filas.
  update public.alunos
     set status_atual       = 'QUITADO',
         status_jornada     = 'QUITADO',
         status_acionamento = 'QUITADO',
         valor_em_aberto    = 0,
         fila_destino       = null,
         proxima_acao       = null
   where id = v_aluno_id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
  values
    (v_aluno_id::text, 'QUITACAO_CONFIRMADA',
     'Pagamento confirmado e saldo zerado (fonte canônica): caso encerrado e retirado das filas. Sem exclusão de registros financeiros.',
     'SEM_SALDO_EM_ABERTO', coalesce(v_nome, nullif(v_email,'')), v_email, v_agora);

  return jsonb_build_object('quitou', true, 'caso_encerrado', true, 'detalhe', v_det);
end;
$function$;

REVOKE ALL ON FUNCTION public.confirmar_pagamento_solicitacao(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_solicitacao(uuid, text) TO authenticated, service_role;
