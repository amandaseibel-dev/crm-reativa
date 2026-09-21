-- CONFIRMACAO PROCESSADA: ENCERRAMENTO (Blocos 1c e 2)
--
-- Base: confirmar_pagamento_solicitacao de producao lida em 21/09/2026 (md5(pg_get_functiondef)=1d9c24aa48fe34b7385a1b2627d73a88,
-- md5(prosrc)=cc61ef89b70ce932a7dc97e46231367d). Mudancas marcadas com V4 e todas fora do caminho "nao processado", que segue igual:
--   * gate tambem aceita a rotina do fluxo de pagamentos (reativa.fluxo_pagamentos = on), como as demais funcoes do fluxo;
--   * ramo REVISAO (ambiguo ou grupo PARCIALMENTE processado): so auditoria, nao altera confirmacao, nao baixa, nao reverte;
--   * ramo PROCESSADO: encerra a confirmacao como confirmada ('pagamento ja processado (ids)' / 'encerrada automaticamente: ...'),
--     SEM escrita financeira e SEM log_quitacao_bloqueada; saldo 0 segue a quitacao existente (o codigo original abaixo);
--     saldo > 0 e nenhuma outra confirmacao aberta => aluno sai de AGUARDANDO_BAIXA (ver Bloco 2 no corpo).
--
-- Novas: confirmacao_encerrar_uma / confirmacao_encerrar_por_pagamento / confirmacao_encerrar_processadas (idempotentes; so encerram com
-- prova COMPLETA), trigger AFTER UPDATE OF status_conciliacao (pagamento vira BAIXADO) e um bloco final em _pagamentos_baixar_lote,
-- ambos controlados por fluxo_pagamentos_config.etapa='encerrar_confirmacao_processada' (semeada DESLIGADA: migration inerte ate ligar).
-- Nenhuma das 355 confirmacoes legadas e processada por esta migration (sem vinculo gravado nao ha gatilho; a rotina em lote e manual).
begin;

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
  v_proc       jsonb;   -- V4
  v_ja         boolean := false;   -- V4
  v_n          int;   -- V4
  v_auto       boolean := coalesce(current_setting('reativa.confirmacao_auto', true),'') = 'on';   -- V4
  v_novo       text;   -- V4
begin
  if not v_is_service and coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on' then   -- V4: a rotina automatica passa pelo mesmo gate do fluxo de pagamentos
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

  -- V4: separa "o pagamento foi processado?" de "o aluno quitou tudo?" (somente leitura)
  v_proc := public.confirmacao_pagamento_processado(p_confirmacao_id);
  if v_proc->>'estado' = 'REVISAO' then
    -- falha fechada: nao altera a confirmacao, nao baixa nada; registra para revisao manual
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    select coalesce(nullif(v_email,''),'service_role'), 'CONFIRMACAO_REVISAO_MANUAL', 'solicitacoes_confirmacao_pagamento', p_confirmacao_id, v_proc
     where not exists (select 1 from public.auditoria x where x.acao = 'CONFIRMACAO_REVISAO_MANUAL' and x.registro_id = p_confirmacao_id and x.detalhes = v_proc);   -- idempotente
    return jsonb_build_object('revisao', true, 'motivo', v_proc->>'motivo', 'provas', v_proc);
  end if;
  v_ja := (v_proc->>'estado' = 'PROCESSADO');

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
                            case when v_ja then ' ' || case when v_auto then 'encerrada automaticamente: ' else '' end || 'pagamento já processado (' ||
                                   (select string_agg(x, ', ') from jsonb_array_elements_text(v_proc->'pagamentos') x) || ')' else '' end ||
                            case when coalesce(p_observacao,'') <> ''
                                 then ' — ' || p_observacao else '' end), ''),
         confirmado_por = case when v_auto then 'sistema_confirmacao_automatica' else coalesce(nullif(v_email,''), confirmado_por) end,
         confirmado_em  = v_agora,
         atualizado_em  = v_agora
   where id = p_confirmacao_id;

  if v_tem_pend and v_ja then
    -- V4: pagamento ja processado e ainda ha divida. Sem log de bloqueio; tira o aluno do limbo AGUARDANDO_BAIXA
    -- (mesmo precedente de _reabrir_aluno_com_divida_nova), so se nao ha outra confirmacao aberta. Nao toca responsavel/operador/retorno/agenda.
    if coalesce((v_det->>'confirmacoes_pendentes')::int, 0) = 0 then
      -- V4/Bloco 2: sai do limbo AGUARDANDO_BAIXA. Nunca ACORDO_FECHADO.
      --   situacao recalculada = ACORDO_EM_DIA (acordo ativo, parcela futura aberta, nada vencido) => status 'ACORDO_EM_DIA';
      --   qualquer outra (ex.: COBRANCA_VENCIDA por outra divida) => devolve o ultimo status guardado antes do limbo
      --   (alunos_estado_anterior), sem snapshot 'CONTATAR' (status existente e neutro). Nao toca responsavel/operador/retorno/agenda.
      perform public.recalcular_situacao_aluno(v_aluno_id);
      select situacao_operacional into v_novo from public.alunos where id = v_aluno_id;
      if v_novo is distinct from 'ACORDO_EM_DIA' then
        select e.estado->>'status_atual' into v_novo from public.alunos_estado_anterior e
         where e.aluno_id = v_aluno_id and coalesce(e.estado->>'status_atual','') not in ('','AGUARDANDO_BAIXA','ACORDO_FECHADO','BAIXA_REALIZADA')
           and coalesce(e.estado->>'status_atual','') not like 'QUITAD%' and coalesce(e.estado->>'status_atual','') not like 'SEM_SALDO%'
         order by e.criado_em desc limit 1;
        v_novo := coalesce(v_novo, 'CONTATAR');
      end if;
      update public.alunos
         set status_atual = v_novo, status_jornada = v_novo, status_acionamento = v_novo
       where id = v_aluno_id and upper(coalesce(status_atual,'')) = 'AGUARDANDO_BAIXA';
      get diagnostics v_n = row_count;
      if v_n > 0 then
        update public.casos set status_acionamento = v_novo
         where aluno_id = v_aluno_id and status_acionamento = 'Aguardando confirmação de pagamento';
        insert into public.aluno_movimentacoes
          (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
        values (v_aluno_id::text, 'CONFIRMACAO_PROCESSADA_SALDO_RESTANTE',
          'Confirmacao encerrada: o pagamento ja tinha sido baixado pela conciliacao. Restam parcelas em aberto; aluno devolvido ao status anterior; situacao operacional recalculada. Nenhum lancamento financeiro foi criado.',
          v_novo, coalesce((select responsavel_atual_nome from public.alunos where id = v_aluno_id), nullif(v_email,'')), v_email, v_agora);
      end if;
    end if;
    perform public.recalcular_situacao_aluno(v_aluno_id);
    return jsonb_build_object('quitou', false, 'motivo', 'PAGAMENTO_JA_PROCESSADO_SALDO_RESTANTE', 'processado', v_proc, 'detalhe', v_det);
  end if;

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

-- Core: encerra UMA confirmacao se (e so se) a prova for completa. Idempotente. Restaura os GUC ao final.
CREATE OR REPLACE FUNCTION public.confirmacao_encerrar_uma(p_confirmacao_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_p jsonb; v_res jsonb; v_old_f text := current_setting('reativa.fluxo_pagamentos', true); v_old_a text := current_setting('reativa.confirmacao_auto', true);
begin
  v_p := public.confirmacao_pagamento_processado(p_confirmacao_id);
  if v_p->>'estado' is distinct from 'PROCESSADO' or v_p->>'prova' not in ('VINCULO_GRAVADO','CHAVE_MESMA_TRANSACAO') then
    return jsonb_build_object('encerrou', false, 'estado', v_p->>'estado', 'motivo', v_p->>'motivo');
  end if;
  perform set_config('reativa.fluxo_pagamentos', 'on', true);
  perform set_config('reativa.confirmacao_auto', 'on', true);
  v_res := public.confirmar_pagamento_solicitacao(p_confirmacao_id, null);
  perform set_config('reativa.fluxo_pagamentos', coalesce(v_old_f, ''), true);
  perform set_config('reativa.confirmacao_auto', coalesce(v_old_a, ''), true);
  return jsonb_build_object('encerrou', coalesce((v_res->>'ja_processado')::boolean, false) = false, 'resultado', v_res);
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirmacao_encerrar_por_pagamento(p_pagamento_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_c uuid;
begin
  select l.confirmacao_id into v_c from public.solicitacao_confirmacao_pagamentos l where l.pagamento_id = p_pagamento_id;
  if v_c is null then return jsonb_build_object('encerrou', false, 'estado', 'SEM_VINCULO'); end if;
  return public.confirmacao_encerrar_uma(v_c);
end;
$function$;

-- Lote manual/agendavel (NAO agendado por esta migration). Percorre confirmacoes abertas do import; so encerra com prova completa.
CREATE OR REPLACE FUNCTION public.confirmacao_encerrar_processadas(p_limite int DEFAULT 200)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare r record; v_p jsonb; v_res jsonb; n_enc int := 0; n_rev int := 0; n_pul int := 0; n_erro int := 0; v_rev jsonb := '[]'::jsonb;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role' and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: rotina da gestao/fluxo de pagamentos.' using errcode = '42501';
  end if;
  for r in select s.id from public.solicitacoes_confirmacao_pagamento s
            where s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
              and s.motivo = 'Gerado do import de pagamentos Santander'
            order by s.criado_em, s.id limit greatest(coalesce(p_limite,200),0)
  loop
    v_p := public.confirmacao_pagamento_processado(r.id);
    if v_p->>'estado' = 'PROCESSADO' and v_p->>'prova' in ('VINCULO_GRAVADO','CHAVE_MESMA_TRANSACAO') then
      begin
        v_res := public.confirmacao_encerrar_uma(r.id); n_enc := n_enc + 1;
      exception when others then n_erro := n_erro + 1; end;
    elsif v_p->>'estado' = 'REVISAO' then
      n_rev := n_rev + 1; v_rev := v_rev || jsonb_build_object('confirmacao_id', r.id, 'motivo', v_p->>'motivo');
    else n_pul := n_pul + 1; end if;
  end loop;
  return jsonb_build_object('encerradas', n_enc, 'revisao', n_rev, 'puladas', n_pul, 'erros', n_erro, 'itens_revisao', v_rev);
end;
$function$;

revoke all on function public.confirmacao_encerrar_uma(uuid), public.confirmacao_encerrar_por_pagamento(uuid), public.confirmacao_encerrar_processadas(int) from public, anon, authenticated;
grant execute on function public.confirmacao_encerrar_processadas(int) to service_role;

-- Gatilho: pagamento vira BAIXADO (conciliacao posterior, cron :40 ou botao) => tenta encerrar a confirmacao vinculada. Nunca derruba a baixa.
CREATE OR REPLACE FUNCTION public.tg_pagamento_baixado_encerra_confirmacao()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if not coalesce((select ligado from public.fluxo_pagamentos_config where etapa = 'encerrar_confirmacao_processada'), false) then
    return null;
  end if;
  begin
    perform public.confirmacao_encerrar_por_pagamento(new.id);
  exception when others then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina', 'ENCERRAR_CONFIRMACAO_FALHOU', 'pagamentos', new.id, jsonb_build_object('erro', SQLERRM));
  end;
  return null;
end;
$function$;
drop trigger if exists trg_pagamento_baixado_encerra_confirmacao on public.pagamentos;
create trigger trg_pagamento_baixado_encerra_confirmacao after update of status_conciliacao on public.pagamentos
  for each row when (new.status_conciliacao = 'BAIXADO' and old.status_conciliacao is distinct from 'BAIXADO')
  execute function public.tg_pagamento_baixado_encerra_confirmacao();

insert into public.fluxo_pagamentos_config (etapa, ligado, observacao)
values ('encerrar_confirmacao_processada', false, 'Encerra automaticamente a confirmacao cujos pagamentos ja foram baixados (prova completa). Ligar so apos conferir.')
on conflict (etapa) do nothing;

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

  -- V-ENCERRA (Bloco 1c): as confirmacoes desta importacao nasceram ANTES (pagamentos_gerar_confirmacao < trg_pagamentos_baixar_lote,
  -- ordem alfabetica) e as baixas por linha (trg_pagamento_conciliar) ja rodaram. Encerra as que tem prova completa. Leve (vinculo
  -- gravado, no maximo 200 por importacao) e isolado: falha aqui nao derruba a importacao (QUERY_CANCELED nao e capturado, como nos demais).
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'encerrar_confirmacao_processada';
  if coalesce(v_liga, false) then
    begin
      perform public.confirmacao_encerrar_uma(c.confirmacao_id)
        from (select distinct l.confirmacao_id from public.solicitacao_confirmacao_pagamentos l
                join novos n on n.id = l.pagamento_id limit 200) c;
    exception when others then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'ENCERRAR_CONFIRMACAO_LOTE_FALHOU', 'pagamentos', null,
              jsonb_build_object('erro', SQLERRM));
    end;
  end if;
  return null;
end;
$function$;

commit;
