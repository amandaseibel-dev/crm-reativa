-- =====================================================================
-- Hotfix: mensalidade inserida manualmente nao vincula ao acordo ativo.
--
-- CAUSA RAIZ: a insercao manual cria o titulo com status='em_aberto' e
-- saldo real > 0 (corretos), mas herda situacao='PAGO' do titulo original
-- quitado. A migration 20260804010000 endureceu a elegibilidade de
-- vincular_titulos_acordo passando a recusar QUALQUER titulo com
-- situacao in ('NEGOCIADO','PAGO','DUPLICADA') -- mesmo com status='em_aberto',
-- acordo_id NULL e saldo > 0. Como o vinculo e all-or-nothing, o lote inteiro
-- volta PARCELAS_INELEGIVEIS e a operacao nao consegue vincular.
--
-- O sinal canonico de "quitado" e o status ('quitada'/'paga') + saldo = 0,
-- nunca a etiqueta secundaria situacao. Titulos realmente quitados tem
-- status='quitada' e saldo 0 -> seguem barrados por status + saldo>0.
--
-- CORRECAO MINIMA: no gate de elegibilidade, deixar de bloquear por
-- situacao 'PAGO'/'NEGOCIADO'. Mantem bloqueio de DUPLICADA (duplicidade real),
-- mantem bloqueio de titulo ja vinculado/quitado/pago (status) e de saldo<=0.
-- Preserva: bloqueio de acordo CANCELADO/QUITADO, atomicidade, advisory lock,
-- FOR UPDATE, dedup e all-or-nothing. NAO altera dados existentes.
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

  -- Elegibilidade canonica. Uma mensalidade vincula quando: mesmo aluno,
  -- acordo ATIVO (checado acima), saldo > 0, NAO vinculada a outro acordo
  -- (acordo_id null + status <> vinculada), NAO paga/quitada/cancelada pelo
  -- STATUS CANONICO e NAO duplicada. O "quitado/negociado" e decidido por
  -- status + saldo + vinculo real, NUNCA pela etiqueta situacao='PAGO'/'NEGOCIADO'
  -- (que pode vir defasada em titulo inserido manualmente). Status normalizado
  -- (lower) para cobrir todas as variacoes de caixa: paga/pago/PAGO,
  -- quitada/quitado/QUITADO, cancelada/cancelado. situacao='DUPLICADA' bloqueia.
  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not (
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and lower(coalesce(t.status,'')) not in
            ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
      and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
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

-- ---------------------------------------------------------------------
-- Alinha a lista "disponiveis para acordo" com o mesmo criterio canonico
-- (antes bloqueava so 'vinculada'/'NEGOCIADO'; agora tambem exclui titulo
-- ja pago por status e duplicadas, e deixa de esconder situacao='NEGOCIADO'
-- de titulo sem acordo -- coerente com o gate acima).
-- ---------------------------------------------------------------------
create or replace function public.titulos_disponiveis_para_acordo(p_aluno_id uuid)
returns table(id uuid, documento text, competencia text, vencimento date, valor numeric)
language sql
stable
set search_path to 'public'
as $function$
  SELECT t.id, t.documento, t.competencia, t.vencimento,
         coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original) AS valor
  FROM public.acordos_titulos t
  WHERE t.aluno_id = p_aluno_id
    AND t.acordo_id IS NULL
    AND lower(coalesce(t.status,'')) NOT IN
          ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
    AND upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
    AND coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original) > 0
  ORDER BY t.vencimento;
$function$;
