-- ============================================================================
-- Calibragem: usar a data de acionamento MAIS RECENTE entre casos e alunos.
--
-- Causa raiz descoberta: casos.data_ultimo_acionamento está DESSINCRONIZADO de
-- alunos.data_ultimo_acionamento — o acionamento real foi gravado em `alunos`,
-- mas `casos` ficou nulo (7 casos só da Luana). Como o painel do operador lê
-- `alunos`, o operador via os casos como acionados; a Calibragem lia só `casos`
-- e contava como "sem acionamento" (Luana: 9 casos, sendo 7 já acionados).
--
-- Correção: na CTE base, join com public.alunos e usar
--   greatest(c.data_ultimo_acionamento, al.data_ultimo_acionamento)
-- (greatest ignora NULLs → pega a data existente / a mais recente das duas).
-- Resultado Luana: sem_acionamento 9 -> 2 (bate com o painel do operador).
--
-- NOTA: contorna a dessincronia casos<-alunos; a causa na origem (por que
-- casos.data_ultimo_acionamento não atualiza) segue para investigação à parte.
-- Mantém correções de 20260806160000 (data_ultimo_acionamento) e
-- 20260806170000 (só casos operacionais). Gate técnico inalterado.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.calibragem_recomputar_snapshot()
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_snap_id uuid; v_ini timestamptz := clock_timestamp(); v_total int;
  v_limite int := coalesce((select (valor)::text::int from public.calibragem_parametros where chave='limite_carteira'), 500);
begin
  if not (public.calibragem_e_gestao()
          or auth.role() = 'service_role'
          or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor')))
  then raise exception 'Sem permissão para recomputar a Calibragem.'; end if;
  update public.calibragem_snapshot_meta set is_atual=false where is_atual;
  insert into public.calibragem_snapshot_meta(gerado_por, is_atual) values (coalesce(auth.jwt() ->> 'email','?'), true) returning id into v_snap_id;
  with base as (
    select c.id, c.operador_email, c.operador_nome, c.cpf_limpo, c.aluno_id,
      coalesce(c.dias_atraso,0) as dias_atraso, upper(coalesce(c.criticidade,'')) as criticidade,
      c.status_acionamento,
      greatest(c.data_ultimo_acionamento, al.data_ultimo_acionamento) as data_ultimo_acionamento,
      coalesce(s.saldo_total,0) as saldo_total, coalesce(s.saldo_mensalidade,0) as saldo_mensalidade,
      coalesce(s.qtd_titulos_abertos,0) as qtd_titulos, s.venc_min
    from public.casos c
    left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    left join public.alunos al on al.id = c.aluno_id
    where c.operador_email is not null
      and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
  ),
  ac as (
    select a.id, a.operador_responsavel_email as op_email, a.saldo,
           bool_or(p.venc_unpaid) as tem_vencida, max(p.dias_overdue) filter (where p.venc_unpaid) as max_overdue,
           bool_or(p.a_vencer_mes) as tem_a_vencer_mes, sum(p.valor_a_vencer_mes) as valor_a_vencer_mes
    from public.acordos a
    left join lateral (
      select (upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') and pp.vencimento < current_date) as venc_unpaid,
        (current_date - pp.vencimento) as dias_overdue,
        (upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') and date_trunc('month',pp.vencimento)=date_trunc('month',current_date)) as a_vencer_mes,
        case when upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') and date_trunc('month',pp.vencimento)=date_trunc('month',current_date) then coalesce(pp.valor,0) else 0 end as valor_a_vencer_mes
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
      count(*) as ac_total, sum(coalesce(valor_a_vencer_mes,0)) as previsto_mes
    from ac group by op_email
  ),
  pg as (
    select a.operador_responsavel_email as op_email, count(*) as pg_qtd, sum(coalesce(p.valor,0)) as pg_valor
    from public.parcelas p join public.acordos a on a.id=p.acordo_id
    where upper(coalesce(p.status,'')) in ('PAGO','PAGA') and date_trunc('month', coalesce(p.pago_em, p.atualizado_em))=date_trunc('month', now())
    group by a.operador_responsavel_email
  ),
  niv as (select operador_novo_email as op_email, count(*) filter (where evento='MOVIMENTACAO_NIVELAMENTO') as recebidos from public.calibragem_auditoria group by operador_novo_email),
  niv_out as (select operador_anterior_email as op_email, count(*) filter (where evento='MOVIMENTACAO_NIVELAMENTO') as retirados from public.calibragem_auditoria group by operador_anterior_email),
  agg as (
    select b.operador_email as op_email, max(b.operador_nome) as op_nome, count(*) as cpfs_qtd,
      sum(b.saldo_total) as saldo_total,
      count(*) filter (where b.saldo_mensalidade > 0) as men_qtd, sum(b.saldo_mensalidade) as men_valor,
      sum(b.qtd_titulos) as titulos_qtd,
      count(*) filter (where b.dias_atraso between 0 and 30) as fa_0_30_q, sum(b.saldo_total) filter (where b.dias_atraso between 0 and 30) as fa_0_30_v,
      count(*) filter (where b.dias_atraso between 31 and 60) as fa_31_60_q, sum(b.saldo_total) filter (where b.dias_atraso between 31 and 60) as fa_31_60_v,
      count(*) filter (where b.dias_atraso between 61 and 90) as fa_61_90_q, sum(b.saldo_total) filter (where b.dias_atraso between 61 and 90) as fa_61_90_v,
      count(*) filter (where b.dias_atraso between 91 and 180) as fa_91_180_q, sum(b.saldo_total) filter (where b.dias_atraso between 91 and 180) as fa_91_180_v,
      count(*) filter (where b.dias_atraso between 181 and 360) as fa_181_360_q, sum(b.saldo_total) filter (where b.dias_atraso between 181 and 360) as fa_181_360_v,
      count(*) filter (where b.dias_atraso > 360) as fa_360_q, sum(b.saldo_total) filter (where b.dias_atraso > 360) as fa_360_v,
      count(*) filter (where extract(year from b.venc_min)=2024) as ano24_q, sum(b.saldo_total) filter (where extract(year from b.venc_min)=2024) as ano24_v,
      count(*) filter (where extract(year from b.venc_min)=2025) as ano25_q, sum(b.saldo_total) filter (where extract(year from b.venc_min)=2025) as ano25_v,
      count(*) filter (where extract(year from b.venc_min)=2026) as ano26_q, sum(b.saldo_total) filter (where extract(year from b.venc_min)=2026) as ano26_v,
      count(*) filter (where b.data_ultimo_acionamento is null) as sem_acion_q, sum(b.saldo_total) filter (where b.data_ultimo_acionamento is null) as sem_acion_v,
      count(*) filter (where b.data_ultimo_acionamento is not null and b.data_ultimo_acionamento < current_date - 10) as sem_recente_q,
      sum(b.saldo_total) filter (where b.data_ultimo_acionamento is not null and b.data_ultimo_acionamento < current_date - 10) as sem_recente_v,
      count(*) filter (where b.criticidade in ('CRITICO','URGENTE')) as crit_q, sum(b.saldo_total) filter (where b.criticidade in ('CRITICO','URGENTE')) as crit_v,
      count(*) filter (where b.dias_atraso > 360) as antigo_q, sum(b.saldo_total) filter (where b.dias_atraso > 360) as antigo_v
    from base b group by b.operador_email
  )
  insert into public.calibragem_snapshot_operador(snapshot_id, operador_email, operador_nome, indicadores)
  select v_snap_id, g.op_email, g.op_nome,
    jsonb_build_object(
      'cpfs', jsonb_build_object('qtd', g.cpfs_qtd, 'valor', round(coalesce(g.saldo_total,0),2)),
      'mensalidades', jsonb_build_object('qtd', g.men_qtd, 'valor', round(coalesce(g.men_valor,0),2)),
      'titulos_abertos', jsonb_build_object('qtd', coalesce(g.titulos_qtd,0), 'valor', round(coalesce(g.men_valor,0),2)),
      'saldo_total', jsonb_build_object('qtd', g.cpfs_qtd, 'valor', round(coalesce(g.saldo_total,0),2)),
      'valor_medio_cpf', round(coalesce(g.saldo_total,0)/nullif(g.cpfs_qtd,0),2),
      'valor_medio_mensalidade', round(coalesce(g.men_valor,0)/nullif(g.titulos_qtd,0),2),
      'limite', jsonb_build_object('usado', g.cpfs_qtd, 'total', v_limite, 'disponivel', greatest(v_limite-g.cpfs_qtd,0)),
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
      'sem_acionamento', jsonb_build_object('qtd', g.sem_acion_q, 'valor', round(coalesce(g.sem_acion_v,0),2)),
      'sem_acionamento_recente', jsonb_build_object('qtd', g.sem_recente_q, 'valor', round(coalesce(g.sem_recente_v,0),2)),
      'criticos', jsonb_build_object('qtd', g.crit_q, 'valor', round(coalesce(g.crit_v,0),2)),
      'antigos', jsonb_build_object('qtd', g.antigo_q, 'valor', round(coalesce(g.antigo_v,0),2)),
      'acordos_em_dia', jsonb_build_object('qtd', coalesce(a.ac_em_dia,0), 'valor', round(coalesce(a.ac_em_dia_valor,0),2)),
      'acordos_a_vencer', jsonb_build_object('qtd', coalesce(a.ac_a_vencer,0), 'valor', round(coalesce(a.ac_a_vencer_valor,0),2)),
      'acordos_vencidos', jsonb_build_object('qtd', coalesce(a.ac_vencido,0), 'valor', round(coalesce(a.ac_vencido_valor,0),2)),
      'acordos_quebrados', jsonb_build_object('qtd', coalesce(a.ac_quebrado,0), 'valor', round(coalesce(a.ac_quebrado_valor,0),2)),
      'previsto_entrada_mes', jsonb_build_object('qtd', coalesce(a.ac_a_vencer,0), 'valor', round(coalesce(a.previsto_mes,0),2)),
      'recuperado_mes', jsonb_build_object('qtd', coalesce(pg.pg_qtd,0), 'valor', round(coalesce(pg.pg_valor,0),2)),
      'pagamentos_confirmados', jsonb_build_object('qtd', coalesce(pg.pg_qtd,0), 'valor', round(coalesce(pg.pg_valor,0),2)),
      'negociacoes_andamento', jsonb_build_object('qtd', coalesce(a.ac_total,0), 'valor', round(coalesce(a.ac_em_dia_valor,0)+coalesce(a.ac_a_vencer_valor,0),2)),
      'receptivo_recebidos', jsonb_build_object('qtd', 0, 'valor', 0),
      'nivelamento_recebidos', jsonb_build_object('qtd', coalesce(niv.recebidos,0), 'valor', 0),
      'nivelamento_retirados', jsonb_build_object('qtd', coalesce(nout.retirados,0), 'valor', 0)
    )
  from agg g
  left join ac_agg a on a.op_email = g.op_email
  left join pg on pg.op_email = g.op_email
  left join niv on niv.op_email = g.op_email
  left join niv_out nout on nout.op_email = g.op_email;
  get diagnostics v_total = row_count;
  update public.calibragem_snapshot_meta set total_operadores = v_total, duracao_ms = round(extract(milliseconds from (clock_timestamp()-v_ini))) where id = v_snap_id;
  return v_snap_id;
end; $function$;

REVOKE EXECUTE ON FUNCTION public.calibragem_recomputar_snapshot() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.calibragem_recomputar_snapshot() TO authenticated, service_role;
