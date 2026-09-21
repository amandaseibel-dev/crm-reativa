-- ROLLBACK de 20260922100200_confirmacao_encerramento_processado.
-- Restaura confirmar_pagamento_solicitacao (md5(pg_get_functiondef)=1d9c24aa48fe34b7385a1b2627d73a88) e _pagamentos_baixar_lote
-- (md5(pg_get_functiondef)=34ad52699f58e2657c0a5eb21d84821e) aos textos de producao e remove o que a migration criou.
-- Confirmacoes ja encerradas pela rotina continuam encerradas (dado de negocio nao e revertido).
begin;
drop trigger if exists trg_pagamento_baixado_encerra_confirmacao on public.pagamentos;
CREATE OR REPLACE FUNCTION public._pagamentos_baixar_lote()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_res jsonb; v_liga boolean;
begin
  perform set_config('reativa.fluxo_pagamentos','on', true);
  begin
    v_res := public.baixa_pelo_relatorio_pagamento(true, (current_date - 180));
  exception when others then
    -- a baixa e melhoria, nao condicao: a importacao nao pode cair por causa
    -- dela. Fica o registro para alguem olhar.
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina','BAIXA_LOTE_FALHOU','pagamentos', null,
            jsonb_build_object('erro', SQLERRM));
    return null;
  end;

  -- PARCELA PAGA ANTES DA EXTRACAO (17/09/2026). So depois de o motor ter
  -- feito o que dava: o que sobrou sem parcela para o boleto, em acordo que ja
  -- existe, passa pela previa estrutural. Falha aqui tambem nao derruba a
  -- importacao.
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes';
  if coalesce(v_liga, false) then
    begin
      perform public.parcela_paga_antes_reconstruir_pendentes(50);
    exception when others then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'RECONSTRUCAO_PARCELA_LOTE_FALHOU', 'pagamentos', null,
              jsonb_build_object('erro', SQLERRM));
    end;
  end if;

  -- ACORDO A VISTA PAGO ANTES DE EXISTIR NO CRM (17/09/2026). Depois de tudo:
  -- o que sobrou em AGUARDANDO_ACORDO, com boleto de parcela unica e sem
  -- acordo no CRM, passa pela previa do botao. Falha aqui tambem nao derruba
  -- a importacao.
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista';
  if coalesce(v_liga, false) then
    begin
      perform public.acordo_avista_recuperar_pendentes(25);
    exception when others then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'RECUPERACAO_AVISTA_LOTE_FALHOU', 'pagamentos', null,
              jsonb_build_object('erro', SQLERRM));
    end;
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirmar_pagamento_solicitacao(p_confirmacao_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
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
  if not v_is_service then
    if not (public.usuario_e_gestao() and public.perfil_do_usuario_atual() is not null) then
      raise exception 'Acesso negado: confirmar_pagamento_solicitacao exige gestao financeira ativa (usuario=%).',
        coalesce(nullif(v_email,''),'(anonimo)') using errcode = '42501';
    end if;
  end if;

  select * into v_s
    from public.solicitacoes_confirmacao_pagamento
   where id = p_confirmacao_id
   for update;
  if not found then
    raise exception 'Solicitacao % nao encontrada.', p_confirmacao_id using errcode = 'P0002';
  end if;

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

  if v_aluno_id is not null then
    v_det      := public.aluno_saldo_pendente_detalhe(v_aluno_id, v_s.id);
    v_tem_pend := coalesce((v_det->>'tem_pendencia')::boolean, true);
  else
    v_det      := jsonb_build_object('erro','sem_aluno_id');
    v_tem_pend := true;
  end if;

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

  if v_tem_pend then
    insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe)
    values (v_aluno_id, 'CONFIRMACAO_PAGAMENTO', (v_det->>'total')::numeric, v_det);
    return jsonb_build_object('quitou', false, 'motivo','SALDO_PENDENTE', 'detalhe', v_det);
  end if;

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
     'Pagamento confirmado e saldo zerado (fonte canonica): caso encerrado e retirado das filas. Sem exclusao de registros financeiros.',
     'SEM_SALDO_EM_ABERTO', coalesce(v_nome, nullif(v_email,'')), v_email, v_agora);

  return jsonb_build_object('quitou', true, 'caso_encerrado', true, 'detalhe', v_det);
end;
$function$
;
;

drop function if exists public.tg_pagamento_baixado_encerra_confirmacao();
drop function if exists public.confirmacao_encerrar_processadas(int);
drop function if exists public.confirmacao_encerrar_por_pagamento(uuid);
drop function if exists public.confirmacao_encerrar_uma(uuid);
delete from public.fluxo_pagamentos_config where etapa = 'encerrar_confirmacao_processada';
commit;
