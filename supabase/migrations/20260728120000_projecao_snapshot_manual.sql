-- =============================================================================
-- Projeção Hora a Hora — SNAPSHOT MANUAL (sem polling, sem cálculo ao abrir)
-- =============================================================================
-- Objetivo: substituir o polling da RPC pesada projecao_dashboard por um
-- snapshot salvo. Abrir a tela = 1 leitura leve (projecao_snapshot_ler).
-- Atualizar = botão manual (projecao_snapshot_atualizar) restrito a Amanda e
-- Fernanda, com lock de execução única e preservação do snapshot em falha.
--
-- AUTORIZAÇÃO: por allowlist de e-mail dentro de função SECURITY DEFINER —
-- NÃO usa usuarios.perfil nem flag em usuarios (auto-elevável enquanto
-- usuarios_self_update não for corrigido — ver docs/.../BLOQUEIO-autorizacao.md).
--   Atualizam: amanda.seibel@aelbra.com.br (Amanda gestora), cobranca04 (Fernanda)
--   Só visualizam: cobranca07 (Amanda ADM), operadores, demais.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização. Validado em staging.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabela de snapshot (1 linha por escopo+mês). RLS deny-all: só as funções
--    SECURITY DEFINER leem/escrevem (evita PostgREST expor ranking cru).
-- ---------------------------------------------------------------------------
create table if not exists public.projecao_snapshot (
  escopo          text not null default 'FILIAL',
  mes_referencia  text not null,
  payload         jsonb,
  status          text not null default 'ok',   -- ok | erro | vazio
  atualizado_em   timestamptz,
  atualizado_por  text,
  duracao_ms      integer,
  erro_resumo     text,
  primary key (escopo, mes_referencia)
);

alter table public.projecao_snapshot enable row level security;
-- sem policies => nenhum acesso direto por PostgREST; só via RPCs definer.

-- ---------------------------------------------------------------------------
-- 2) Cálculo pesado OTIMIZADO (single-pass, filtros de data sargáveis).
--    Reproduz fielmente a visão de GESTÃO de projecao_dashboard(p_mes,null,null).
--    Otimizações vs. original:
--      * range sargável  data >= inicio AND data < prox_mes  (usa índice),
--        no lugar de to_char(data,'YYYY-MM') = p_mes (não sargável);
--      * UMA varredura materializada do mês alimenta todos os agregados
--        (escalares + ranking + histórico + maior pagamento), no lugar de
--        ~6 varreduras separadas da tabela pagamentos.
-- ---------------------------------------------------------------------------
create or replace function public.projecao_calcular_filial(p_mes text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_hoje date := current_date;
  v_ini  date := to_date(p_mes || '-01', 'YYYY-MM-DD');
  v_prox date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month')::date;
  v_fim  date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date;
  v_emails_ranking text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
  v_rec_hoje numeric; v_hon_hoje numeric; v_qtd_hoje int;
  v_acum_mes numeric; v_hon_mes numeric; v_direto_v numeric; v_direto_h numeric;
  v_ranking jsonb; v_hist jsonb; v_maior jsonb;
  v_meta_operacional numeric; v_meta_honorario numeric; v_meta jsonb;
  v_du_rest int; v_du_pass int; v_du_total int;
  v_proj_filial numeric; v_pct_proj_filial numeric;
begin
  with mes as materialized (
    select data_pagamento, valor_pago, valor_honorario, retroativo,
           lower(operador_email) as oe, operador_nome
    from public.pagamentos
    where data_pagamento >= v_ini and data_pagamento < v_prox
  ),
  scal as (
    select
      coalesce(sum(valor_pago)      filter (where data_pagamento = v_hoje and not retroativo),0) rec_hoje,
      coalesce(sum(valor_honorario) filter (where data_pagamento = v_hoje and not retroativo),0) hon_hoje,
      count(*)                      filter (where data_pagamento = v_hoje and not retroativo)     qtd_hoje,
      coalesce(sum(valor_pago),0)      acum_mes,
      coalesce(sum(valor_honorario),0) hon_mes,
      coalesce(sum(valor_pago)      filter (where not retroativo and (oe is null or not (oe = any(v_emails_ranking)))),0) direto_v,
      coalesce(sum(valor_honorario) filter (where not retroativo and (oe is null or not (oe = any(v_emails_ranking)))),0) direto_h
    from mes
  ),
  rk as (
    select jsonb_agg(t order by t.valor_honorario desc) j from (
      select oe as operador_email, max(operador_nome) as operador_nome,
             sum(valor_pago) as valor_recuperado, sum(valor_honorario) as valor_honorario
      from mes where not retroativo and oe = any(v_emails_ranking)
      group by oe
    ) t
  ),
  hist as (
    select jsonb_agg(t order by t.dia) j from (
      select data_pagamento as dia, sum(valor_pago) as valor_recuperado, sum(valor_honorario) as valor_honorario
      from mes group by data_pagamento
    ) t
  ),
  mx as (
    select jsonb_build_object('operador_email', oe, 'operador_nome', operador_nome,
             'valor', valor_pago, 'data_pagamento', data_pagamento) j
    from mes where not retroativo and oe = any(v_emails_ranking) and valor_pago > 0
    order by valor_pago desc, data_pagamento asc, oe asc limit 1
  )
  select scal.rec_hoje, scal.hon_hoje, scal.qtd_hoje, scal.acum_mes, scal.hon_mes,
         scal.direto_v, scal.direto_h,
         coalesce(rk.j,'[]'::jsonb), coalesce(hist.j,'[]'::jsonb), coalesce(mx.j,'null'::jsonb)
    into v_rec_hoje, v_hon_hoje, v_qtd_hoje, v_acum_mes, v_hon_mes,
         v_direto_v, v_direto_h, v_ranking, v_hist, v_maior
  from scal
  left join rk   on true
  left join hist on true
  left join mx   on true;

  -- meta (1 linha, índice unique em mes_referencia)
  select meta_operacional, meta_honorario,
         jsonb_build_object(
           'meta_operacional', meta_operacional, 'meta_unidades', meta_unidades, 'meta_honorario', meta_honorario,
           'm1_valor', m1_valor, 'm1_percentual', m1_percentual, 'm2_valor', m2_valor, 'm2_percentual', m2_percentual,
           'm3_valor', m3_valor, 'm3_percentual', m3_percentual, 'm4_valor', m4_valor, 'm4_percentual', m4_percentual,
           'atualizado_por', atualizado_por, 'atualizado_em', atualizado_em)
    into v_meta_operacional, v_meta_honorario, v_meta
  from public.metas_projecao where mes_referencia = p_mes;
  v_meta_operacional := coalesce(v_meta_operacional,0);
  v_meta_honorario := coalesce(v_meta_honorario,0);
  v_meta := coalesce(v_meta, jsonb_build_object(
    'meta_operacional',0,'meta_unidades',0,'meta_honorario',0,
    'm1_valor',0,'m1_percentual',0,'m2_valor',0,'m2_percentual',0,
    'm3_valor',0,'m3_percentual',0,'m4_valor',0,'m4_percentual',0,
    'atualizado_por',null,'atualizado_em',null));

  select count(*) into v_du_rest  from generate_series(v_hoje, v_fim, interval '1 day') d where extract(isodow from d) < 6;
  select count(*) into v_du_total from generate_series(v_ini,  v_fim, interval '1 day') d where extract(isodow from d) < 6;
  select count(*) into v_du_pass  from generate_series(v_ini,  least(v_hoje, v_fim), interval '1 day') d where extract(isodow from d) < 6;

  v_proj_filial := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;
  v_pct_proj_filial := case when v_meta_honorario > 0 then round((v_proj_filial / v_meta_honorario) * 100, 2) else 0 end;

  -- Payload idêntico à saída de GESTÃO de projecao_dashboard(p_mes,null,null).
  return jsonb_build_object(
    'mes_referencia', p_mes,
    'recuperado_hoje', v_rec_hoje, 'honorario_hoje', v_hon_hoje,
    'acumulado_mes', v_acum_mes, 'honorario_mes', v_hon_mes,
    'recuperado_hoje_filial', v_rec_hoje, 'acumulado_mes_filial', v_acum_mes,
    'honorario_hoje_filial', v_hon_hoje, 'honorario_mes_filial', v_hon_mes,
    'qtd_pagamentos_hoje_filial', v_qtd_hoje,
    'meta_recuperacao', v_meta_operacional, 'meta_honorario', v_meta_honorario,
    'percentual_meta', case when v_meta_honorario > 0 then round((v_hon_mes / v_meta_honorario) * 100, 2) else 0 end,
    'percentual_meta_filial', case when v_meta_honorario > 0 then round((v_hon_mes / v_meta_honorario) * 100, 2) else 0 end,
    'valor_restante_meta', greatest(v_meta_honorario - v_hon_mes, 0),
    'dias_uteis_restantes', v_du_rest,
    'media_diaria_necessaria', case when v_du_rest > 0 then round(greatest(v_meta_honorario - v_hon_mes, 0) / v_du_rest, 2) else 0 end,
    'meta_honorario_individual', null,
    'percentual_meta_individual_realizado', null,
    'projecao_honorario_individual', null,
    'percentual_projecao_individual', null,
    'projecao_honorario_filial', v_proj_filial,
    'percentual_projecao_filial', v_pct_proj_filial,
    'dias_uteis_passados', v_du_pass, 'dias_uteis_total_mes', v_du_total,
    'comissao_estimada_individual', 0, 'faixa_atual', null,
    'recuperado_mes_amanda_adm', null, 'comissao_amanda_adm', null,
    'ranking_equipe', coalesce(v_ranking,'[]'::jsonb),
    'maior_pagamento_individual', coalesce(v_maior,'null'::jsonb),
    'direto_valor_recuperado', v_direto_v, 'direto_valor_honorario', v_direto_h,
    'historico_dia_a_dia', coalesce(v_hist,'[]'::jsonb),
    'e_gestao', true, 'config_metas', v_meta,
    'operador_selecionado_email', null,
    'recuperado_reativa_hoje', v_rec_hoje, 'recuperado_reativa_mes', v_acum_mes
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) LEITURA LEVE — abrir a tela chama isto (1 SELECT por PK). Sem cálculo.
--    Gestão recebe payload completo; não-gestão recebe o payload sem as
--    seções individuais de ranking/maior pagamento.
-- ---------------------------------------------------------------------------
create or replace function public.projecao_snapshot_ler(p_mes text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_e_gestao boolean := v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_row public.projecao_snapshot%rowtype;
  v_dados jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' and public.perfil_do_usuario_atual() is null then
    raise exception 'Acesso negado: requer usuario autenticado e cadastro ativo.' using errcode = '42501';
  end if;

  select * into v_row from public.projecao_snapshot where escopo = 'FILIAL' and mes_referencia = p_mes;
  if not found then
    return jsonb_build_object('status','vazio','mes_referencia',p_mes,'e_gestao',v_e_gestao,
      'dados',null,'atualizado_em',null,'atualizado_por',null,'duracao_ms',null,'erro_resumo',null);
  end if;

  v_dados := v_row.payload;
  if not v_e_gestao and v_dados is not null then
    v_dados := v_dados - 'ranking_equipe' - 'maior_pagamento_individual';
  end if;

  return jsonb_build_object(
    'status', v_row.status, 'mes_referencia', v_row.mes_referencia,
    'atualizado_em', v_row.atualizado_em, 'atualizado_por', v_row.atualizado_por,
    'duracao_ms', v_row.duracao_ms, 'erro_resumo', v_row.erro_resumo,
    'e_gestao', v_e_gestao, 'dados', v_dados);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4) ATUALIZAÇÃO MANUAL — botão. Só Amanda/Fernanda. Lock de execução única.
--    Falha preserva o snapshot anterior (payload não é sobrescrito).
--    Hook de teste: SET projecao.forcar_erro='1' força falha controlada.
-- ---------------------------------------------------------------------------
create or replace function public.projecao_snapshot_atualizar(p_mes text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_got boolean;
  v_t0 timestamptz;
  v_payload jsonb;
  v_ms int;
begin
  -- AUTORIZAÇÃO (allowlist de e-mail; NÃO usa usuarios.perfil — ver BLOQUEIO)
  if coalesce(auth.role(),'') <> 'service_role'
     and coalesce(v_email,'') not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    raise exception 'Acesso negado: apenas Amanda e Fernanda podem atualizar a projecao (usuario=%).',
      coalesce(v_email,'(anonimo)') using errcode = '42501';
  end if;

  -- LOCK: uma execução por vez (por mês). Segundo clique simultâneo é recusado.
  v_got := pg_try_advisory_xact_lock(hashtext('projecao_snapshot_atualizar')::int, hashtext(p_mes)::int);
  if not v_got then
    raise exception 'Ja existe uma atualizacao em andamento para %.', p_mes using errcode = '55P03';
  end if;

  v_t0 := clock_timestamp();
  begin
    if coalesce(current_setting('projecao.forcar_erro', true),'') = '1' then
      raise exception 'FALHA_SIMULADA_TESTE';
    end if;
    v_payload := public.projecao_calcular_filial(p_mes);
  exception when others then
    -- Preserva o snapshot anterior; registra só o erro/metadados.
    update public.projecao_snapshot
      set status = 'erro', erro_resumo = left(sqlerrm, 300),
          atualizado_em = now(), atualizado_por = coalesce(v_email,'service_role')
      where escopo = 'FILIAL' and mes_referencia = p_mes;
    return jsonb_build_object('status','erro','mes_referencia',p_mes,'erro_resumo',left(sqlerrm,300));
  end;

  v_ms := round(extract(milliseconds from clock_timestamp() - v_t0));
  insert into public.projecao_snapshot(escopo, mes_referencia, payload, status, atualizado_em, atualizado_por, duracao_ms, erro_resumo)
  values ('FILIAL', p_mes, v_payload, 'ok', now(), coalesce(v_email,'service_role'), v_ms, null)
  on conflict (escopo, mes_referencia) do update
    set payload = excluded.payload, status = 'ok', atualizado_em = excluded.atualizado_em,
        atualizado_por = excluded.atualizado_por, duracao_ms = excluded.duracao_ms, erro_resumo = null;

  return jsonb_build_object('status','ok','mes_referencia',p_mes,'duracao_ms',v_ms,
    'atualizado_em', now(), 'atualizado_por', coalesce(v_email,'service_role'));
end;
$function$;

revoke all on function public.projecao_calcular_filial(text) from public, anon, authenticated;
grant execute on function public.projecao_snapshot_ler(text)       to authenticated, service_role;
grant execute on function public.projecao_snapshot_atualizar(text) to authenticated, service_role;
