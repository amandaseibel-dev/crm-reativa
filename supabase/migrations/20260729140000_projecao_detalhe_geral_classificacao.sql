-- =============================================================================
-- Detalhe GERAL: snapshot de pagamentos passa a cobrir TODO o Total da Empresa,
-- com classificacao confiavel. Amplia a MESMA tabela projecao_snapshot_pagamentos
-- (sem arquitetura paralela). Novas migrations, nao edita as concluidas.
--
-- Marcador de PAGAMENTO_DIRETO validado no banco (prod 2026-07): e o unico grupo
-- com operador_email IS NULL AND importacao_id IS NULL (85 linhas), coincidindo
-- 1:1 com o sentinel 'PAGAMENTO DIRETO'. Os demais sem operador vem de importacao.
--
-- Prioridade de classificacao:
--   1) operador_email pertence aos 9            -> EQUIPE_9        (participa premiacao)
--   2) operador_email = cobranca04              -> FERNANDA
--   3) operador_email null AND importacao_id null -> PAGAMENTO_DIRETO
--   4) operador_email null                      -> SEM_OPERADOR
--   5) demais                                   -> OUTRO
-- Apenas EQUIPE_9 participa da premiacao (Amanda ADM incluida, 8% fixo).
-- Todos permanecem no Total da Empresa.
-- =============================================================================

alter table public.projecao_snapshot_pagamentos add column if not exists classificacao_pagamento text;
alter table public.projecao_snapshot_pagamentos add column if not exists participa_premiacao boolean;

-- ---------------------------------------------------------------------------
-- Updater: agora grava TODOS os pagamentos do mes no detalhe (com classificacao),
-- mantendo tudo o mais identico (9+SEM_OPERADOR no payload, atomico, timeout 30s).
-- ---------------------------------------------------------------------------
create or replace function public.projecao_snapshot_atualizar(p_mes text)
 returns jsonb language plpgsql security definer
 set search_path to 'public' set statement_timeout to '30s'
as $function$
declare
  v_email text := lower(auth.email());
  v_got boolean; v_t0 timestamptz; v_now timestamptz; v_ms int;
  v_filial jsonb; v_n_ops int := 0; rec record;
  v_equipe text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and coalesce(v_email,'') not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    raise exception 'Acesso negado: apenas Amanda e Fernanda podem atualizar a projecao (usuario=%).',
      coalesce(v_email,'(anonimo)') using errcode = '42501';
  end if;
  v_got := pg_try_advisory_xact_lock(hashtext('projecao_snapshot_atualizar')::int, hashtext(p_mes)::int);
  if not v_got then
    raise exception 'Ja existe uma atualizacao em andamento para %.', p_mes using errcode = '55P03';
  end if;
  v_t0 := clock_timestamp(); v_now := now();
  begin
    if coalesce(current_setting('projecao.forcar_erro', true),'') = '1' then
      raise exception 'FALHA_SIMULADA_TESTE';
    end if;
    v_filial := public.projecao_calcular_filial(p_mes);

    delete from public.projecao_snapshot where mes_referencia = p_mes;
    insert into public.projecao_snapshot(escopo,mes_referencia,operador_email,payload,status,atualizado_em,atualizado_por,duracao_ms,erro_resumo)
      values ('FILIAL', p_mes, '', v_filial, 'ok', v_now, coalesce(v_email,'service_role'), null, null);

    for rec in select unnest(v_equipe || array['SEM_OPERADOR']) as oe
    loop
      insert into public.projecao_snapshot(escopo,mes_referencia,operador_email,payload,status,atualizado_em,atualizado_por,duracao_ms,erro_resumo)
      values ('OPERADOR', p_mes, rec.oe, public.projecao_calcular_operador(p_mes, rec.oe), 'ok', v_now, coalesce(v_email,'service_role'), null, null);
      v_n_ops := v_n_ops + 1;
    end loop;

    -- DETALHE GERAL: TODOS os pagamentos do mes, classificados.
    delete from public.projecao_snapshot_pagamentos where mes_referencia = p_mes;
    insert into public.projecao_snapshot_pagamentos(
      mes_referencia, data_pagamento, operador_email, pagamento_id, aluno_nome,
      valor_pago, valor_honorario, importacao_id, operador_ajustado_manualmente,
      classificacao_pagamento, participa_premiacao, atualizado_em)
    select p_mes, p.data_pagamento,
           case
             when lower(p.operador_email) = any(v_equipe) then lower(p.operador_email)
             when lower(p.operador_email) = 'cobranca04@aelbra.com.br' then 'cobranca04@aelbra.com.br'
             when p.operador_email is null and p.importacao_id is null then 'PAGAMENTO_DIRETO'
             when p.operador_email is null then 'SEM_OPERADOR'
             else lower(p.operador_email) end,
           p.id, p.aluno_nome, p.valor_pago, p.valor_honorario, p.importacao_id,
           coalesce(p.operador_ajustado_manualmente,false),
           case
             when lower(p.operador_email) = any(v_equipe) then 'EQUIPE_9'
             when lower(p.operador_email) = 'cobranca04@aelbra.com.br' then 'FERNANDA'
             when p.operador_email is null and p.importacao_id is null then 'PAGAMENTO_DIRETO'
             when p.operador_email is null then 'SEM_OPERADOR'
             else 'OUTRO' end,
           coalesce(lower(p.operador_email) = any(v_equipe), false),
           v_now
    from public.pagamentos p
    where p.data_pagamento >= to_date(p_mes||'-01','YYYY-MM-DD')
      and p.data_pagamento <  (to_date(p_mes||'-01','YYYY-MM-DD') + interval '1 month')::date;
  exception when others then
    update public.projecao_snapshot
      set status='erro', erro_resumo=left(sqlerrm,300), atualizado_em=v_now, atualizado_por=coalesce(v_email,'service_role')
      where mes_referencia = p_mes and escopo='FILIAL';
    return jsonb_build_object('status','erro','mes_referencia',p_mes,'erro_resumo',left(sqlerrm,300));
  end;

  v_ms := round(extract(milliseconds from clock_timestamp() - v_t0));
  update public.projecao_snapshot set duracao_ms = v_ms where mes_referencia = p_mes;
  return jsonb_build_object('status','ok','mes_referencia',p_mes,'duracao_ms',v_ms,
    'operadores', v_n_ops, 'atualizado_em', v_now, 'atualizado_por', coalesce(v_email,'service_role'));
end;
$function$;

-- ---------------------------------------------------------------------------
-- RPC EXCLUSIVA DE GESTAO para o Relatorio Geral de Pagamentos.
-- Somente Amanda e Fernanda. Paginada. Filtro opcional por classificacao.
-- Retorna itens + totais por classificacao + total geral (do snapshot).
-- Operadores/Amanda ADM/painel.tv/anon: negado.
-- ---------------------------------------------------------------------------
create or replace function public.projecao_snapshot_pagamentos_geral_ler(
  p_mes text, p_classificacao text default null, p_limit int default 100, p_offset int default 0)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_lim int := least(greatest(coalesce(p_limit,100),1),500);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_total int; v_itens jsonb; v_totais jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    raise exception 'Acesso negado: relatorio geral e exclusivo da gestao.' using errcode = '42501';
  end if;

  select count(*) into v_total from public.projecao_snapshot_pagamentos
   where mes_referencia=p_mes and (p_classificacao is null or classificacao_pagamento=p_classificacao);

  select coalesce(jsonb_agg(jsonb_build_object(
           'classificacao', classificacao_pagamento, 'total_pago', tot_pago,
           'total_honorario', tot_hon, 'qtd', qtd, 'participa_premiacao', participa)), '[]'::jsonb)
    into v_totais
  from (
    select classificacao_pagamento, bool_or(participa_premiacao) participa,
           round(sum(valor_pago),2) tot_pago, round(sum(valor_honorario),2) tot_hon, count(*) qtd
    from public.projecao_snapshot_pagamentos where mes_referencia=p_mes
    group by classificacao_pagamento order by classificacao_pagamento
  ) g;

  select coalesce(jsonb_agg(t order by t.data_pagamento, t.pagamento_id), '[]'::jsonb) into v_itens
  from (
    select pagamento_id, data_pagamento, operador_email, classificacao_pagamento,
           participa_premiacao, aluno_nome, valor_pago, valor_honorario, importacao_id,
           operador_ajustado_manualmente
    from public.projecao_snapshot_pagamentos
    where mes_referencia=p_mes and (p_classificacao is null or classificacao_pagamento=p_classificacao)
    order by data_pagamento, pagamento_id
    limit v_lim offset v_off
  ) t;

  return jsonb_build_object(
    'mes_referencia', p_mes, 'classificacao', p_classificacao,
    'total', v_total, 'limit', v_lim, 'offset', v_off,
    'totais_por_classificacao', v_totais, 'itens', v_itens);
end;
$function$;

revoke all on function public.projecao_snapshot_pagamentos_geral_ler(text,text,int,int) from public, anon;
grant execute on function public.projecao_snapshot_pagamentos_geral_ler(text,text,int,int) to authenticated, service_role;
