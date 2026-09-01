-- ============================================================================
-- EFETIVIDADE/SAUDE: O NOME DA LINHA VEM DO CADASTRO, NAO DO max()
-- ----------------------------------------------------------------------------
-- Complementa 20260901120000. As tres RPCs dos paineis por operador escolhiam
-- o nome com max(operador_nome) sobre os casos do e-mail -- o maior em ordem
-- alfabetica. Agora leem `nome_do_operador(email)` (tabela `usuarios`) e so
-- caem no max() se o e-mail nao estiver cadastrado.
-- Nenhum numero muda: todos ja eram agrupados por e-mail.
-- ============================================================================

begin;

create or replace function public.calibragem_efetividade(p_de date, p_ate date, p_operador text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_ini timestamptz := p_de::timestamptz; v_fim timestamptz := (p_ate + 1)::timestamptz;
  v_op text := p_operador; v_email text := lower(coalesce(auth.jwt() ->> 'email','')); v_res jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then v_op := v_email; end if;
  with carteira as (
    select operador_email op_email,
      coalesce(public.nome_do_operador(operador_email), max(operador_nome)) op_nome,
      count(*) cpfs
    from public.casos where operador_email is not null and (v_op is null or operador_email = v_op) group by operador_email
  ),
  mov as (
    select registrado_por_email op_email,
      count(*) filter (where tipo in ('CONTATO','ASSUMIU_ATENDIMENTO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','OBSERVACAO','FINALIZACAO_ATENDIMENTO','COMPROVANTE_ENVIADO_BAIXA','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')) acionamentos,
      count(distinct aluno_id) filter (where tipo in ('CONTATO','ASSUMIU_ATENDIMENTO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','OBSERVACAO','FINALIZACAO_ATENDIMENTO','COMPROVANTE_ENVIADO_BAIXA','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')) trabalhados_total,
      count(*) filter (where tipo='CONTATO') contatos, count(*) filter (where tipo='LINK_ENVIADO_AO_ALUNO') links_env, count(*) filter (where tipo='TERMO_ENVIADO_ADM') termos_env
    from public.aluno_movimentacoes where registrado_em >= v_ini and registrado_em < v_fim and registrado_por_email is not null group by registrado_por_email
  ),
  trab_cart as (
    select c.operador_email op_email, count(distinct m.aluno_id) trabalhados
    from public.casos c join public.aluno_movimentacoes m on m.aluno_id=c.aluno_id::text and m.registrado_por_email=c.operador_email
      and m.registrado_em >= v_ini and m.registrado_em < v_fim
      and m.tipo in ('CONTATO','ASSUMIU_ATENDIMENTO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','OBSERVACAO','FINALIZACAO_ATENDIMENTO','COMPROVANTE_ENVIADO_BAIXA','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')
    where c.operador_email is not null group by c.operador_email
  ),
  pg as (
    select a.operador_responsavel_email op_email, count(*) pagamentos, coalesce(sum(p.valor),0) recuperado, count(distinct a.aluno_id) cpfs_pagos
    from public.parcelas p join public.acordos a on a.id=p.acordo_id
    where upper(coalesce(p.status,'')) in ('PAGO','PAGA') and coalesce(p.pago_em,p.atualizado_em) >= v_ini and coalesce(p.pago_em,p.atualizado_em) < v_fim
    group by a.operador_responsavel_email
  ),
  ac as (select operador_responsavel_email op_email, count(*) acordos, count(distinct aluno_id) cpfs_acordo from public.acordos where criado_em >= v_ini and criado_em < v_fim and lower(coalesce(status,'')) not in ('cancelado','cancelada') group by operador_responsavel_email),
  tass as (select operador_email op_email, count(*) termos_assinados from public.termos_acordo where validado_em >= v_ini and validado_em < v_fim and lower(coalesce(status,'')) in ('validado','aprovado','assinado','liberado') group by operador_email),
  aguard as (select operador_email op_email, count(*) aguardando from public.solicitacoes_confirmacao_pagamento where upper(coalesce(status,''))='AGUARDANDO_CONFIRMACAO' group by operador_email)
  select coalesce(jsonb_agg(jsonb_build_object(
    'operador_email', c.op_email, 'operador_nome', c.op_nome, 'carteira_cpfs', c.cpfs,
    'trabalhados', coalesce(tc.trabalhados,0), 'trabalhados_total', coalesce(m.trabalhados_total,0),
    'cobertura_pct', least(100, round(100.0*coalesce(tc.trabalhados,0)/nullif(c.cpfs,0),1)),
    'acionamentos', coalesce(m.acionamentos,0), 'contatos', coalesce(m.contatos,0), 'acordos', coalesce(a.acordos,0),
    'pagamentos_confirmados', coalesce(pg.pagamentos,0), 'recuperado', round(coalesce(pg.recuperado,0),2),
    'conv_acordo_pct', round(100.0*coalesce(a.cpfs_acordo,0)/nullif(tc.trabalhados,0),1),
    'conv_pagamento_pct', round(100.0*coalesce(pg.cpfs_pagos,0)/nullif(tc.trabalhados,0),1),
    'links_enviados', coalesce(m.links_env,0), 'termos_enviados', coalesce(m.termos_env,0),
    'termos_assinados', coalesce(t.termos_assinados,0), 'aguardando_confirmacao', coalesce(g.aguardando,0)
  ) order by c.op_nome), '[]'::jsonb) into v_res
  from carteira c left join mov m on m.op_email=c.op_email left join trab_cart tc on tc.op_email=c.op_email
  left join ac a on a.op_email=c.op_email left join pg on pg.op_email=c.op_email left join tass t on t.op_email=c.op_email left join aguard g on g.op_email=c.op_email;
  return jsonb_build_object('de', p_de, 'ate', p_ate, 'operadores', v_res);
end; $function$;

create or replace function public.calibragem_efetividade_carteira(p_de date, p_ate date, p_operador text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
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
    select operador_email op_email,
      coalesce(public.nome_do_operador(operador_email), max(operador_nome)) op_nome,
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
  faixas as (
    select operador_email op_email,
      jsonb_agg(jsonb_build_object('faixa', faixa, 'qtd', qtd, 'saldo', saldo) order by ord) faixas
    from (
      select operador_email, faixa_atraso faixa, count(*) qtd, round(sum(saldo_total),2) saldo,
        case faixa_atraso when 'A_VENCER' then 0 when '1_30' then 1 when '31_60' then 2 when '61_90' then 3
          when '91_180' then 4 when '181_365' then 5 else 6 end ord
      from public.mv_saude_carteira
      where operador_email is not null and not encerrado and (v_op is null or operador_email = v_op)
      group by operador_email, faixa_atraso
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
  pen as (
    select c.operador_email op_email, count(distinct c.aluno_id) acionados_na_carteira
    from public.mv_saude_carteira c
    join mov m on m.aluno_id = c.aluno_id::text and m.op_email = c.operador_email
    where not c.encerrado
    group by c.operador_email
  ),
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
end; $function$;

create or replace function public.calibragem_saude(p_operador text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_op text := p_operador; v_email text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_ini timestamptz := (current_date - 30)::timestamptz; v_res jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then v_op := v_email; end if;
  with cart as (
    select c.operador_email op_email,
      coalesce(public.nome_do_operador(c.operador_email), max(c.operador_nome)) op_nome,
      count(*) cpfs,
      count(*) filter (where upper(coalesce(c.criticidade,'')) in ('CRITICO','URGENTE')) criticos,
      count(*) filter (where coalesce(c.data_retorno_nova, c.data_retorno) < current_date) retornos_atrasados,
      avg(current_date - c.data_ultimo_acionamento) filter (where c.data_ultimo_acionamento is not null) tempo_medio_sem_ac
    from public.casos c where c.operador_email is not null and (v_op is null or c.operador_email = v_op) group by c.operador_email
  ),
  trab as (
    select c.operador_email op_email, count(distinct m.aluno_id) trabalhados,
      count(distinct m.aluno_id) filter (where upper(coalesce(c.criticidade,'')) in ('CRITICO','URGENTE')) criticos_trab
    from public.casos c join public.aluno_movimentacoes m on m.aluno_id=c.aluno_id::text and m.registrado_por_email=c.operador_email and m.registrado_em >= v_ini
    where c.operador_email is not null group by c.operador_email
  ),
  acv as (
    select a.operador_responsavel_email op_email, count(*) acordos_vencidos from public.acordos a
    where lower(coalesce(a.status,'')) not in ('cancelado','cancelada','quitado')
      and exists (select 1 from public.parcelas p where p.acordo_id=a.id and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') and p.vencimento < current_date)
    group by a.operador_responsavel_email
  ),
  aguard as (select operador_email op_email, count(*) aguardando from public.solicitacoes_confirmacao_pagamento where upper(coalesce(status,''))='AGUARDANDO_CONFIRMACAO' group by operador_email),
  calc as (
    select c.op_email, c.op_nome, c.cpfs,
      least(1.0, coalesce(t.trabalhados,0)::numeric/nullif(c.cpfs,0)) cobertura,
      greatest(0, c.criticos - coalesce(t.criticos_trab,0)) crit_nao_trab,
      c.retornos_atrasados, coalesce(av.acordos_vencidos,0) acordos_vencidos,
      coalesce(round(c.tempo_medio_sem_ac),0) tempo_medio, coalesce(g.aguardando,0) aguardando
    from cart c left join trab t on t.op_email=c.op_email left join acv av on av.op_email=c.op_email left join aguard g on g.op_email=c.op_email
  ),
  pen as (
    select *, round((1-cobertura)*30,1) p_cob, round(least(1.0, crit_nao_trab::numeric/nullif(cpfs,0))*20,1) p_crit,
      round(least(1.0, retornos_atrasados::numeric/nullif(cpfs,0))*15,1) p_ret, round(least(1.0, tempo_medio::numeric/30)*15,1) p_tempo,
      round(least(1.0, acordos_vencidos::numeric/nullif(cpfs,0)*3)*10,1) p_acv, round(least(1.0, aguardando::numeric/nullif(cpfs,0)*2)*10,1) p_agu
    from calc
  )
  select coalesce(jsonb_agg(jsonb_build_object('operador_email', op_email, 'operador_nome', op_nome, 'carteira_cpfs', cpfs,
    'nota', greatest(0, round(100 - p_cob - p_crit - p_ret - p_tempo - p_acv - p_agu, 1)), 'cobertura_pct', round(cobertura*100,1),
    'fatores', jsonb_build_array(
      jsonb_build_object('fator','Carteira trabalhada','penalidade',p_cob,'detalhe', round(cobertura*100,1)::text||'% trabalhada'),
      jsonb_build_object('fator','Críticos não trabalhados','penalidade',p_crit,'detalhe', crit_nao_trab::text||' casos'),
      jsonb_build_object('fator','Retornos atrasados','penalidade',p_ret,'detalhe', retornos_atrasados::text||' casos'),
      jsonb_build_object('fator','Tempo sem acionamento','penalidade',p_tempo,'detalhe', tempo_medio::text||' dias (média)'),
      jsonb_build_object('fator','Acordos vencidos','penalidade',p_acv,'detalhe', acordos_vencidos::text||' acordos'),
      jsonb_build_object('fator','Pagamentos aguardando','penalidade',p_agu,'detalhe', aguardando::text||' pendentes')
    )) order by op_nome), '[]'::jsonb) into v_res from pen;
  return jsonb_build_object('operadores', v_res);
end; $function$;

commit;
