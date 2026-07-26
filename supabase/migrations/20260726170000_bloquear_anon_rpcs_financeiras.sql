-- Remediação de segurança (LGPD): bloquear execução ANÔNIMA e não autorizada
-- de 6 funções financeiras SECURITY DEFINER. Escopo estrito: apenas grants de
-- EXECUTE e, em 2 funções, um gate de identidade PREPENDIDO ao corpo já
-- existente. NÃO altera fórmula de saldo, regra de quitação, parcelas, acordos,
-- casos, pagamentos, responsáveis nem dados.
--
-- Idempotente (CREATE OR REPLACE / REVOKE são repetíveis).
-- Rollback: supabase/rollbacks/20260726170000_bloquear_anon_rpcs_financeiras_down.sql
--
-- Uso real mapeado:
--   confirmar_baixa_caso        -> tela FilaConfirmacaoPagamento (gated por
--                                  podeGerirFinanceiro = gestão). Sem chamador interno.
--   avaliar_quitacao_aluno      -> componente FinanceiroAluno (operadores). Sem chamador interno.
--   retirar_zerados_reais_...   -> SEM uso no frontend; chamada só por
--                                  avaliar_quitacao_aluno e liberar_caso_por_evento (ambas DEFINER).
--   caso_saldo_operacional      -> SEM uso direto; chamada por caso_saldo_zerado_real e
--                                  pela view (definer) vw_diagnostico_saldo_casos.
--   caso_saldo_zerado_real      -> SEM uso direto; chamada por retirar_zerados_reais_sem_saldo.
--   aluno_tem_saldo_pendente    -> SEM uso comprovado (frontend/funções/views/policies).
--
-- Cadeia interna preservada: as chamadas função->função ocorrem em contexto
-- SECURITY DEFINER (owner = postgres), então o EXECUTE é avaliado como postgres;
-- revogar de anon/authenticated NÃO quebra a cadeia interna.

------------------------------------------------------------------------------
-- 1) ESCRITA: confirmar_baixa_caso  -> exige gestão autorizada E ativa.
--    Corpo IDÊNTICO ao atual; apenas o gate é prepend. service_role preservado.
------------------------------------------------------------------------------
create or replace function public.confirmar_baixa_caso(
    p_aluno_id uuid, p_valor_pago numeric, p_data_pagamento date default current_date, p_confirmacao_id uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_det jsonb;
begin
  -- GATE de identidade (defesa em profundidade; grants abaixo já barram anon).
  -- service_role (jobs/backends) preservado.
  if coalesce(auth.role(),'') <> 'service_role' then
    if not (public.usuario_e_gestao_fila() and public.perfil_do_usuario_atual() is not null) then
      raise exception 'Acesso negado: confirmar_baixa_caso exige gestao autorizada e ativa (usuario=%).',
        coalesce(auth.email(),'(anonimo)') using errcode = '42501';
    end if;
  end if;

  v_det := public.aluno_saldo_pendente_detalhe(p_aluno_id, p_confirmacao_id);

  if (v_det ->> 'tem_pendencia')::boolean then
    insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe)
    values (p_aluno_id, 'CONFIRMACAO_PAGAMENTO', (v_det ->> 'total')::numeric, v_det);
    return jsonb_build_object('quitou', false, 'motivo', 'SALDO_PENDENTE', 'detalhe', v_det);
  end if;

  update public.casos
     set status_financeiro = 'QUITADO_CONFIRMACAO',
         quitado_em        = p_data_pagamento,
         valor_quitado     = coalesce(p_valor_pago, 0),
         origem_quitacao   = 'CONFIRMACAO_PAGAMENTO',
         caso_atualizado_por = 'sistema_confirmacao_pagamento',
         caso_atualizado_em  = now()
   where aluno_id = p_aluno_id;

  return jsonb_build_object('quitou', true, 'detalhe', v_det);
end;
$function$;

revoke execute on function public.confirmar_baixa_caso(uuid,numeric,date,uuid) from public, anon;
-- authenticated (gestão passa no gate) e service_role permanecem com EXECUTE.
grant execute on function public.confirmar_baixa_caso(uuid,numeric,date,uuid) to authenticated, service_role;

------------------------------------------------------------------------------
-- 2) LEITURA: avaliar_quitacao_aluno -> exige usuário autenticado E ativo.
--    Corpo IDÊNTICO; gate prepend. Usada por operadores na ficha; chama
--    internamente retirar_zerados_reais_sem_saldo (segue funcionando: DEFINER).
------------------------------------------------------------------------------
create or replace function public.avaliar_quitacao_aluno(
    p_aluno_id uuid, p_acordo_id uuid default null::uuid, p_ignorar_confirmacao_id uuid default null::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_det jsonb;
  v_agora timestamptz := now();
  v_teve_pagamento boolean;
begin
  -- GATE: autenticado e ativo (bloqueia anon, não cadastrado e inativo).
  -- service_role preservado.
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
       where id in (select titulo_id from public.acordo_titulo_vinculo where acordo_id = p_acordo_id and coalesce(ativo,true));
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
    update public.carteira_operador set status = 'quitado_saiu', saiu_em = v_agora
     where aluno_id = p_aluno_id::text and status = 'ativo';
    return jsonb_build_object('quitou_aluno', true, 'detalhe', v_det);
  end if;

  perform public.retirar_zerados_reais_sem_saldo(p_aluno_id, null);
  return jsonb_build_object('quitou_aluno', false, 'motivo', 'SEM_SALDO_EM_ABERTO', 'detalhe', v_det);
end;
$function$;

revoke execute on function public.avaliar_quitacao_aluno(uuid,uuid,uuid) from public, anon;
grant execute on function public.avaliar_quitacao_aluno(uuid,uuid,uuid) to authenticated, service_role;

------------------------------------------------------------------------------
-- 3) Sem uso externo direto -> remove TODO acesso externo (anon E authenticated).
--    Corpo intacto. Só cadeia interna (DEFINER) e service_role/postgres executam.
------------------------------------------------------------------------------
revoke execute on function public.retirar_zerados_reais_sem_saldo(uuid,integer) from public, anon, authenticated;
grant  execute on function public.retirar_zerados_reais_sem_saldo(uuid,integer) to service_role;

revoke execute on function public.caso_saldo_operacional(uuid,text) from public, anon, authenticated;
grant  execute on function public.caso_saldo_operacional(uuid,text) to service_role;

revoke execute on function public.caso_saldo_zerado_real(uuid,text) from public, anon, authenticated;
grant  execute on function public.caso_saldo_zerado_real(uuid,text) to service_role;

revoke execute on function public.aluno_tem_saldo_pendente(uuid,uuid) from public, anon, authenticated;
grant  execute on function public.aluno_tem_saldo_pendente(uuid,uuid) to service_role;
