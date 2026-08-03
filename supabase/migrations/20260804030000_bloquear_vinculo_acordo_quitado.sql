-- =====================================================================
-- Hotfix: acordo QUITADO tambem NAO recebe vinculo de mensalidade/titulo.
-- Regra oficial: acordo QUITADO e encerrado / somente leitura. A unica
-- excecao seria um fluxo de estorno/reabertura oficial separado (que hoje
-- nao passa por esta RPC). Baixa em QUITADO ja e barrada pelos triggers
-- (20260804010000). acordo_permite_acao_financeira ja retorna false p/ QUITADO.
--
-- Unica mudanca: vincular_titulos_acordo passa a recusar QUITADO com o erro
-- acordo_quitado_operacao_nao_permitida. CANCELADO segue bloqueado.
-- NAO altera acordos/titulos/pagamentos/baixas/saldos/responsaveis existentes.
-- =====================================================================
create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_bloqueados uuid[];
  v_n int;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0));

  select aluno_id, upper(coalesce(status,'')) into v_aluno_acordo, v_status_acordo
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  -- Encerrados nao recebem vinculo. So ATIVO pode.
  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo = 'QUITADO' then
    return jsonb_build_object('ok',false,'erro','acordo_quitado_operacao_nao_permitida');
  elsif v_status_acordo <> 'ATIVO' then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not (
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and coalesce(t.status,'') <> 'vinculada'
      and coalesce(t.status,'') <> 'quitada'
      and coalesce(t.situacao,'') not in ('NEGOCIADO','PAGO','DUPLICADA')
      and coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
    );

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object('ok',false,'erro','PARCELAS_INELEGIVEIS','bloqueados', to_jsonb(v_bloqueados));
  end if;

  update public.acordos_titulos t
     set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
         vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
   where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo;
  get diagnostics v_n = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n, 'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'acordo_id', p_acordo_id);
end;
$function$;
