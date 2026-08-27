-- "Pagamento registrado, mas não foi possível reavaliar a quitação".
--
-- Amanda, 27/08/2026, ao baixar um pagamento que zerava o aluno.
--
-- A CAUSA: `carteira_operador.aluno_id` é do tipo **uuid**, e a função comparava
-- com texto:
--
--     where aluno_id = p_aluno_id::text
--
-- O Postgres recusa `uuid = text` -- erro "operator does not exist: uuid = text".
--
-- POR QUE SÓ APARECIA AGORA: essa linha só é alcançada quando o aluno REALMENTE
-- quita (saldo zerado e com pagamento registrado). Nos demais caminhos a função
-- retorna antes. O erro estava reservado exatamente para o caso de sucesso -- a
-- baixa gravava, e a quitação falhava logo depois.
--
-- O efeito: o pagamento ficava registrado, o aluno NÃO era marcado como quitado
-- e NÃO saía da carteira do operador. Era preciso quitar na mão depois.
--
-- Nada mais foi alterado: as outras comparações (`baixas_pagamento` e
-- `solicitacoes_confirmacao_pagamento`) usam colunas text, e ali o ::text está
-- correto.
--
-- Testado em produção e desfeito: aluno com saldo zero e parcela paga passou a
-- retornar quitou_aluno: true, sem erro.

create or replace function public.avaliar_quitacao_aluno(
  p_aluno_id uuid,
  p_acordo_id uuid default null,
  p_ignorar_confirmacao_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
declare
  v_det jsonb;
  v_agora timestamptz := now();
  v_teve_pagamento boolean;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    if public.perfil_do_usuario_atual() is null then
      raise exception 'Acesso negado: avaliar_quitacao_aluno exige usuario autenticado e ativo (usuario=%).',
        coalesce(auth.email(),'(anonimo)') using errcode = '42501';
    end if;
  end if;

  if p_acordo_id is not null then
    if not exists (
      select 1 from public.parcelas p
       where p.acordo_id = p_acordo_id
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO')
    ) and exists (select 1 from public.parcelas where acordo_id = p_acordo_id) then
      update public.acordos set status = 'QUITADO', saldo = 0, atualizado_em = v_agora
       where id = p_acordo_id and upper(coalesce(status,'')) <> 'CANCELADO';
      update public.acordos_titulos set status = 'quitada', atualizado_em = v_agora
       where id in (select titulo_id from public.acordo_titulo_vinculo
                     where acordo_id = p_acordo_id and coalesce(ativo,true));
    end if;
  end if;

  v_det := public.aluno_saldo_pendente_detalhe(p_aluno_id, p_ignorar_confirmacao_id);

  if (v_det ->> 'tem_pendencia')::boolean then
    insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe)
    values (p_aluno_id, 'BAIXA_PARCELA', (v_det ->> 'total')::numeric, v_det);
    return jsonb_build_object('quitou_aluno', false, 'motivo', 'SALDO_PENDENTE', 'detalhe', v_det);
  end if;

  select exists (
    select 1 from public.parcelas p join public.acordos a on a.id=p.acordo_id
     where a.aluno_id = p_aluno_id and upper(coalesce(p.status,'')) = 'PAGO'
  ) or exists (
    select 1 from public.baixas_pagamento b
     where b.aluno_id = p_aluno_id::text and upper(coalesce(b.status_baixa,'')) = 'REALIZADA'
  ) into v_teve_pagamento;

  if v_teve_pagamento then
    update public.alunos
       set status_jornada = 'QUITADO', status_atual = 'QUITADO', status_acionamento = 'QUITADO', valor_em_aberto = 0
     where id = p_aluno_id
       and coalesce(status_jornada,'') not in ('QUITADO','QUITADO_MANUAL','JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA');
    -- carteira_operador.aluno_id e UUID: comparar com texto quebrava a quitacao
    -- exatamente no caso de sucesso.
    update public.carteira_operador set status = 'quitado_saiu', saiu_em = v_agora
     where aluno_id = p_aluno_id and status = 'ativo';
    return jsonb_build_object('quitou_aluno', true, 'detalhe', v_det);
  end if;

  perform public.retirar_zerados_reais_sem_saldo(p_aluno_id, null);
  return jsonb_build_object('quitou_aluno', false, 'motivo', 'SEM_SALDO_EM_ABERTO', 'detalhe', v_det);
end;
$function$;

comment on function public.avaliar_quitacao_aluno(uuid, uuid, uuid) is
  'Reavalia a quitacao do aluno depois de uma baixa. Corrigido em 27/08/2026: carteira_operador.aluno_id e uuid e era comparado com texto, o que quebrava a funcao justamente quando o aluno quitava de verdade -- pagamento gravava, quitacao falhava.';
