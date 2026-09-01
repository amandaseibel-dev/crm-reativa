-- ============================================================================
-- ACIONAMENTO E UNICO: UM ALUNO POR DIA, NAO UM CLIQUE
-- ----------------------------------------------------------------------------
-- Regra da gestao (01/09/2026): acionamento e o aluno trabalhado no dia. Se o
-- operador tabula e, no mesmo atendimento, dispara o e-mail pela ficha, isso e
-- UM acionamento -- nao dois.
--
-- Como estava: os painteis somavam MOVIMENTACOES. Em 01/09 o Mauricio aparecia
-- com 437 "acionamentos" -- 236 tabulacoes + 200 e-mails + 1 retorno ADM --
-- para 219 alunos distintos, e os 193 alunos que receberam e-mail eram
-- exatamente os mesmos que ele tabulou (sobreposicao de 100%). O time inteiro
-- estava em ~2,0 acoes por aluno no dia.
--
-- Passa a contar `count(distinct (dia, aluno_id))`, com o dia em horario de
-- Sao Paulo -- a mesma regra que a Minha Carteira ja usava no "meu desempenho".
-- Vale para: Efetividade (execucao e carteira/penetracao), o resumo do proprio
-- operador e o ranking da TV.
--
-- NAO muda o que E acionamento (public.eh_tipo_acionamento segue igual), nem a
-- data da ficha, nem a fila. So a contagem.
--
-- Reversivel: rollback reaplica as versoes com count(*).
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
      count(distinct ((registrado_em at time zone 'America/Sao_Paulo')::date, aluno_id)) filter (where tipo in ('CONTATO','ASSUMIU_ATENDIMENTO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','OBSERVACAO','FINALIZACAO_ATENDIMENTO','COMPROVANTE_ENVIADO_BAIXA','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')) acionamentos,
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
    select op_email, count(distinct ((registrado_em at time zone 'America/Sao_Paulo')::date, aluno_id)) acionamentos, count(distinct aluno_id) alunos_acionados
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
      select op_email, registrado_em::date dia, count(distinct aluno_id) alunos, count(distinct aluno_id) acoes
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

create or replace function public.meus_acionamentos_resumo()
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_hoje_qtd int; v_semana int; v_quinze int; v_mes int; v_recorde_qtd int; v_recorde_data date;
  v_min_hoje numeric; v_media_min_dia numeric;
  v_tempo_medio numeric; v_projecao int;
begin
  if v_email = '' then return jsonb_build_object('ok', false); end if;

  -- ACIONAMENTO E UNICO: um aluno por dia. Tabular e mandar o e-mail no mesmo
  -- atendimento e um acionamento, nao dois.
  select count(distinct m.aluno_id) into v_hoje_qtd from public.aluno_movimentacoes m
   where lower(m.registrado_por_email)=v_email and public.eh_tipo_acionamento(m.tipo)
     and (m.registrado_em at time zone 'America/Sao_Paulo')::date = v_hoje;

  select count(distinct ((m.registrado_em at time zone 'America/Sao_Paulo')::date, m.aluno_id)) into v_semana
   from public.aluno_movimentacoes m
   where lower(m.registrado_por_email)=v_email and public.eh_tipo_acionamento(m.tipo)
     and (m.registrado_em at time zone 'America/Sao_Paulo')::date > v_hoje - 7;

  select count(distinct ((m.registrado_em at time zone 'America/Sao_Paulo')::date, m.aluno_id)) into v_quinze
   from public.aluno_movimentacoes m
   where lower(m.registrado_por_email)=v_email and public.eh_tipo_acionamento(m.tipo)
     and (m.registrado_em at time zone 'America/Sao_Paulo')::date > v_hoje - 15;

  select count(distinct ((m.registrado_em at time zone 'America/Sao_Paulo')::date, m.aluno_id)) into v_mes
   from public.aluno_movimentacoes m
   where lower(m.registrado_por_email)=v_email and public.eh_tipo_acionamento(m.tipo)
     and to_char(m.registrado_em at time zone 'America/Sao_Paulo','YYYY-MM') = to_char(v_hoje,'YYYY-MM');

  select dia, qtd into v_recorde_data, v_recorde_qtd
  from (
    select (m.registrado_em at time zone 'America/Sao_Paulo')::date as dia, count(distinct m.aluno_id) as qtd
    from public.aluno_movimentacoes m
    where lower(m.registrado_por_email)=v_email and public.eh_tipo_acionamento(m.tipo)
    group by 1 order by qtd desc, dia desc limit 1
  ) t;

  select coalesce(extract(epoch from (
      case when (max(criado_em) filter (where tipo='LOGOUT')) is null
                or (max(criado_em) filter (where tipo='LOGIN')) > (max(criado_em) filter (where tipo='LOGOUT'))
           then now()
           else max(criado_em) filter (where tipo='LOGOUT') end
      - min(criado_em)) / 60.0), 0)
    into v_min_hoje
  from public.ponto_operadores
  where lower(email)=v_email and tipo in ('LOGIN','LOGOUT')
    and (criado_em at time zone 'America/Sao_Paulo')::date = v_hoje;

  select coalesce(avg(span_min),0) into v_media_min_dia from (
    select (criado_em at time zone 'America/Sao_Paulo')::date as dia,
           extract(epoch from (max(criado_em) - min(criado_em)))/60.0 as span_min
    from public.ponto_operadores
    where lower(email)=v_email and tipo in ('LOGIN','LOGOUT')
      and (criado_em at time zone 'America/Sao_Paulo')::date > v_hoje - 30
      and (criado_em at time zone 'America/Sao_Paulo')::date < v_hoje
    group by 1
    having count(*) >= 2 and extract(epoch from (max(criado_em) - min(criado_em)))/60.0 >= 30
  ) d;

  v_tempo_medio := case when v_hoje_qtd > 0 and v_min_hoje > 0 then round(v_min_hoje / v_hoje_qtd, 1) else null end;
  v_projecao := case when v_hoje_qtd > 0 and v_min_hoje > 5 and v_media_min_dia > 0
                     then round(v_hoje_qtd::numeric / v_min_hoje * v_media_min_dia) else null end;

  return jsonb_build_object('ok', true,
    'hoje', coalesce(v_hoje_qtd,0), 'semana', coalesce(v_semana,0),
    'quinze', coalesce(v_quinze,0), 'mes', coalesce(v_mes,0),
    'recorde_qtd', coalesce(v_recorde_qtd,0), 'recorde_data', v_recorde_data,
    'min_logado_hoje', round(coalesce(v_min_hoje,0)),
    'tempo_medio_min', v_tempo_medio,
    'media_min_dia', round(coalesce(v_media_min_dia,0)),
    'projecao_dia', v_projecao);
end;
$function$;

create or replace function public.acionamentos_ranking()
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_mes text := to_char(v_hoje,'YYYY-MM');
  v_ops text[] := array['cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
                        'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
                        'cobranca12@aelbra.com.br','cobranca13@aelbra.com.br'];
  v_dia jsonb; v_mes_j jsonb; v_hon_dia jsonb;
begin
  -- ACIONAMENTO E UNICO: no dia, conta aluno distinto; no mes, aluno por dia.
  select jsonb_agg(t) into v_dia from (
    select coalesce(public.nome_do_operador(max(m.registrado_por_email)), max(u.apelido), max(u.nome), max(m.registrado_por_email)) as nome,
           count(distinct m.aluno_id) as qtd
    from public.aluno_movimentacoes m
    left join public.usuarios u on lower(u.email) = lower(m.registrado_por_email)
    where public.eh_tipo_acionamento(m.tipo)
      and lower(m.registrado_por_email) = any(v_ops)
      and (m.registrado_em at time zone 'America/Sao_Paulo')::date = v_hoje
    group by lower(m.registrado_por_email)
    order by qtd desc limit 3
  ) t;

  select jsonb_agg(t) into v_mes_j from (
    select coalesce(public.nome_do_operador(max(m.registrado_por_email)), max(u.apelido), max(u.nome), max(m.registrado_por_email)) as nome,
           count(distinct ((m.registrado_em at time zone 'America/Sao_Paulo')::date, m.aluno_id)) as qtd
    from public.aluno_movimentacoes m
    left join public.usuarios u on lower(u.email) = lower(m.registrado_por_email)
    where public.eh_tipo_acionamento(m.tipo)
      and lower(m.registrado_por_email) = any(v_ops)
      and to_char(m.registrado_em at time zone 'America/Sao_Paulo','YYYY-MM') = v_mes
    group by lower(m.registrado_por_email)
    order by qtd desc limit 3
  ) t;

  -- Top 3 por honorario do dia (so nomes na TV)
  select jsonb_agg(t) into v_hon_dia from (
    select coalesce(public.nome_do_operador(max(p.operador_email)), max(u.apelido), max(u.nome), max(p.operador_nome), max(p.operador_email)) as nome,
           sum(p.valor_honorario) as valor
    from public.pagamentos p
    left join public.usuarios u on lower(u.email) = lower(p.operador_email)
    where lower(p.operador_email) = any(v_ops)
      and p.data_pagamento = v_hoje
    group by lower(p.operador_email)
    having sum(p.valor_honorario) > 0
    order by valor desc limit 3
  ) t;

  return jsonb_build_object(
    'top_dia', coalesce(v_dia,'[]'::jsonb),
    'top_mes', coalesce(v_mes_j,'[]'::jsonb),
    'top_hon_dia', coalesce(v_hon_dia,'[]'::jsonb)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- A TV nao usa acionamentos_ranking: tv_snapshot_calcular tem a consulta dela
-- propria (foi por isso que o painel continuou mostrando 437 depois da troca).
-- O snapshot e uma funcao longa e gerada; aqui trocamos SO a contagem, com
-- guarda: se o texto esperado nao estiver la, a migration falha em vez de
-- passar batido.
--
-- A mesma expressao serve para o dia e para o mes: no bloco do dia a data e
-- constante, entao contar (dia, aluno) da o mesmo que contar aluno.
--
-- ATENCAO: a TV so mostra o numero novo depois que alguem roda
-- tv_snapshot_atualizar() -- botao "Salvar e atualizar TV", permitido so para
-- Amanda e Fernanda. O snapshot guardado nao se refaz sozinho.
-- ---------------------------------------------------------------------------
do $do$
declare d text; n int;
begin
  select pg_get_functiondef('public.tv_snapshot_calcular'::regproc) into d;
  n := (length(d) - length(replace(d, 'count(*) as qtd', ''))) / length('count(*) as qtd');
  if n <> 2 then raise exception 'tv_snapshot_calcular: esperava 2 ocorrencias de count(*) as qtd, achei %', n; end if;
  d := replace(d, 'count(*) as qtd',
       'count(distinct ((m.registrado_em at time zone ''America/Sao_Paulo'')::date, m.aluno_id)) as qtd');
  execute d;
end $do$;

commit;
