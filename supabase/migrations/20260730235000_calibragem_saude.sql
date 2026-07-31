-- ============================================================================
-- CALIBRAGEM — ÍNDICE DE SAÚDE DA CARTEIRA (item 15)
-- ----------------------------------------------------------------------------
-- calibragem_saude(operador?) — nota 0-100 por operador + DETALHAMENTO dos
-- fatores que reduzem a nota. Considera: carteira trabalhada, críticos não
-- trabalhados, retornos atrasados, acordos vencidos, tempo médio sem
-- acionamento, pagamentos aguardando confirmação.
-- Operador vê o próprio; gestão vê todos. Reversível.
-- ============================================================================

begin;

create or replace function public.calibragem_saude(p_operador text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_op text := p_operador; v_email text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_ini timestamptz := (current_date - 30)::timestamptz; v_res jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then v_op := v_email; end if;

  with cart as (
    select c.operador_email op_email, max(c.operador_nome) op_nome, count(*) cpfs,
      count(*) filter (where upper(coalesce(c.criticidade,'')) in ('CRITICO','URGENTE')) criticos,
      count(*) filter (where coalesce(c.data_retorno_nova, c.data_retorno) < current_date) retornos_atrasados,
      avg(current_date - c.data_ultimo_acionamento) filter (where c.data_ultimo_acionamento is not null) tempo_medio_sem_ac
    from public.casos c where c.operador_email is not null and (v_op is null or c.operador_email = v_op)
    group by c.operador_email
  ),
  trab as (
    select c.operador_email op_email, count(distinct m.aluno_id) trabalhados,
      count(distinct m.aluno_id) filter (where upper(coalesce(c.criticidade,'')) in ('CRITICO','URGENTE')) criticos_trab
    from public.casos c join public.aluno_movimentacoes m
      on m.aluno_id = c.aluno_id::text and m.registrado_por_email = c.operador_email and m.registrado_em >= v_ini
    where c.operador_email is not null group by c.operador_email
  ),
  acv as (
    select a.operador_responsavel_email op_email, count(*) acordos_vencidos
    from public.acordos a
    where lower(coalesce(a.status,'')) not in ('cancelado','cancelada','quitado')
      and exists (select 1 from public.parcelas p where p.acordo_id=a.id
                   and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
                   and p.vencimento < current_date)
    group by a.operador_responsavel_email
  ),
  aguard as (
    select operador_email op_email, count(*) aguardando
    from public.solicitacoes_confirmacao_pagamento where upper(coalesce(status,''))='AGUARDANDO_CONFIRMACAO'
    group by operador_email
  ),
  calc as (
    select c.op_email, c.op_nome, c.cpfs,
      least(1.0, coalesce(t.trabalhados,0)::numeric/nullif(c.cpfs,0)) cobertura,
      greatest(0, c.criticos - coalesce(t.criticos_trab,0)) crit_nao_trab,
      c.retornos_atrasados, coalesce(av.acordos_vencidos,0) acordos_vencidos,
      coalesce(round(c.tempo_medio_sem_ac),0) tempo_medio, coalesce(g.aguardando,0) aguardando
    from cart c left join trab t on t.op_email=c.op_email
    left join acv av on av.op_email=c.op_email left join aguard g on g.op_email=c.op_email
  ),
  pen as (
    select *,
      round((1-cobertura)*30,1) p_cob,
      round(least(1.0, crit_nao_trab::numeric/nullif(cpfs,0))*20,1) p_crit,
      round(least(1.0, retornos_atrasados::numeric/nullif(cpfs,0))*15,1) p_ret,
      round(least(1.0, tempo_medio::numeric/30)*15,1) p_tempo,
      round(least(1.0, acordos_vencidos::numeric/nullif(cpfs,0)*3)*10,1) p_acv,
      round(least(1.0, aguardando::numeric/nullif(cpfs,0)*2)*10,1) p_agu
    from calc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'operador_email', op_email, 'operador_nome', op_nome, 'carteira_cpfs', cpfs,
    'nota', greatest(0, round(100 - p_cob - p_crit - p_ret - p_tempo - p_acv - p_agu, 1)),
    'cobertura_pct', round(cobertura*100,1),
    'fatores', jsonb_build_array(
      jsonb_build_object('fator','Carteira trabalhada','penalidade',p_cob,'detalhe', round(cobertura*100,1)::text||'% trabalhada'),
      jsonb_build_object('fator','Críticos não trabalhados','penalidade',p_crit,'detalhe', crit_nao_trab::text||' casos'),
      jsonb_build_object('fator','Retornos atrasados','penalidade',p_ret,'detalhe', retornos_atrasados::text||' casos'),
      jsonb_build_object('fator','Tempo sem acionamento','penalidade',p_tempo,'detalhe', tempo_medio::text||' dias (média)'),
      jsonb_build_object('fator','Acordos vencidos','penalidade',p_acv,'detalhe', acordos_vencidos::text||' acordos'),
      jsonb_build_object('fator','Pagamentos aguardando','penalidade',p_agu,'detalhe', aguardando::text||' pendentes')
    )
  ) order by op_nome), '[]'::jsonb) into v_res from pen;

  return jsonb_build_object('operadores', v_res);
end; $$;
revoke all on function public.calibragem_saude(text) from public;
grant execute on function public.calibragem_saude(text) to authenticated;

commit;
