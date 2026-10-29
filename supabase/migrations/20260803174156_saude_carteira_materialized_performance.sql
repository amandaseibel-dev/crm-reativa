-- =====================================================================
-- SAÚDE COMPLETA DA CARTEIRA — desempenho: materialized view + índices
-- A view vw_saude_carteira recalcula caso_encerrado_operacional ->
-- saldo_titulos_aberto por linha (N+1, ~8,6s em 17,5k casos). Materializamos
-- em mv_saude_carteira (calcula 1x por refresh); RPCs leem a MV (rápido).
-- "Atualizar indicadores" = re-consulta a MV (leve). Refresh da MV = gestão/cron.
-- Nenhuma escrita em dados operacionais (só na MV e na meta).
-- =====================================================================

create materialized view if not exists public.mv_saude_carteira as
  select * from public.vw_saude_carteira;
create unique index if not exists ux_mv_saude_carteira_caso on public.mv_saude_carteira(caso_id);
create index if not exists ix_mv_sc_encerrado on public.mv_saude_carteira(encerrado);
create index if not exists ix_mv_sc_estab on public.mv_saude_carteira(estabelecimento);
create index if not exists ix_mv_sc_operador on public.mv_saude_carteira(operador_email);
create index if not exists ix_mv_sc_faixa on public.mv_saude_carteira(faixa_atraso);
create index if not exists ix_mv_sc_tempo on public.mv_saude_carteira(faixa_tempo_sem_acionamento);
create index if not exists ix_mv_sc_acordo on public.mv_saude_carteira(acordo_situacao);
revoke all on public.mv_saude_carteira from public, anon, authenticated;

create table if not exists public.saude_carteira_mv_meta (
  id boolean primary key default true, atualizado_em timestamptz, duracao_ms int);
insert into public.saude_carteira_mv_meta(id, atualizado_em) values (true, now())
  on conflict (id) do nothing;
revoke all on public.saude_carteira_mv_meta from public, anon, authenticated;

-- Refresh da MV (gestão ou cron). CONCURRENTLY: não bloqueia leituras.
create or replace function public.saude_carteira_atualizar()
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare v_t0 timestamptz := clock_timestamp(); v_ms int;
begin
  if auth.jwt() is not null and not public.usuario_e_gestao() then
    raise exception 'Apenas gestao pode atualizar a base de indicadores.' using errcode='42501';
  end if;
  refresh materialized view concurrently public.mv_saude_carteira;
  v_ms := extract(milliseconds from clock_timestamp()-v_t0)::int;
  update public.saude_carteira_mv_meta set atualizado_em=now(), duracao_ms=v_ms where id;
  return jsonb_build_object('atualizado_em', now(), 'duracao_ms', v_ms);
end; $$;
revoke all on function public.saude_carteira_atualizar() from public, anon;
grant execute on function public.saude_carteira_atualizar() to authenticated;

-- Meta de atualização (para exibir "última atualização da base") — qualquer autenticado lê.
create or replace function public.saude_carteira_mv_status()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('atualizado_em', atualizado_em, 'duracao_ms', duracao_ms)
  from public.saude_carteira_mv_meta where id;
$$;
revoke all on function public.saude_carteira_mv_status() from public, anon;
grant execute on function public.saude_carteira_mv_status() to authenticated;

-- Repoint das RPCs para a MV (fonte única materializada).
create or replace function public.saude_carteira_resumo(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_incluir_encerrados boolean := coalesce((v_f->>'incluir_encerrados')::boolean, false);
  v_min_dias int := coalesce((v_f->>'min_dias_sem_acionamento')::int, 5);
  v_estab text := nullif(v_f->>'estabelecimento','');
  v_operador text := nullif(v_f->>'operador_email','');
  v_totais jsonb; v_estabs jsonb; v_mtx_faixa jsonb; v_mtx_tempo jsonb; v_operadores jsonb;
begin
  drop table if exists tmp_sc; create temporary table tmp_sc on commit drop as
  select * from public.mv_saude_carteira v
  where (v_incluir_encerrados or v.encerrado = false)
    and (v_estab is null or v.estabelecimento = v_estab)
    and (v_operador is null or v.operador_email is not distinct from v_operador);
  select jsonb_build_object(
    'casos_ativos', count(*), 'cpfs_unicos', count(distinct cpf_conta),
    'saldo_vencido', coalesce(sum(saldo_vencido),0), 'saldo_total', coalesce(sum(saldo_total),0),
    'nunca_acionados', count(*) filter (where nunca_acionado),
    'sem_acionamento_limite', count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias),
    'pct_sem_acionamento', round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1), 1),
    'retornos_vencidos', count(*) filter (where retorno_vencido),
    'sem_telefone', count(*) filter (where sem_telefone), 'sem_responsavel', count(*) filter (where sem_responsavel),
    'criticos', count(*) filter (where critico_canonico), 'urgentes', count(*) filter (where urgente_canonico),
    'acordos_em_dia', count(*) filter (where acordo_situacao = 'EM_DIA'),
    'acordos_vencidos', count(*) filter (where acordo_situacao = 'VENCIDO'),
    'acordos_quebrados', count(*) filter (where acordo_situacao = 'QUEBRADO'),
    'acordos_em_dia_sem_acompanhamento', count(*) filter (where acordo_situacao='EM_DIA' and (data_retorno is null or data_retorno < current_date)),
    'casos_revisao', count(*) filter (where cpf_conta is null or aluno_id is null),
    'min_dias_sem_acionamento', v_min_dias
  ) into v_totais from tmp_sc;
  select jsonb_agg(t order by t.sem_acionamento_limite desc) into v_estabs from (
    select estabelecimento, count(*) as casos_ativos, count(distinct cpf_conta) as cpfs_unicos,
      coalesce(sum(saldo_vencido),0) as saldo_vencido, coalesce(sum(saldo_total),0) as saldo_total,
      count(*) filter (where nunca_acionado) as nunca_acionados,
      count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) as sem_acionamento_limite,
      round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1),1) as pct_sem_acionamento,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 7) as sem_ac_7,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 15) as sem_ac_15,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 30) as sem_ac_30,
      count(*) filter (where retorno_vencido) as retornos_vencidos,
      count(*) filter (where sem_telefone) as sem_telefone, count(*) filter (where sem_responsavel) as sem_responsavel,
      count(*) filter (where critico_canonico) as criticos, count(*) filter (where urgente_canonico) as urgentes,
      count(*) filter (where acordo_situacao='EM_DIA') as acordos_em_dia,
      count(*) filter (where acordo_situacao='VENCIDO') as acordos_vencidos,
      count(*) filter (where acordo_situacao='QUEBRADO') as acordos_quebrados,
      count(*) filter (where cpf_conta is null or aluno_id is null) as casos_revisao
    from tmp_sc group by estabelecimento
  ) t;
  select jsonb_agg(t order by t.estabelecimento) into v_mtx_faixa from (
    select estabelecimento,
      count(*) filter (where faixa_atraso='A_VENCER') as a_vencer,
      count(*) filter (where faixa_atraso='1_30') as f1_30, count(*) filter (where faixa_atraso='31_60') as f31_60,
      count(*) filter (where faixa_atraso='61_90') as f61_90, count(*) filter (where faixa_atraso='91_180') as f91_180,
      count(*) filter (where faixa_atraso='181_365') as f181_365, count(*) filter (where faixa_atraso='MAIS_365') as f_mais_365,
      count(distinct cpf_conta) as cpfs, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) as total
    from tmp_sc group by estabelecimento
  ) t;
  select jsonb_agg(t order by t.estabelecimento) into v_mtx_tempo from (
    select estabelecimento,
      count(*) filter (where faixa_tempo_sem_acionamento='NUNCA') as nunca,
      count(*) filter (where faixa_tempo_sem_acionamento='1D') as d1, count(*) filter (where faixa_tempo_sem_acionamento='2_3D') as d2_3,
      count(*) filter (where faixa_tempo_sem_acionamento='4_5D') as d4_5, count(*) filter (where faixa_tempo_sem_acionamento='6_7D') as d6_7,
      count(*) filter (where faixa_tempo_sem_acionamento='8_15D') as d8_15, count(*) filter (where faixa_tempo_sem_acionamento='16_30D') as d16_30,
      count(*) filter (where faixa_tempo_sem_acionamento='MAIS_30D') as d_mais_30,
      count(distinct cpf_conta) as cpfs, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) as total
    from tmp_sc group by estabelecimento
  ) t;
  select jsonb_agg(t order by t.casos_ativos desc) into v_operadores from (
    select coalesce(operador_email,'(SEM RESPONSAVEL)') as operador_email, count(*) as casos_ativos,
      count(distinct cpf_conta) as cpfs_unicos, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) filter (where nunca_acionado) as nunca_acionados,
      count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) as sem_acionamento_limite,
      round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1),1) as pct_sem_acionamento,
      count(*) filter (where retorno_vencido) as retornos_vencidos, count(*) filter (where sem_telefone) as sem_telefone,
      count(*) filter (where critico_canonico) as criticos, count(*) filter (where urgente_canonico) as urgentes,
      count(*) filter (where acordo_situacao='EM_DIA') as acordos_em_dia,
      count(*) filter (where acordo_situacao='VENCIDO') as acordos_vencidos
    from tmp_sc group by coalesce(operador_email,'(SEM RESPONSAVEL)')
  ) t;
  return jsonb_build_object('totais', v_totais, 'estabelecimentos', coalesce(v_estabs,'[]'::jsonb),
    'matriz_faixa_atraso', coalesce(v_mtx_faixa,'[]'::jsonb),
    'matriz_tempo_sem_acionamento', coalesce(v_mtx_tempo,'[]'::jsonb),
    'operadores', coalesce(v_operadores,'[]'::jsonb),
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'atualizado_em', (select atualizado_em from public.saude_carteira_mv_meta where id),
    'filtros', v_f, 'gerado_em', now());
end; $$;

create or replace function public.saude_carteira_detalhes(
  p_filtros jsonb default '{}'::jsonb, p_limite integer default 50, p_offset integer default 0
) returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_incluir_encerrados boolean := coalesce((v_f->>'incluir_encerrados')::boolean, false);
  v_min_dias int := coalesce((v_f->>'min_dias_sem_acionamento')::int, 5);
  v_estab text := nullif(v_f->>'estabelecimento','');
  v_operador text := nullif(v_f->>'operador_email','');
  v_faixa_atraso text := nullif(v_f->>'faixa_atraso','');
  v_faixa_tempo text := nullif(v_f->>'faixa_tempo','');
  v_acordo text := nullif(v_f->>'acordo_situacao','');
  v_indicador text := nullif(v_f->>'indicador','');
  v_ordem text := coalesce(nullif(v_f->>'ordenar_por',''),'saldo_vencido');
  v_dir text := case when lower(coalesce(v_f->>'ordem_dir','desc'))='asc' then 'asc' else 'desc' end;
  v_lim int := least(greatest(coalesce(p_limite,50),1),50000);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_total int; v_rows jsonb;
begin
  drop table if exists tmp_det; create temporary table tmp_det on commit drop as
  select * from public.mv_saude_carteira v
  where (v_incluir_encerrados or v.encerrado = false)
    and (v_estab is null or v.estabelecimento = v_estab)
    and (v_operador is null or v.operador_email is not distinct from v_operador)
    and (v_faixa_atraso is null or v.faixa_atraso = v_faixa_atraso)
    and (v_faixa_tempo is null or v.faixa_tempo_sem_acionamento = v_faixa_tempo)
    and (v_acordo is null or v.acordo_situacao = v_acordo)
    and (v_indicador is null or case v_indicador
        when 'nunca_acionados' then v.nunca_acionado
        when 'sem_acionamento_limite' then (v.nunca_acionado or v.dias_sem_acionamento >= v_min_dias)
        when 'retornos_vencidos' then v.retorno_vencido
        when 'sem_telefone' then v.sem_telefone
        when 'sem_responsavel' then v.sem_responsavel
        when 'criticos' then v.critico_canonico
        when 'urgentes' then v.urgente_canonico
        when 'acordos_em_dia' then v.acordo_situacao='EM_DIA'
        when 'acordos_vencidos' then v.acordo_situacao='VENCIDO'
        when 'acordos_quebrados' then v.acordo_situacao='QUEBRADO'
        when 'acordos_em_dia_sem_acompanhamento' then (v.acordo_situacao='EM_DIA' and (v.data_retorno is null or v.data_retorno < current_date))
        when 'casos_revisao' then (v.cpf_conta is null or v.aluno_id is null)
        else true end);
  select count(*) into v_total from tmp_det;
  select jsonb_agg(row_to_json(x)) into v_rows from (
    select estabelecimento, caso_id, caso_codigo, cpf_mascarado as aluno_mascarado,
      operador_email, faixa_atraso, dias_atraso, parcela_vencida_mais_antiga,
      qtd_telefones, saldo_vencido, saldo_total, acordo_situacao, criticidade,
      data_ultimo_acionamento as ultimo_acionamento, dias_sem_acionamento,
      tipo_ultimo_acionamento, data_retorno as proximo_retorno, retorno_vencido,
      proxima_acao, (not sem_telefone) as possui_telefone, situacao_operacional,
      ultima_atualizacao, critico_canonico, urgente_canonico
    from tmp_det
    order by
      case when v_dir='asc' then
        case v_ordem when 'saldo_vencido' then saldo_vencido when 'saldo_total' then saldo_total
          when 'dias_sem_acionamento' then coalesce(dias_sem_acionamento,999999)::numeric
          when 'dias_atraso' then coalesce(dias_atraso,0)::numeric else saldo_vencido end
      end asc nulls last,
      case when v_dir='desc' then
        case v_ordem when 'saldo_vencido' then saldo_vencido when 'saldo_total' then saldo_total
          when 'dias_sem_acionamento' then coalesce(dias_sem_acionamento,-1)::numeric
          when 'dias_atraso' then coalesce(dias_atraso,0)::numeric else saldo_vencido end
      end desc nulls last,
      caso_id
    limit v_lim offset v_off
  ) x;
  return jsonb_build_object('total', v_total, 'limite', v_lim, 'offset', v_off,
    'rows', coalesce(v_rows,'[]'::jsonb),
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'atualizado_em', (select atualizado_em from public.saude_carteira_mv_meta where id),
    'filtros', v_f, 'gerado_em', now());
end; $$;

create or replace function public.saude_carteira_qualidade(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_operador text := nullif(v_f->>'operador_email','');
  v_r jsonb;
begin
  drop table if exists tmp_q; create temporary table tmp_q on commit drop as
  select * from public.mv_saude_carteira v
  where v.encerrado = false
    and (v_operador is null or v.operador_email is not distinct from v_operador);
  select jsonb_build_object(
    'sem_telefone', count(*) filter (where sem_telefone),
    'sem_email', count(*) filter (where sem_email),
    'sem_responsavel', count(*) filter (where sem_responsavel),
    'sem_estabelecimento', count(*) filter (where estabelecimento = '(SEM ESTABELECIMENTO)'),
    'sem_faixa_atraso', count(*) filter (where dias_atraso is null),
    'saldo_zero_ativo', count(*) filter (where coalesce(saldo_total,0) <= 0),
    'caso_sem_aluno', count(*) filter (where aluno_id is null),
    'acordo_vencido_sem_saldo', count(*) filter (where acordo_situacao='VENCIDO' and coalesce(saldo_vencido,0)=0),
    'sem_cpf', count(*) filter (where cpf_conta is null),
    'critico_sem_saldo_vencido', count(*) filter (where upper(coalesce(criticidade,''))='CRITICO' and coalesce(saldo_vencido,0)=0)
  ) into v_r from tmp_q;
  return jsonb_build_object('qualidade', v_r,
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'gerado_em', now());
end; $$;

-- snapshot lê a MV também (consistência; cron faz refresh antes)
create or replace function public.saude_carteira_snapshot_gerar()
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare
  v_t0 timestamptz := clock_timestamp();
  v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_tot jsonb; v_estab jsonb; v_faixa jsonb; v_oper jsonb; v_parc int;
begin
  if auth.jwt() is not null and not public.usuario_e_gestao() then
    raise exception 'Acesso negado ao snapshot (gestao/cron apenas).' using errcode='42501';
  end if;
  drop table if exists tmp_snap; create temporary table tmp_snap on commit drop as
  select * from public.mv_saude_carteira where encerrado = false;
  select count(*) into v_parc from public.parcelas where status in ('VENCIDA','A_VENCER');
  select jsonb_build_object(
    'casos_ativos', count(*), 'cpfs_unicos', count(distinct cpf_conta),
    'saldo_vencido', coalesce(sum(saldo_vencido),0), 'saldo_total', coalesce(sum(saldo_total),0),
    'nunca_acionados', count(*) filter (where nunca_acionado),
    'sem_acionamento', count(*) filter (where nunca_acionado or dias_sem_acionamento >= 5),
    'retornos_vencidos', count(*) filter (where retorno_vencido),
    'sem_telefone', count(*) filter (where sem_telefone),
    'sem_responsavel', count(*) filter (where sem_responsavel),
    'criticos', count(*) filter (where critico_canonico),
    'urgentes', count(*) filter (where urgente_canonico),
    'acordos_em_dia', count(*) filter (where acordo_situacao='EM_DIA'),
    'acordos_vencidos', count(*) filter (where acordo_situacao='VENCIDO')
  ) into v_tot from tmp_snap;
  select jsonb_agg(t order by t.casos desc) into v_estab from (
    select estabelecimento, count(*) casos, count(distinct cpf_conta) cpfs,
      coalesce(sum(saldo_vencido),0) saldo_vencido, coalesce(sum(saldo_total),0) saldo_total,
      count(*) filter (where nunca_acionado or dias_sem_acionamento>=5) sem_acionamento
    from tmp_snap group by estabelecimento) t;
  select jsonb_object_agg(faixa_atraso, q) into v_faixa from (
    select faixa_atraso, count(*) q from tmp_snap group by faixa_atraso) z;
  select jsonb_agg(t order by t.casos desc) into v_oper from (
    select coalesce(operador_email,'(SEM RESPONSAVEL)') operador, count(*) casos,
      coalesce(sum(saldo_vencido),0) saldo_vencido,
      count(*) filter (where nunca_acionado or dias_sem_acionamento>=5) sem_acionamento
    from tmp_snap group by coalesce(operador_email,'(SEM RESPONSAVEL)')) t;
  insert into public.saude_carteira_snapshot as s (
    dia, gerado_em, duracao_ms, casos_ativos, cpfs_unicos, parcelas_abertas,
    saldo_vencido, saldo_total, nunca_acionados, sem_acionamento, retornos_vencidos,
    sem_telefone, sem_responsavel, criticos, urgentes, acordos_em_dia, acordos_vencidos,
    por_estabelecimento, por_faixa, por_operador, erros)
  values (v_dia, now(), extract(milliseconds from clock_timestamp()-v_t0)::int,
    (v_tot->>'casos_ativos')::int, (v_tot->>'cpfs_unicos')::int, v_parc,
    (v_tot->>'saldo_vencido')::numeric, (v_tot->>'saldo_total')::numeric,
    (v_tot->>'nunca_acionados')::int, (v_tot->>'sem_acionamento')::int, (v_tot->>'retornos_vencidos')::int,
    (v_tot->>'sem_telefone')::int, (v_tot->>'sem_responsavel')::int, (v_tot->>'criticos')::int,
    (v_tot->>'urgentes')::int, (v_tot->>'acordos_em_dia')::int, (v_tot->>'acordos_vencidos')::int,
    coalesce(v_estab,'[]'::jsonb), coalesce(v_faixa,'{}'::jsonb), coalesce(v_oper,'[]'::jsonb), null)
  on conflict (dia) do update set
    gerado_em=excluded.gerado_em, duracao_ms=excluded.duracao_ms, casos_ativos=excluded.casos_ativos,
    cpfs_unicos=excluded.cpfs_unicos, parcelas_abertas=excluded.parcelas_abertas,
    saldo_vencido=excluded.saldo_vencido, saldo_total=excluded.saldo_total,
    nunca_acionados=excluded.nunca_acionados, sem_acionamento=excluded.sem_acionamento,
    retornos_vencidos=excluded.retornos_vencidos, sem_telefone=excluded.sem_telefone,
    sem_responsavel=excluded.sem_responsavel, criticos=excluded.criticos, urgentes=excluded.urgentes,
    acordos_em_dia=excluded.acordos_em_dia, acordos_vencidos=excluded.acordos_vencidos,
    por_estabelecimento=excluded.por_estabelecimento, por_faixa=excluded.por_faixa,
    por_operador=excluded.por_operador;
  return jsonb_build_object('dia', v_dia, 'casos', (v_tot->>'casos_ativos')::int,
    'duracao_ms', extract(milliseconds from clock_timestamp()-v_t0)::int);
exception when others then
  return jsonb_build_object('dia', v_dia, 'erro', SQLERRM);
end; $$;

-- Cron: refresh da MV a cada 2h; snapshot 08:05 UTC (05:05 BRT, após refresh das 08:00).
select cron.unschedule('saude_carteira_mv_refresh')
where exists (select 1 from cron.job where jobname='saude_carteira_mv_refresh');
select cron.schedule('saude_carteira_mv_refresh', '0 */2 * * *',
  $cron$ select public.saude_carteira_atualizar(); $cron$);
select cron.unschedule('saude_carteira_snapshot_diario')
where exists (select 1 from cron.job where jobname='saude_carteira_snapshot_diario');
select cron.schedule('saude_carteira_snapshot_diario', '5 8 * * *',
  $cron$ select public.saude_carteira_snapshot_gerar(); $cron$);
