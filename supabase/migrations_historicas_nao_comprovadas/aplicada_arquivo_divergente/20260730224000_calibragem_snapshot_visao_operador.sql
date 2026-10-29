-- ============================================================================
-- CALIBRAGEM — SNAPSHOT E VISÃO CONSOLIDADA POR OPERADOR (item 2.1)
-- ----------------------------------------------------------------------------
-- Estratégia anti-saturação (lição do kill switch): a agregação pesada roda
-- SOB DEMANDA (RPC calibragem_recomputar_snapshot) e grava um snapshot. A tela
-- lê o snapshot pronto (calibragem_visao_operadores) — carga zero no load.
-- O drill-down de cada card (calibragem_listar_casos) consulta AO VIVO, mas
-- filtrado por 1 operador (barato).
--
-- Saldo canônico em massa (ver dicionário): saldo = títulos originais abertos
-- (acordos_titulos ABERTO/em_aberto sem acordo) + parcelas abertas de acordos
-- não cancelados. NÃO usa colunas snapshot defasadas de `casos`.
--
-- Nada em tabelas existentes é alterado. Reversível.
-- ============================================================================

begin;

-- Tabelas de snapshot --------------------------------------------------------
create table if not exists public.calibragem_snapshot_meta(
  id            uuid primary key default gen_random_uuid(),
  gerado_em     timestamptz not null default now(),
  gerado_por    text,
  total_operadores integer,
  duracao_ms    integer,
  is_atual      boolean not null default true
);
create index if not exists idx_calib_snap_meta_atual on public.calibragem_snapshot_meta(is_atual, gerado_em desc);

create table if not exists public.calibragem_snapshot_operador(
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references public.calibragem_snapshot_meta(id) on delete cascade,
  operador_email text not null,
  operador_nome  text,
  indicadores   jsonb not null,
  gerado_em     timestamptz not null default now()
);
create index if not exists idx_calib_snap_op_snap on public.calibragem_snapshot_operador(snapshot_id);

alter table public.calibragem_snapshot_meta enable row level security;
alter table public.calibragem_snapshot_operador enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='calibragem_snapshot_meta' and policyname='calib_snap_meta_sel') then
    create policy calib_snap_meta_sel on public.calibragem_snapshot_meta for select to authenticated using (public.calibragem_e_gestao());
  end if;
  if not exists (select 1 from pg_policies where tablename='calibragem_snapshot_operador' and policyname='calib_snap_op_sel') then
    create policy calib_snap_op_sel on public.calibragem_snapshot_operador for select to authenticated using (public.calibragem_e_gestao());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Saldo canônico em massa por aluno (view auxiliar, SECURITY via RPC definer)
-- ---------------------------------------------------------------------------
create or replace view public.calibragem_saldo_aluno as
with tit as (
  -- mensalidades originais abertas (não vinculadas a acordo)
  select t.aluno_id, t.cpf,
         sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) as saldo_mensalidade,
         count(*) as qtd_titulos_abertos,
         min(t.vencimento) as venc_min,
         max(t.vencimento) as venc_max
  from public.acordos_titulos t
  where upper(coalesce(t.situacao,'')) = 'ABERTO'
    and lower(coalesce(t.status,'')) = 'em_aberto'
    and t.acordo_id is null
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo,true))
  group by t.aluno_id, t.cpf
),
par as (
  -- parcelas abertas de acordos não cancelados
  select a.aluno_id,
         sum(coalesce(p.valor,0)) as saldo_acordo,
         count(*) as qtd_parcelas_abertas
  from public.parcelas p
  join public.acordos a on a.id = p.acordo_id
  where lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
    and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
  group by a.aluno_id
)
select
  coalesce(tit.aluno_id, par.aluno_id)             as aluno_id,
  tit.cpf,
  coalesce(tit.saldo_mensalidade,0)                as saldo_mensalidade,
  coalesce(par.saldo_acordo,0)                     as saldo_acordo,
  coalesce(tit.saldo_mensalidade,0) + coalesce(par.saldo_acordo,0) as saldo_total,
  coalesce(tit.qtd_titulos_abertos,0)              as qtd_titulos_abertos,
  coalesce(par.qtd_parcelas_abertas,0)             as qtd_parcelas_abertas,
  tit.venc_min, tit.venc_max
from tit
full outer join par on par.aluno_id = tit.aluno_id;

-- ---------------------------------------------------------------------------
-- RECOMPUTAR SNAPSHOT (gestão) — faz a agregação pesada UMA vez
-- ---------------------------------------------------------------------------
create or replace function public.calibragem_recomputar_snapshot()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap_id uuid;
  v_ini timestamptz := clock_timestamp();
  v_total int;
  v_limite int := coalesce((select (valor)::text::int from public.calibragem_parametros where chave='limite_carteira'), 500);
begin
  -- permite gestão (via UI, JWT com email) OU contexto server-side/admin
  -- (auth.jwt() nulo = chamada por service_role/cron; anon/public já não têm
  -- EXECUTE por REVOKE, então isto não abre brecha ao front).
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para recomputar a Calibragem.';
  end if;

  -- desmarca snapshots anteriores
  update public.calibragem_snapshot_meta set is_atual=false where is_atual;

  insert into public.calibragem_snapshot_meta(gerado_por, is_atual)
  values (coalesce(auth.jwt() ->> 'email','?'), true)
  returning id into v_snap_id;

  -- base: casos com operador + saldo canônico por aluno
  with base as (
    select
      c.id, c.operador_email, c.operador_nome, c.cpf_limpo, c.aluno_id,
      coalesce(c.dias_atraso,0) as dias_atraso,
      upper(coalesce(c.criticidade,'')) as criticidade,
      c.status_acionamento, c.data_ultimo_acionamento,
      coalesce(s.saldo_total,0)       as saldo_total,
      coalesce(s.saldo_mensalidade,0) as saldo_mensalidade,
      coalesce(s.qtd_titulos_abertos,0) as qtd_titulos,
      s.venc_min
    from public.casos c
    left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where c.operador_email is not null
  ),
  -- acordos por operador (status derivado das parcelas)
  ac as (
    select a.id, a.operador_responsavel_email as op_email, a.saldo,
           bool_or(p.venc_unpaid) as tem_vencida,
           max(p.dias_overdue) filter (where p.venc_unpaid) as max_overdue,
           bool_or(p.a_vencer_mes) as tem_a_vencer_mes,
           sum(p.valor_a_vencer_mes) as valor_a_vencer_mes
    from public.acordos a
    left join lateral (
      select
        (upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
          and pp.vencimento < current_date) as venc_unpaid,
        (current_date - pp.vencimento) as dias_overdue,
        (upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
          and date_trunc('month',pp.vencimento) = date_trunc('month',current_date)) as a_vencer_mes,
        case when upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
                  and date_trunc('month',pp.vencimento) = date_trunc('month',current_date)
             then coalesce(pp.valor,0) else 0 end as valor_a_vencer_mes
      from public.parcelas pp where pp.acordo_id = a.id
    ) p on true
    where lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
    group by a.id, a.operador_responsavel_email, a.saldo
  ),
  ac_agg as (
    select op_email,
      count(*) filter (where not coalesce(tem_vencida,false)) as ac_em_dia,
      sum(saldo) filter (where not coalesce(tem_vencida,false)) as ac_em_dia_valor,
      count(*) filter (where coalesce(tem_a_vencer_mes,false)) as ac_a_vencer,
      sum(valor_a_vencer_mes) as ac_a_vencer_valor,
      count(*) filter (where coalesce(tem_vencida,false) and coalesce(max_overdue,0) <= 30) as ac_vencido,
      sum(saldo) filter (where coalesce(tem_vencida,false) and coalesce(max_overdue,0) <= 30) as ac_vencido_valor,
      count(*) filter (where coalesce(tem_vencida,false) and coalesce(max_overdue,0) > 30) as ac_quebrado,
      sum(saldo) filter (where coalesce(tem_vencida,false) and coalesce(max_overdue,0) > 30) as ac_quebrado_valor,
      count(*) as ac_total,
      sum(coalesce(valor_a_vencer_mes,0)) as previsto_mes
    from ac group by op_email
  ),
  -- pagamentos confirmados no mês (parcelas pagas) por operador do acordo
  pg as (
    select a.operador_responsavel_email as op_email,
           count(*) as pg_qtd, sum(coalesce(p.valor,0)) as pg_valor
    from public.parcelas p join public.acordos a on a.id=p.acordo_id
    where upper(coalesce(p.status,'')) in ('PAGO','PAGA')
      and date_trunc('month', coalesce(p.pago_em, p.atualizado_em)) = date_trunc('month', now())
    group by a.operador_responsavel_email
  ),
  -- movimentações de nivelamento a partir da auditoria da Calibragem
  niv as (
    select operador_novo_email as op_email,
           count(*) filter (where evento='MOVIMENTACAO_NIVELAMENTO') as recebidos
    from public.calibragem_auditoria group by operador_novo_email
  ),
  niv_out as (
    select operador_anterior_email as op_email,
           count(*) filter (where evento='MOVIMENTACAO_NIVELAMENTO') as retirados
    from public.calibragem_auditoria group by operador_anterior_email
  ),
  agg as (
    select
      b.operador_email as op_email,
      max(b.operador_nome) as op_nome,
      count(*) as cpfs_qtd,
      sum(b.saldo_total) as saldo_total,
      count(*) filter (where b.saldo_mensalidade > 0) as men_qtd,
      sum(b.saldo_mensalidade) as men_valor,
      sum(b.qtd_titulos) as titulos_qtd,
      -- faixas de atraso
      count(*) filter (where b.dias_atraso between 0 and 30) as fa_0_30_q,
      sum(b.saldo_total) filter (where b.dias_atraso between 0 and 30) as fa_0_30_v,
      count(*) filter (where b.dias_atraso between 31 and 60) as fa_31_60_q,
      sum(b.saldo_total) filter (where b.dias_atraso between 31 and 60) as fa_31_60_v,
      count(*) filter (where b.dias_atraso between 61 and 90) as fa_61_90_q,
      sum(b.saldo_total) filter (where b.dias_atraso between 61 and 90) as fa_61_90_v,
      count(*) filter (where b.dias_atraso between 91 and 180) as fa_91_180_q,
      sum(b.saldo_total) filter (where b.dias_atraso between 91 and 180) as fa_91_180_v,
      count(*) filter (where b.dias_atraso between 181 and 360) as fa_181_360_q,
      sum(b.saldo_total) filter (where b.dias_atraso between 181 and 360) as fa_181_360_v,
      count(*) filter (where b.dias_atraso > 360) as fa_360_q,
      sum(b.saldo_total) filter (where b.dias_atraso > 360) as fa_360_v,
      -- anos da dívida (ano do vencimento mais antigo aberto)
      count(*) filter (where extract(year from b.venc_min)=2024) as ano24_q,
      sum(b.saldo_total) filter (where extract(year from b.venc_min)=2024) as ano24_v,
      count(*) filter (where extract(year from b.venc_min)=2025) as ano25_q,
      sum(b.saldo_total) filter (where extract(year from b.venc_min)=2025) as ano25_v,
      count(*) filter (where extract(year from b.venc_min)=2026) as ano26_q,
      sum(b.saldo_total) filter (where extract(year from b.venc_min)=2026) as ano26_v,
      -- operacionais
      count(*) filter (where b.status_acionamento is null) as sem_acion_q,
      sum(b.saldo_total) filter (where b.status_acionamento is null) as sem_acion_v,
      count(*) filter (where b.status_acionamento is not null and b.data_ultimo_acionamento < current_date - 10) as sem_recente_q,
      sum(b.saldo_total) filter (where b.status_acionamento is not null and b.data_ultimo_acionamento < current_date - 10) as sem_recente_v,
      count(*) filter (where b.criticidade in ('CRITICO','URGENTE')) as crit_q,
      sum(b.saldo_total) filter (where b.criticidade in ('CRITICO','URGENTE')) as crit_v,
      count(*) filter (where b.dias_atraso > 360) as antigo_q,
      sum(b.saldo_total) filter (where b.dias_atraso > 360) as antigo_v
    from base b
    group by b.operador_email
  )
  insert into public.calibragem_snapshot_operador(snapshot_id, operador_email, operador_nome, indicadores)
  select
    v_snap_id, g.op_email, g.op_nome,
    jsonb_build_object(
      'cpfs',                jsonb_build_object('qtd', g.cpfs_qtd, 'valor', round(coalesce(g.saldo_total,0),2)),
      'mensalidades',        jsonb_build_object('qtd', g.men_qtd, 'valor', round(coalesce(g.men_valor,0),2)),
      'titulos_abertos',     jsonb_build_object('qtd', coalesce(g.titulos_qtd,0), 'valor', round(coalesce(g.men_valor,0),2)),
      'saldo_total',         jsonb_build_object('qtd', g.cpfs_qtd, 'valor', round(coalesce(g.saldo_total,0),2)),
      'valor_medio_cpf',     round(coalesce(g.saldo_total,0) / nullif(g.cpfs_qtd,0), 2),
      'valor_medio_mensalidade', round(coalesce(g.men_valor,0) / nullif(g.titulos_qtd,0), 2),
      'limite',              jsonb_build_object('usado', g.cpfs_qtd, 'total', v_limite, 'disponivel', greatest(v_limite - g.cpfs_qtd,0)),
      'faixas_atraso', jsonb_build_array(
        jsonb_build_object('rotulo','0-30','qtd',g.fa_0_30_q,'valor',round(coalesce(g.fa_0_30_v,0),2)),
        jsonb_build_object('rotulo','31-60','qtd',g.fa_31_60_q,'valor',round(coalesce(g.fa_31_60_v,0),2)),
        jsonb_build_object('rotulo','61-90','qtd',g.fa_61_90_q,'valor',round(coalesce(g.fa_61_90_v,0),2)),
        jsonb_build_object('rotulo','91-180','qtd',g.fa_91_180_q,'valor',round(coalesce(g.fa_91_180_v,0),2)),
        jsonb_build_object('rotulo','181-360','qtd',g.fa_181_360_q,'valor',round(coalesce(g.fa_181_360_v,0),2)),
        jsonb_build_object('rotulo','360+','qtd',g.fa_360_q,'valor',round(coalesce(g.fa_360_v,0),2))
      ),
      'anos', jsonb_build_array(
        jsonb_build_object('ano',2024,'qtd',g.ano24_q,'valor',round(coalesce(g.ano24_v,0),2)),
        jsonb_build_object('ano',2025,'qtd',g.ano25_q,'valor',round(coalesce(g.ano25_v,0),2)),
        jsonb_build_object('ano',2026,'qtd',g.ano26_q,'valor',round(coalesce(g.ano26_v,0),2))
      ),
      'sem_acionamento',        jsonb_build_object('qtd', g.sem_acion_q, 'valor', round(coalesce(g.sem_acion_v,0),2)),
      'sem_acionamento_recente',jsonb_build_object('qtd', g.sem_recente_q, 'valor', round(coalesce(g.sem_recente_v,0),2)),
      'criticos',               jsonb_build_object('qtd', g.crit_q, 'valor', round(coalesce(g.crit_v,0),2)),
      'antigos',                jsonb_build_object('qtd', g.antigo_q, 'valor', round(coalesce(g.antigo_v,0),2)),
      'acordos_em_dia',   jsonb_build_object('qtd', coalesce(a.ac_em_dia,0),   'valor', round(coalesce(a.ac_em_dia_valor,0),2)),
      'acordos_a_vencer', jsonb_build_object('qtd', coalesce(a.ac_a_vencer,0), 'valor', round(coalesce(a.ac_a_vencer_valor,0),2)),
      'acordos_vencidos', jsonb_build_object('qtd', coalesce(a.ac_vencido,0),  'valor', round(coalesce(a.ac_vencido_valor,0),2)),
      'acordos_quebrados',jsonb_build_object('qtd', coalesce(a.ac_quebrado,0), 'valor', round(coalesce(a.ac_quebrado_valor,0),2)),
      'previsto_entrada_mes', jsonb_build_object('qtd', coalesce(a.ac_a_vencer,0), 'valor', round(coalesce(a.previsto_mes,0),2)),
      'recuperado_mes',   jsonb_build_object('qtd', coalesce(pg.pg_qtd,0), 'valor', round(coalesce(pg.pg_valor,0),2)),
      'pagamentos_confirmados', jsonb_build_object('qtd', coalesce(pg.pg_qtd,0), 'valor', round(coalesce(pg.pg_valor,0),2)),
      'negociacoes_andamento',  jsonb_build_object('qtd', coalesce(a.ac_total,0), 'valor', round(coalesce(a.ac_em_dia_valor,0)+coalesce(a.ac_a_vencer_valor,0),2)),
      'receptivo_recebidos',    jsonb_build_object('qtd', 0, 'valor', 0),
      'nivelamento_recebidos',  jsonb_build_object('qtd', coalesce(niv.recebidos,0), 'valor', 0),
      'nivelamento_retirados',  jsonb_build_object('qtd', coalesce(nout.retirados,0), 'valor', 0)
    )
  from agg g
  left join ac_agg a  on a.op_email = g.op_email
  left join pg        on pg.op_email = g.op_email
  left join niv       on niv.op_email = g.op_email
  left join niv_out nout on nout.op_email = g.op_email;

  get diagnostics v_total = row_count;
  update public.calibragem_snapshot_meta
     set total_operadores = v_total,
         duracao_ms = round(extract(milliseconds from (clock_timestamp()-v_ini)))
   where id = v_snap_id;

  return v_snap_id;
end;
$$;

revoke all on function public.calibragem_recomputar_snapshot() from public;
grant execute on function public.calibragem_recomputar_snapshot() to authenticated;

-- ---------------------------------------------------------------------------
-- LEITURA DA VISÃO (barata) — retorna o snapshot atual
-- ---------------------------------------------------------------------------
create or replace function public.calibragem_visao_operadores()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_snap_id uuid; v_meta record; v_ops jsonb;
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissão para ver a Calibragem.';
  end if;
  select id, gerado_em, gerado_por, total_operadores, duracao_ms
    into v_meta from public.calibragem_snapshot_meta where is_atual order by gerado_em desc limit 1;
  if v_meta.id is null then
    return jsonb_build_object('gerado_em', null, 'operadores', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'operador_email', operador_email,
           'operador_nome', operador_nome,
           'indicadores', indicadores) order by operador_nome), '[]'::jsonb)
    into v_ops
    from public.calibragem_snapshot_operador where snapshot_id = v_meta.id;
  return jsonb_build_object(
    'gerado_em', v_meta.gerado_em,
    'gerado_por', v_meta.gerado_por,
    'duracao_ms', v_meta.duracao_ms,
    'operadores', v_ops
  );
end;
$$;
revoke all on function public.calibragem_visao_operadores() from public;
grant execute on function public.calibragem_visao_operadores() to authenticated;

commit;
