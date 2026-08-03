-- =====================================================================
-- SAÚDE COMPLETA DA CARTEIRA — snapshot diário + exportação
-- Snapshot: idempotente por dia, NÃO recalcula histórico, não altera dados
-- operacionais (grava só na própria tabela). Cron 08:00 UTC = 05:00 BRT.
-- Exportação: reusa resumo/detalhes/qualidade => export = tela; escopo de
-- operador preservado (exportação global negada para operador).
-- =====================================================================

create table if not exists public.saude_carteira_snapshot (
  dia date primary key,
  gerado_em timestamptz not null default now(),
  duracao_ms integer,
  casos_ativos integer, cpfs_unicos integer, parcelas_abertas integer,
  saldo_vencido numeric, saldo_total numeric,
  nunca_acionados integer, sem_acionamento integer, retornos_vencidos integer,
  sem_telefone integer, sem_responsavel integer, criticos integer, urgentes integer,
  acordos_em_dia integer, acordos_vencidos integer,
  por_estabelecimento jsonb, por_faixa jsonb, por_operador jsonb,
  erros text
);
alter table public.saude_carteira_snapshot enable row level security;
revoke all on public.saude_carteira_snapshot from public, anon, authenticated;

-- Gerador do snapshot (GLOBAL). Autorizado para cron/service (auth nulo) ou gestão.
create or replace function public.saude_carteira_snapshot_gerar()
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare
  v_t0 timestamptz := clock_timestamp();
  v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_tot jsonb; v_estab jsonb; v_faixa jsonb; v_oper jsonb; v_parc int;
begin
  -- autorização: cron/service (sem jwt) OU gestão
  if auth.jwt() is not null and not public.usuario_e_gestao() then
    raise exception 'Acesso negado ao snapshot (gestao/cron apenas).' using errcode='42501';
  end if;

  drop table if exists tmp_snap; create temporary table tmp_snap on commit drop as
  select * from public.vw_saude_carteira where encerrado = false;

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
  on conflict (dia) do update set  -- idempotente: só o dia corrente é reescrito; histórico intacto
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
  update public.saude_carteira_snapshot set erros = SQLERRM where dia = v_dia;
  return jsonb_build_object('dia', v_dia, 'erro', SQLERRM);
end; $$;
revoke all on function public.saude_carteira_snapshot_gerar() from public, anon, authenticated;

-- Leitura do histórico (gestão) com referências de comparação.
create or replace function public.saude_carteira_historico(p_dias integer default 30)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_series jsonb; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado ao historico (gestao apenas).' using errcode='42501';
  end if;
  select jsonb_agg(row_to_json(s) order by s.dia) into v_series
  from public.saude_carteira_snapshot s
  where s.dia >= v_hoje - least(greatest(coalesce(p_dias,30),1),365);
  return jsonb_build_object(
    'series', coalesce(v_series,'[]'::jsonb),
    'referencias', jsonb_build_object(
      'hoje', (select row_to_json(s) from public.saude_carteira_snapshot s where s.dia = v_hoje),
      'ontem', (select row_to_json(s) from public.saude_carteira_snapshot s where s.dia = v_hoje - 1),
      'sete_dias', (select row_to_json(s) from public.saude_carteira_snapshot s where s.dia = v_hoje - 7),
      'inicio_mes', (select row_to_json(s) from public.saude_carteira_snapshot s where s.dia = date_trunc('month', v_hoje)::date)
    ), 'gerado_em', now());
end; $$;
revoke all on function public.saude_carteira_historico(integer) from public, anon;
grant execute on function public.saude_carteira_historico(integer) to authenticated;

-- Exportação: reusa as RPCs da tela (export = tela). Escopo preservado.
create or replace function public.saude_carteira_exportar(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare v_resumo jsonb; v_qual jsonb; v_det jsonb;
begin
  v_resumo := public.saude_carteira_resumo(p_filtros);            -- valida escopo
  v_qual   := public.saude_carteira_qualidade(p_filtros);
  v_det    := public.saude_carteira_detalhes(p_filtros, 50000, 0); -- detalhamento completo (mascarado)
  return jsonb_build_object('resumo', v_resumo, 'qualidade', v_qual, 'detalhamento', v_det,
    'gerado_em', now());
end; $$;
revoke all on function public.saude_carteira_exportar(jsonb) from public, anon;
grant execute on function public.saude_carteira_exportar(jsonb) to authenticated;

-- Cron diário: 08:00 UTC = 05:00 BRT (após a virada de criticidade das 06 UTC).
select cron.unschedule('saude_carteira_snapshot_diario')
where exists (select 1 from cron.job where jobname='saude_carteira_snapshot_diario');
select cron.schedule('saude_carteira_snapshot_diario', '0 8 * * *',
  $cron$ select public.saude_carteira_snapshot_gerar(); $cron$);
