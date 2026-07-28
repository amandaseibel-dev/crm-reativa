-- =============================================================================
-- Projeção Hora a Hora — SNAPSHOT POR OPERADOR (individual) + endurecimento
-- =============================================================================
-- Um único clique em "Atualizar projeção" passa a gerar, num único processamento:
--   1) snapshot geral da filial (escopo FILIAL) — com ranking (só gestão lê);
--   2) snapshot individual de CADA operador (escopo OPERADOR, 1 linha por email);
--   3) linha 'SEM_OPERADOR' para pagamentos sem operador.
-- Leitura:
--   - gestão (Amanda/Fernanda): filial + ranking + lista de todos os operadores;
--   - operador / Amanda ADM: SOMENTE os próprios números (sem ranking, sem colegas).
-- atualizado_em é único para todas as linhas do mês. Falha preserva o anterior.
-- NÃO APLICAR EM PRODUÇÃO sem autorização.
-- =============================================================================

-- 1) operador_email na PK (FILIAL usa ''; OPERADOR usa email lower / 'SEM_OPERADOR')
alter table public.projecao_snapshot add column if not exists operador_email text not null default '';
alter table public.projecao_snapshot drop constraint if exists projecao_snapshot_pkey;
alter table public.projecao_snapshot add primary key (escopo, mes_referencia, operador_email);

-- 2) Cálculo individual de UM operador (single-pass sobre as linhas dele no mês).
--    p_email: email lower do operador, ou 'SEM_OPERADOR' (operador_email IS NULL).
create or replace function public.projecao_calcular_operador(p_mes text, p_email text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_hoje date := current_date;
  v_ini  date := to_date(p_mes || '-01', 'YYYY-MM-DD');
  v_prox date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month')::date;
  v_fim  date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date;
  v_sem boolean := (p_email = 'SEM_OPERADOR');
  v_amanda_adm boolean := (p_email = 'cobranca07@aelbra.com.br');
  v_rec_hoje numeric; v_hon_hoje numeric; v_acum_mes numeric; v_hon_mes numeric;
  v_nome text; v_hist jsonb;
  v_m1 numeric; v_m1p numeric; v_m2 numeric; v_m2p numeric; v_m3 numeric; v_m3p numeric; v_m4 numeric; v_m4p numeric;
  v_du_rest int; v_du_pass int; v_du_total int;
  v_meta_ind numeric; v_pct_meta_ind numeric; v_proj_ind numeric; v_pct_proj_ind numeric;
  v_pct_faixa numeric; v_faixa text; v_comissao numeric; v_rec_amanda numeric; v_com_amanda numeric;
begin
  with op as materialized (
    select data_pagamento, valor_pago, valor_honorario, retroativo, operador_nome
    from public.pagamentos
    where data_pagamento >= v_ini and data_pagamento < v_prox
      and ( (v_sem and operador_email is null)
            or (not v_sem and lower(operador_email) = p_email) )
  ),
  scal as (
    select
      coalesce(sum(valor_pago)      filter (where data_pagamento = v_hoje and not retroativo),0) rec_hoje,
      coalesce(sum(valor_honorario) filter (where data_pagamento = v_hoje and not retroativo),0) hon_hoje,
      coalesce(sum(valor_pago),0) acum_mes,
      coalesce(sum(valor_honorario),0) hon_mes,
      max(operador_nome) nome
    from op
  ),
  hist as (
    select jsonb_agg(t order by t.dia) j from (
      select data_pagamento dia, sum(valor_pago) valor_recuperado, sum(valor_honorario) valor_honorario
      from op group by data_pagamento
    ) t
  )
  select scal.rec_hoje, scal.hon_hoje, scal.acum_mes, scal.hon_mes, scal.nome, coalesce(hist.j,'[]'::jsonb)
    into v_rec_hoje, v_hon_hoje, v_acum_mes, v_hon_mes, v_nome, v_hist
  from scal left join hist on true;

  select coalesce(m1_valor,0),coalesce(m1_percentual,0),coalesce(m2_valor,0),coalesce(m2_percentual,0),
         coalesce(m3_valor,0),coalesce(m3_percentual,0),coalesce(m4_valor,0),coalesce(m4_percentual,0)
    into v_m1,v_m1p,v_m2,v_m2p,v_m3,v_m3p,v_m4,v_m4p
  from public.metas_projecao where mes_referencia = p_mes;
  v_m1:=coalesce(v_m1,0); v_m1p:=coalesce(v_m1p,0); v_m2:=coalesce(v_m2,0); v_m2p:=coalesce(v_m2p,0);
  v_m3:=coalesce(v_m3,0); v_m3p:=coalesce(v_m3p,0); v_m4:=coalesce(v_m4,0); v_m4p:=coalesce(v_m4p,0);

  select count(*) into v_du_rest  from generate_series(v_hoje, v_fim, interval '1 day') d where extract(isodow from d) < 6;
  select count(*) into v_du_total from generate_series(v_ini,  v_fim, interval '1 day') d where extract(isodow from d) < 6;
  select count(*) into v_du_pass  from generate_series(v_ini,  least(v_hoje, v_fim), interval '1 day') d where extract(isodow from d) < 6;

  if v_amanda_adm then
    -- Amanda ADM: comissão fixa de 8% sobre honorários, sem meta/faixa.
    v_rec_amanda := v_acum_mes;
    v_com_amanda := round(v_hon_mes * 0.08, 2);
    v_comissao := v_com_amanda;
    v_faixa := 'ADM - 8% sobre honorarios';
  else
    v_meta_ind := v_m4;
    v_pct_meta_ind := case when v_meta_ind > 0 then round((v_hon_mes / v_meta_ind) * 100, 2) else 0 end;
    v_proj_ind := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;
    v_pct_proj_ind := case when v_meta_ind > 0 then round((v_proj_ind / v_meta_ind) * 100, 2) else 0 end;
    v_pct_faixa := case
      when v_m4 > 0 and v_hon_mes >= v_m4 then v_m4p
      when v_m3 > 0 and v_hon_mes >= v_m3 then v_m3p
      when v_m2 > 0 and v_hon_mes >= v_m2 then v_m2p
      when v_m1 > 0 and v_hon_mes >= v_m1 then v_m1p else 0 end;
    v_comissao := round(v_hon_mes * (v_pct_faixa / 100.0), 2);
    v_faixa := case
      when v_m4 > 0 and v_hon_mes >= v_m4 then 'Faixa 4 (' || v_m4p || '%)'
      when v_m3 > 0 and v_hon_mes >= v_m3 then 'Faixa 3 (' || v_m3p || '%)'
      when v_m2 > 0 and v_hon_mes >= v_m2 then 'Faixa 2 (' || v_m2p || '%)'
      when v_m1 > 0 and v_hon_mes >= v_m1 then 'Faixa 1 (' || v_m1p || '%)'
      else 'Abaixo da faixa minima (0%)' end;
  end if;

  return jsonb_build_object(
    'mes_referencia', p_mes,
    'operador_email', case when v_sem then null else p_email end,
    'operador_nome', coalesce(v_nome, case when v_sem then 'Sem operador' else p_email end),
    'e_gestao', false,
    'recuperado_hoje', v_rec_hoje, 'honorario_hoje', v_hon_hoje,
    'acumulado_mes', v_acum_mes, 'honorario_mes', v_hon_mes,
    'meta_honorario_individual', v_meta_ind,
    'percentual_meta_individual_realizado', v_pct_meta_ind,
    'projecao_honorario_individual', v_proj_ind,
    'percentual_projecao_individual', v_pct_proj_ind,
    'comissao_estimada_individual', v_comissao, 'faixa_atual', v_faixa,
    'recuperado_mes_amanda_adm', v_rec_amanda, 'comissao_amanda_adm', v_com_amanda,
    'dias_uteis_passados', v_du_pass, 'dias_uteis_total_mes', v_du_total, 'dias_uteis_restantes', v_du_rest,
    'historico_dia_a_dia', v_hist,
    'ranking_equipe', '[]'::jsonb, 'maior_pagamento_individual', 'null'::jsonb,
    'config_metas', jsonb_build_object('m1_valor',v_m1,'m1_percentual',v_m1p,'m2_valor',v_m2,'m2_percentual',v_m2p,
                                       'm3_valor',v_m3,'m3_percentual',v_m3p,'m4_valor',v_m4,'m4_percentual',v_m4p)
  );
end;
$function$;
revoke all on function public.projecao_calcular_operador(text,text) from public, anon, authenticated;

-- 3) Atualização central (um clique): filial + todos os operadores + SEM_OPERADOR.
create or replace function public.projecao_snapshot_atualizar(p_mes text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_got boolean; v_t0 timestamptz; v_now timestamptz; v_ms int;
  v_filial jsonb; v_n_ops int := 0; rec record;
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

    -- Substitui as linhas do mês (dentro do subtransaction: falha faz rollback e
    -- preserva o snapshot anterior). Recalcula tudo do zero para o mês.
    delete from public.projecao_snapshot where mes_referencia = p_mes;
    insert into public.projecao_snapshot(escopo,mes_referencia,operador_email,payload,status,atualizado_em,atualizado_por,duracao_ms,erro_resumo)
      values ('FILIAL', p_mes, '', v_filial, 'ok', v_now, coalesce(v_email,'service_role'), null, null);

    -- Gera linha para TODO operador ativo (mesmo sem movimentação -> zeros) e
    -- para SEM_OPERADOR, garantindo que a leitura nunca precise calcular.
    for rec in
      select oe from (
        select distinct coalesce(lower(operador_email),'SEM_OPERADOR') as oe
        from public.pagamentos
        where data_pagamento >= to_date(p_mes||'-01','YYYY-MM-DD')
          and data_pagamento <  (to_date(p_mes||'-01','YYYY-MM-DD') + interval '1 month')::date
        union
        select lower(email) from public.usuarios
        where ativo = true
          and lower(email) not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br')
      ) s
    loop
      insert into public.projecao_snapshot(escopo,mes_referencia,operador_email,payload,status,atualizado_em,atualizado_por,duracao_ms,erro_resumo)
      values ('OPERADOR', p_mes, rec.oe, public.projecao_calcular_operador(p_mes, rec.oe), 'ok', v_now, coalesce(v_email,'service_role'), null, null);
      v_n_ops := v_n_ops + 1;
    end loop;
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

-- 4) Leitura: gestão -> filial + ranking + lista de operadores; operador/Amanda ADM -> só o próprio.
create or replace function public.projecao_snapshot_ler(p_mes text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_e_gestao boolean := v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_filial public.projecao_snapshot%rowtype;
  v_own public.projecao_snapshot%rowtype;
  v_ops jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' and public.perfil_do_usuario_atual() is null then
    raise exception 'Acesso negado: requer usuario autenticado e cadastro ativo.' using errcode = '42501';
  end if;

  select * into v_filial from public.projecao_snapshot where escopo='FILIAL' and mes_referencia=p_mes and operador_email='';
  if not found then
    return jsonb_build_object('status','vazio','mes_referencia',p_mes,'e_gestao',v_e_gestao,
      'dados',null,'operadores','[]'::jsonb,'atualizado_em',null,'atualizado_por',null,'duracao_ms',null,'erro_resumo',null);
  end if;

  if v_e_gestao then
    -- lista resumida de todos os operadores (para a aba "Por Operador")
    select coalesce(jsonb_agg(jsonb_build_object(
              'operador_email', operador_email,
              'operador_nome', payload->>'operador_nome',
              'honorario_mes', (payload->>'honorario_mes')::numeric,
              'projecao', (payload->>'projecao_honorario_individual')::numeric,
              'percentual_projecao', (payload->>'percentual_projecao_individual')::numeric
            ) order by (payload->>'honorario_mes')::numeric desc), '[]'::jsonb)
      into v_ops
    from public.projecao_snapshot where escopo='OPERADOR' and mes_referencia=p_mes;

    return jsonb_build_object(
      'status', v_filial.status, 'mes_referencia', p_mes,
      'atualizado_em', v_filial.atualizado_em, 'atualizado_por', v_filial.atualizado_por,
      'duracao_ms', v_filial.duracao_ms, 'erro_resumo', v_filial.erro_resumo,
      'e_gestao', true, 'dados', v_filial.payload, 'operadores', v_ops);
  end if;

  -- não-gestão: SOMENTE os próprios números (leitura pura, sem cálculo)
  select * into v_own from public.projecao_snapshot
   where escopo='OPERADOR' and mes_referencia=p_mes and operador_email = v_email;

  return jsonb_build_object(
    'status', v_filial.status, 'mes_referencia', p_mes,
    'atualizado_em', v_filial.atualizado_em, 'atualizado_por', v_filial.atualizado_por,
    'duracao_ms', v_filial.duracao_ms, 'erro_resumo', v_filial.erro_resumo,
    'e_gestao', false,
    'dados', case when found then v_own.payload else null end,
    'operadores', '[]'::jsonb);
end;
$function$;

grant execute on function public.projecao_snapshot_ler(text)       to authenticated, service_role;
grant execute on function public.projecao_snapshot_atualizar(text) to authenticated, service_role;
