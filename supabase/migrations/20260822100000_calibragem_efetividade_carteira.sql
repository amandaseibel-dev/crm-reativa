-- ============================================================================
-- EFETIVIDADE — COMPOSIÇÃO DA CARTEIRA + PENETRAÇÃO POR OPERADOR
-- ----------------------------------------------------------------------------
-- calibragem_efetividade_carteira(de, ate, operador?) — por operador:
--   * carteira: casos, ativos (não encerrados), mensalidades (vencidas / a vencer),
--     acordos (em dia / vencidos / quebrados), saldo total e vencido;
--   * faixas de atraso (qtd + saldo) pelo vencimento em aberto mais antigo
--     (casos.dias_atraso está defasado — quase tudo 'A_VENCER');
--   * acionamentos no período: qtd, alunos distintos, penetração (% dos ativos
--     acionados pelo PRÓPRIO operador), nunca acionados, sem acionamento 9+ dias;
--   * ritmo: média de alunos e de ações por dia ÚTIL trabalhado (seg–sex, dias
--     fechados, sem o dia corrente) e dias úteis para percorrer a carteira ativa
--     (ativos / média alunos-dia) e para terminar o que falta no período.
-- Fonte da carteira: mv_saude_carteira (refresh a cada 2h). Só leitura.
-- Permissão: gestão vê todos; operador é forçado ao próprio e-mail.
-- Reversível: drop function.
-- ============================================================================
begin;

create or replace function public.calibragem_efetividade_carteira(
  p_de date, p_ate date, p_operador text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ini timestamptz := p_de::timestamptz;
  v_fim timestamptz := (p_ate + 1)::timestamptz;
  v_op text := p_operador;
  v_email text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_res jsonb;
  v_mv timestamptz;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    v_op := v_email;
  end if;
  select max(atualizado_em) into v_mv from public.saude_carteira_mv_meta;

  with cart as (
    select operador_email op_email, max(operador_nome) op_nome,
      count(*) casos,
      count(*) filter (where not encerrado) ativos,
      count(*) filter (where not encerrado and acordo_situacao='SEM_ACORDO') mensalidades,
      count(*) filter (where not encerrado and acordo_situacao='SEM_ACORDO' and saldo_vencido>0) mens_vencidas,
      count(*) filter (where not encerrado and acordo_situacao='SEM_ACORDO' and saldo_vencido<=0) mens_a_vencer,
      count(*) filter (where not encerrado and acordo_situacao<>'SEM_ACORDO') acordos,
      count(*) filter (where not encerrado and acordo_situacao='EM_DIA') ac_em_dia,
      count(*) filter (where not encerrado and acordo_situacao='VENCIDO') ac_vencidos,
      count(*) filter (where not encerrado and acordo_situacao='QUEBRADO') ac_quebrados,
      round(sum(saldo_total) filter (where not encerrado),2) saldo_total,
      round(sum(saldo_vencido) filter (where not encerrado),2) saldo_vencido,
      count(*) filter (where not encerrado and nunca_acionado) nunca_acionados,
      count(*) filter (where not encerrado and (nunca_acionado or dias_sem_acionamento >= 9)) sem_acionamento_9d
    from public.mv_saude_carteira
    where operador_email is not null and (v_op is null or operador_email = v_op)
    group by operador_email
  ),
  -- faixa de atraso REAL: vencimento em aberto mais antigo (título original
  -- sem acordo ou parcela vencida do acordo). casos.dias_atraso está defasado.
  venc as (
    select c.operador_email, c.saldo_total,
      least(
        (select min(t.vencimento) from public.acordos_titulos t
          where t.aluno_id = c.aluno_id and t.situacao='ABERTO' and t.status='em_aberto'
            and t.acordo_id is null and t.vencimento < current_date),
        c.parcela_vencida_mais_antiga) venc
    from public.mv_saude_carteira c
    where c.operador_email is not null and not c.encerrado and (v_op is null or c.operador_email = v_op)
  ),
  faixas as (
    select operador_email op_email,
      jsonb_agg(jsonb_build_object('faixa', faixa, 'qtd', qtd, 'saldo', saldo) order by ord) faixas
    from (
      select operador_email, faixa, count(*) qtd, round(sum(saldo_total),2) saldo,
        case faixa when 'A_VENCER' then 0 when '1_30' then 1 when '31_60' then 2 when '61_90' then 3
          when '91_180' then 4 when '181_365' then 5 else 6 end ord
      from (
        select operador_email, saldo_total,
          case when venc is null then 'A_VENCER'
               when current_date - venc <= 30 then '1_30' when current_date - venc <= 60 then '31_60'
               when current_date - venc <= 90 then '61_90' when current_date - venc <= 180 then '91_180'
               when current_date - venc <= 365 then '181_365' else 'MAIS_365' end faixa
        from venc
      ) x group by operador_email, faixa
    ) f group by operador_email
  ),
  mov as (
    select m.registrado_por_email op_email, m.aluno_id, m.registrado_em
    from public.aluno_movimentacoes m
    where m.registrado_em >= v_ini and m.registrado_em < v_fim
      and m.registrado_por_email is not null
      and (v_op is null or m.registrado_por_email = v_op)
      and m.tipo in ('CONTATO','ASSUMIU_ATENDIMENTO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','OBSERVACAO','FINALIZACAO_ATENDIMENTO','COMPROVANTE_ENVIADO_BAIXA','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')
  ),
  acion as (
    select op_email, count(*) acionamentos, count(distinct aluno_id) alunos_acionados
    from mov group by op_email
  ),
  -- penetração: alunos da carteira ATIVA do operador acionados por ele no período
  pen as (
    select c.operador_email op_email, count(distinct c.aluno_id) acionados_na_carteira
    from public.mv_saude_carteira c
    join mov m on m.aluno_id = c.aluno_id::text and m.op_email = c.operador_email
    where not c.encerrado
    group by c.operador_email
  ),
  -- ritmo por dia útil fechado (seg–sex, exclui hoje)
  ritmo as (
    select op_email, count(*) dias_uteis,
      round(avg(alunos),1) media_alunos_dia, round(avg(acoes),1) media_acoes_dia
    from (
      select op_email, registrado_em::date dia, count(distinct aluno_id) alunos, count(*) acoes
      from mov
      where registrado_em::date < current_date and extract(isodow from registrado_em) < 6
      group by op_email, registrado_em::date
    ) d group by op_email
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'operador_email', c.op_email, 'operador_nome', c.op_nome,
    'casos', c.casos, 'ativos', c.ativos,
    'mensalidades', c.mensalidades, 'mens_vencidas', c.mens_vencidas, 'mens_a_vencer', c.mens_a_vencer,
    'acordos', c.acordos, 'ac_em_dia', c.ac_em_dia, 'ac_vencidos', c.ac_vencidos, 'ac_quebrados', c.ac_quebrados,
    'saldo_total', coalesce(c.saldo_total,0), 'saldo_vencido', coalesce(c.saldo_vencido,0),
    'faixas', coalesce(f.faixas,'[]'::jsonb),
    'acionamentos', coalesce(a.acionamentos,0),
    'alunos_acionados', coalesce(a.alunos_acionados,0),
    'acionados_na_carteira', coalesce(p.acionados_na_carteira,0),
    'penetracao_pct', least(100, round(100.0*coalesce(p.acionados_na_carteira,0)/nullif(c.ativos,0),1)),
    'nunca_acionados', c.nunca_acionados,
    'sem_acionamento_9d', c.sem_acionamento_9d,
    'dias_uteis', coalesce(r.dias_uteis,0),
    'media_alunos_dia', coalesce(r.media_alunos_dia,0),
    'media_acoes_dia', coalesce(r.media_acoes_dia,0),
    'dias_percorrer_carteira', case when coalesce(r.media_alunos_dia,0) > 0 then ceil(c.ativos / r.media_alunos_dia) end,
    'dias_terminar_restante', case when coalesce(r.media_alunos_dia,0) > 0
       then ceil(greatest(0, c.ativos - coalesce(p.acionados_na_carteira,0)) / r.media_alunos_dia) end
  ) order by c.op_nome), '[]'::jsonb)
  into v_res
  from cart c
  left join faixas f on f.op_email = c.op_email
  left join acion a on a.op_email = c.op_email
  left join pen p on p.op_email = c.op_email
  left join ritmo r on r.op_email = c.op_email;

  return jsonb_build_object('de', p_de, 'ate', p_ate, 'carteira_atualizada_em', v_mv, 'operadores', v_res);
end; $$;
revoke all on function public.calibragem_efetividade_carteira(date,date,text) from public;
grant execute on function public.calibragem_efetividade_carteira(date,date,text) to authenticated;

commit;
