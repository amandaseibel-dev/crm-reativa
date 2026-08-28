-- ============================================================================
-- Proteger o prazo de fidelizacao (10 dias) em TODOS os caminhos que tiram o
-- caso do operador, e alinhar o card "Sem acionamento (risco de perder)".
--
-- REGRA (Amanda, 24/08/2026): quem esta DENTRO do prazo de 10 dias contados do
-- ultimo acionamento NAO pode ser perdido pelo operador -- por nenhum caminho.
--
-- Situacao antes desta migration:
--   * cron da fidelizacao (casos_elegiveis_liberacao_fidelizacao) ... OK, ja
--     so soltava com data_ultimo_acionamento + 10 < hoje;
--   * nivelamento 500 (calibragem_simular_nivelamento_impl) ......... OK, so
--     pegava "parado" (>11 dias), mas o parametro dias_sem_acionamento podia
--     ser baixado pela gestao para menos que isso;
--   * nivelamento por saldo/quantidade (calibragem_simular) ......... FURO: o
--     pool nao olhava data_ultimo_acionamento -- caso acionado ontem podia ser
--     movido;
--   * execucoes (calibragem_executar_simulacao / _nivelamento /
--     _nivelamento_lote_impl) ...................................... FURO: so
--     revalidavam caso_protegido_redistribuicao, nunca a janela dos 10 dias.
--
-- O que muda:
--   1. helper caso_dentro_prazo_fidelizacao(date);
--   2. calibragem_simular: pool exclui quem esta dentro do prazo;
--   3. calibragem_simular_nivelamento_impl: piso de 10 dias no parametro;
--   4. as tres execucoes revalidam a janela ANTES de tirar o caso (a entrega
--      de caso do pool, com de_email nulo, segue liberada -- ninguem perde
--      nada nesse sentido);
--   5. RPC casos_risco_perder: fonte unica do card "risco de perder" -- so
--      quem o cron da fidelizacao pode de fato soltar.
--
-- APLICADA EM PROD (ahattpqrjmhkzsmnbdzs) em 2026-08-24, em tres partes pelo
-- MCP: proteger_prazo_fidelizacao_nivelamento_parte1/parte2/parte3. O conteudo
-- e exatamente o deste arquivo; o corte em tres foi so de transporte.
-- Rollback: reaplicar as versoes anteriores das 5 funcoes (a unica diferenca
-- e a chamada a caso_dentro_prazo_fidelizacao e o piso de v_dias).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Helper: o caso esta dentro do prazo de exclusividade do operador?
--    Nunca acionado (NULL) NAO esta protegido: a fidelizacao so comeca no
--    primeiro acionamento valido (ver assumir_caso_livre).
-- ---------------------------------------------------------------------------
create or replace function public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select p_data_ultimo_acionamento is not null
     and p_data_ultimo_acionamento + 10 >= current_date;
$$;

comment on function public.caso_dentro_prazo_fidelizacao(date) is
  'Caso dentro dos 10 dias de exclusividade contados do ultimo acionamento. Espelha a regra de casos_elegiveis_liberacao_fidelizacao: dentro do prazo, o caso nao pode ser retirado do operador.';

-- ---------------------------------------------------------------------------
-- 2. Nivelamento por saldo/quantidade: o pool passa a respeitar a janela.
--    (unica mudanca em relacao a versao anterior: o filtro novo no _pool)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calibragem_simular(p_criterio jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tipo text := upper(coalesce(p_criterio->>'tipo','EQUIPARAR_SALDO'));
  v_ops text[]; v_origem text := p_criterio->>'origem';
  v_limite int := coalesce((select (valor)::text::int from public.calibragem_parametros where chave='limite_carteira'), 500);
  v_metric text; v_sim_id uuid; v_target numeric;
  v_resultado jsonb; v_indice_antes numeric; v_indice_depois numeric;
  v_iter int := 0; v_max int := 6000;
  v_rich text; v_poor text; v_gap numeric; v_delta numeric;
  v_cH record; v_cL record;
  r record; rec_op text; v_best_deficit numeric; v_best text;
begin
  if not (public.calibragem_e_gestao() or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'))) then raise exception 'Sem permissão para simular a Calibragem.'; end if;
  if p_criterio ? 'operadores' then v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores')); end if;
  v_metric := case when v_tipo='EQUIPARAR_QTD' then 'QTD' else 'SALDO' end;

  create temp table _op on commit drop as
    select c.operador_email op_email, max(c.operador_nome) op_nome, count(*)::numeric qtd, round(sum(coalesce(s.saldo_total,0)),2) saldo
    from public.casos c left join public.calibragem_saldo_aluno s on s.aluno_id=c.aluno_id
    where c.operador_email is not null and (v_ops is null or c.operador_email = any(v_ops))
    group by c.operador_email;
  create temp table _op_antes on commit drop as select * from _op;

  create temp table _pool on commit drop as
    select c.id caso_id, c.operador_email de_email, c.operador_nome de_nome,
           coalesce(c.cpf_limpo,c.cpf) cpf, coalesce(c.nome,c.nome_aluno) nome,
           round(coalesce(s.saldo_total,0),2) valor, coalesce(c.dias_atraso,0) dias_atraso,
           coalesce(c.criticidade,'-') criticidade, (c.status_acionamento is null) sem_acion, c.data_ultimo_acionamento,
           false as usado, false as movido, null::text as para_email, null::text as para_nome, null::text as motivo
    from public.casos c left join public.calibragem_saldo_aluno s on s.aluno_id=c.aluno_id
    where c.operador_email is not null and (v_ops is null or c.operador_email = any(v_ops))
      and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
      -- Dentro dos 10 dias de fidelizacao o caso e do operador: fora do pool.
      and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
      and ( v_tipo <> 'RETIRAR_SEM_ACIONAMENTO' or (c.status_acionamento is null and (v_origem is null or c.operador_email = v_origem)) );

  if v_metric='QTD' then select avg(qtd) into v_target from _op; else select avg(saldo) into v_target from _op; end if;
  v_indice_antes := public.calibragem_indice_equilibrio(array(select case when v_metric='QTD' then qtd else saldo end from _op));

  if v_metric='SALDO' then
    loop
      v_iter := v_iter + 1; exit when v_iter > v_max;
      select op_email into v_rich from _op order by saldo desc limit 1;
      select op_email into v_poor from _op order by saldo asc  limit 1;
      exit when v_rich = v_poor;
      select (select saldo from _op where op_email=v_rich) - (select saldo from _op where op_email=v_poor) into v_gap;
      exit when v_gap <= 0;
      select * into v_cH from _pool where de_email=v_rich and not usado order by valor desc limit 1;
      select * into v_cL from _pool where de_email=v_poor and not usado order by valor asc  limit 1;
      exit when v_cH is null or v_cL is null;
      v_delta := v_cH.valor - v_cL.valor;
      exit when v_delta <= 0;
      exit when v_delta >= v_gap;
      update _pool set usado=true, movido=true, para_email=v_poor, para_nome=(select op_nome from _op where op_email=v_poor),
             motivo='Troca por nivelamento de saldo (caso de maior valor)' where caso_id=v_cH.caso_id;
      update _pool set usado=true, movido=true, para_email=v_rich, para_nome=(select op_nome from _op where op_email=v_rich),
             motivo='Troca por nivelamento de saldo (caso de menor valor)' where caso_id=v_cL.caso_id;
      update _op set saldo = saldo - v_delta where op_email=v_rich;
      update _op set saldo = saldo + v_delta where op_email=v_poor;
    end loop;
  else
    for r in
      select p.* from _pool p join _op o on o.op_email = p.de_email
      where o.qtd > v_target order by o.qtd desc, p.de_email
    loop
      if (select qtd from _op where op_email=r.de_email) <= v_target then continue; end if;
      v_best := null; v_best_deficit := 0;
      for rec_op in select op_email from _op where op_email <> r.de_email loop
        declare v_q numeric; v_def numeric;
        begin
          select qtd into v_q from _op where op_email=rec_op;
          v_def := v_target - v_q;
          if v_def > v_best_deficit and v_q < v_limite then v_best_deficit := v_def; v_best := rec_op; end if;
        end;
      end loop;
      if v_best is null then continue; end if;
      update _pool set movido=true, para_email=v_best, para_nome=(select op_nome from _op where op_email=v_best),
             motivo='Nivelamento de quantidade de CPFs' where caso_id=r.caso_id;
      update _op set qtd=qtd-1 where op_email=r.de_email;
      update _op set qtd=qtd+1 where op_email=v_best;
    end loop;
  end if;

  v_indice_depois := public.calibragem_indice_equilibrio(array(select case when v_metric='QTD' then qtd else saldo end from _op));

  select jsonb_build_object(
    'criterio', p_criterio, 'metrica', v_metric, 'alvo', round(v_target,2),
    'indice_antes', v_indice_antes, 'indice_depois', v_indice_depois,
    'antes', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op_antes),
    'depois',(select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object('caso_id',caso_id,'cpf',public.mask_cpf(cpf),'nome',nome,'valor',valor,'dias_atraso',dias_atraso,'criticidade',criticidade,'de_email',de_email,'de_nome',de_nome,'para_email',para_email,'para_nome',para_nome,'motivo',motivo) order by de_email, valor desc),'[]') from _pool where movido),
    'total_movimentacoes', (select count(*) from _pool where movido)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt() ->> 'email','server'), coalesce(auth.jwt() ->> 'email','server'), p_criterio, v_resultado, 'RASCUNHO')
  returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $function$;

-- ---------------------------------------------------------------------------
-- 3. Execucao do nivelamento por saldo/quantidade: revalida a janela.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calibragem_executar_simulacao(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_executados int := 0; v_pulados int := 0; r record; v_aluno uuid;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar a Calibragem.'; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status <> 'APROVADA' then raise exception 'Simulação precisa estar APROVADA (atual: %).', v_sim.status; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_simulacao'));
  create temp table _exec on commit drop as
  select (m->>'caso_id')::uuid caso_id, m->>'de_email' de_email, m->>'de_nome' de_nome,
         m->>'para_email' para_email, m->>'para_nome' para_nome, (m->>'valor')::numeric valor,
         m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome, false as valido
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;
  update _exec e set valido = true from public.casos c
  where c.id = e.caso_id and c.operador_email = e.de_email
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    -- Acionado depois da simulacao? Voltou a ter dono pelos 10 dias: nao move.
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento);
  select count(*) filter (where not valido) into v_pulados from _exec;
  update public.casos c set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador='Retirado por nivelamento', nivelamento_em=now(), nivelamento_simulacao_id=p_id
    from _exec e where e.valido and c.id = e.caso_id;
  update public.casos c set operador_email=e.para_email, operador_nome=e.para_nome, operador=upper(coalesce(e.para_nome,''))
    from _exec e where e.valido and c.id = e.caso_id;
  for r in select * from _exec where valido loop
    select c.aluno_id into v_aluno from public.casos c where c.id = r.caso_id;
    insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
      operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
      valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
    values ('MOVIMENTACAO_NIVELAMENTO', p_id, r.caso_id, v_aluno, r.cpf, r.nome, r.de_email, r.de_nome, r.para_email, r.para_nome,
      r.valor, r.motivo, upper(coalesce(v_sim.resultado->>'metrica','SALDO')),
      jsonb_build_object('operador_email', r.de_email, 'operador_nome', r.de_nome),
      jsonb_build_object('operador_email', r.para_email, 'operador_nome', r.para_nome, 'marcador','Retirado por nivelamento'),
      v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email);
    v_executados := v_executados + 1;
  end loop;
  update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'EXECUTADA', 'executados', v_executados, 'pulados', v_pulados);
end; $function$;

-- ---------------------------------------------------------------------------
-- 4. Nivelamento 500: piso de 10 dias no parametro dias_sem_acionamento.
--    A tela deixa a gestao escolher o corte; abaixo de 10 ele invadiria a
--    fidelizacao. O piso e silencioso e volta no resultado em
--    'dias_sem_acionamento' (a tela mostra o valor efetivo).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calibragem_simular_nivelamento_impl(p_criterio jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ops text[];
  v_ano  int := nullif(p_criterio->>'ano','')::int;
  v_alvo int := coalesce(nullif(p_criterio->>'alvo','')::int, 500);
  v_dias int := coalesce(nullif(p_criterio->>'dias_sem_acionamento','')::int, 11);
  v_alvo_ef int; v_pool_total int; v_n_ops int; v_total_disp int;
  v_sim_id uuid; v_resultado jsonb;
  v_op record; v_c record; v_falta int; v_sobra int; v_movs int := 0;
  v_ia_qtd numeric; v_id_qtd numeric; v_ia_sal numeric; v_id_sal numeric;
  v_rich text; v_poor text; v_gap numeric; v_delta numeric; v_iter int := 0;
  v_ch record; v_cl record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para simular a Calibragem.';
  end if;
  -- Piso da fidelizacao: parado = mais de 10 dias sem acionamento.
  v_dias := greatest(v_dias, 10);
  if p_criterio ? 'operadores' then
    v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores'));
    if array_length(v_ops,1) is null then v_ops := null; end if;
  end if;

  create temp table _base on commit drop as
    select c.id caso_id,
           c.operador_email de_email, c.operador_nome de_nome,
           c.operador_email dest_email,
           coalesce(c.cpf_limpo,c.cpf) cpf, coalesce(c.nome,c.nome_aluno) nome,
           round(coalesce(s.saldo_mensalidade,0),2) valor,
           s.venc_min, s.venc_max,
           (c.data_ultimo_acionamento is null
             or c.data_ultimo_acionamento < current_date - v_dias) parado,
           false liberado
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where coalesce(s.saldo_mensalidade,0) > 0
      and coalesce(s.saldo_acordo,0) = 0
      and (v_ano is null or extract(year from s.venc_max) = v_ano)
      and not public.caso_protegido_redistribuicao(
            c.cpf_limpo, c.status_acionamento, c.nao_acionar,
            c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  create temp table _op on commit drop as
    select u.email op_email,
           coalesce(max(b.de_nome), u.nome) op_nome,
           count(b.de_email)::numeric qtd,
           round(coalesce(sum(b.valor),0),2) saldo
    from public.usuarios u
    left join _base b on b.de_email = u.email
    where u.ativo and u.perfil = 'operador'
      and (v_ops is null or u.email = any(v_ops))
    group by u.email, u.nome;
  create temp table _op_antes on commit drop as select * from _op;

  select count(*), coalesce(sum(qtd),0)::int into v_n_ops, v_total_disp from _op;
  select count(*) into v_pool_total from _base where de_email is null;
  v_total_disp := v_total_disp + v_pool_total;
  v_alvo_ef := case when v_n_ops = 0 then v_alvo
                    else least(v_alvo, floor(v_total_disp::numeric / v_n_ops)::int) end;

  v_ia_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _op));
  v_ia_sal := public.calibragem_indice_equilibrio(array(select saldo from _op));

  for v_op in select * from _op where qtd > v_alvo_ef order by qtd desc loop
    v_sobra := (v_op.qtd - v_alvo_ef)::int;
    for v_c in
      select caso_id, valor from _base
      where dest_email = v_op.op_email and parado and not liberado
      order by venc_min asc nulls first, valor asc
      limit v_sobra
    loop
      update _base set dest_email = null, liberado = true where caso_id = v_c.caso_id;
      update _op set qtd = qtd - 1, saldo = saldo - v_c.valor where op_email = v_op.op_email;
      v_movs := v_movs + 1;
    end loop;
  end loop;

  for v_op in select * from _op where qtd < v_alvo_ef order by saldo asc, qtd asc loop
    v_falta := (v_alvo_ef - v_op.qtd)::int;
    for v_c in
      select caso_id, valor from _base
      where dest_email is null
      order by venc_max desc nulls last, valor desc
      limit v_falta
    loop
      update _base set dest_email = v_op.op_email where caso_id = v_c.caso_id;
      update _op set qtd = qtd + 1, saldo = saldo + v_c.valor where op_email = v_op.op_email;
      v_movs := v_movs + 1;
    end loop;
  end loop;

  loop
    v_iter := v_iter + 1; exit when v_iter > 20000;
    select op_email into v_rich from _op order by saldo desc limit 1;
    select op_email into v_poor from _op order by saldo asc  limit 1;
    exit when v_rich = v_poor;
    v_gap := (select saldo from _op where op_email=v_rich) - (select saldo from _op where op_email=v_poor);
    exit when v_gap <= 0;
    -- Troca so mexe em caso ja fora do prazo (parado) ou vindo do pool,
    -- nunca em caso dentro dos 10 dias de fidelizacao do dono atual.
    select caso_id, valor into v_ch from _base where dest_email=v_rich and (parado or de_email is null) order by valor desc limit 1;
    select caso_id, valor into v_cl from _base where dest_email=v_poor and (parado or de_email is null) order by valor asc  limit 1;
    exit when v_ch.caso_id is null or v_cl.caso_id is null;
    v_delta := v_ch.valor - v_cl.valor;
    exit when v_delta <= 0;
    exit when v_delta >= v_gap;
    update _base set dest_email=v_poor where caso_id=v_ch.caso_id;
    update _base set dest_email=v_rich where caso_id=v_cl.caso_id;
    update _op set saldo=saldo - v_delta where op_email=v_rich;
    update _op set saldo=saldo + v_delta where op_email=v_poor;
    v_movs := v_movs + 2;
  end loop;

  v_id_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _op));
  v_id_sal := public.calibragem_indice_equilibrio(array(select saldo from _op));

  select jsonb_build_object(
    'criterio', p_criterio, 'metrica', 'NIVELAMENTO_500', 'ano', v_ano, 'alvo', v_alvo,
    'alvo_efetivo', v_alvo_ef, 'pool_total', v_pool_total, 'total_disponivel', v_total_disp,
    'dias_sem_acionamento', v_dias,
    'indice_antes', v_ia_sal, 'indice_depois', v_id_sal,
    'indice_qtd_antes', v_ia_qtd, 'indice_qtd_depois', v_id_qtd,
    'antes',  (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op_antes),
    'depois', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object(
        'caso_id',b.caso_id,'cpf',b.cpf,'nome',b.nome,'valor',b.valor,
        'de_email',b.de_email,'de_nome',b.de_nome,
        'para_email',b.dest_email,'para_nome',d.op_nome,
        'motivo', case
          when b.dest_email is null then 'Retirado por nivelamento (parado +'||v_dias||'d) - sem responsavel'
          when b.de_email  is null then 'Recebido do pool (divida recente)'
          else 'Realocado por nivelamento' end
      ) order by b.de_email nulls last, b.valor desc),'[]')
      from _base b left join _op d on d.op_email = b.dest_email
      where b.dest_email is distinct from b.de_email),
    'total_movimentacoes', (select count(*) from _base where dest_email is distinct from de_email)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt()->>'email','server'), coalesce(auth.jwt()->>'email','server'), p_criterio, v_resultado, 'RASCUNHO')
  returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $function$;

-- ---------------------------------------------------------------------------
-- 5. Execucoes do nivelamento 500: revalidam a janela na hora de RETIRAR.
--    Movimentacao com de_email nulo e entrega de caso do pool -- ninguem
--    perde nada -- e segue liberada.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calibragem_executar_nivelamento(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_executados int := 0; v_pulados int := 0;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar a Calibragem.'; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status not in ('APROVADA','EXECUTANDO') then raise exception 'Simulação precisa estar APROVADA (atual: %).', v_sim.status; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));

  -- Bypass do teto por sessão (sem AccessExclusiveLock na tabela casos)
  perform set_config('calibragem.bypass_teto','on', true);

  create temp table _exec on commit drop as
  select (m->>'caso_id')::uuid caso_id, nullif(m->>'de_email','') de_email, m->>'de_nome' de_nome,
         nullif(m->>'para_email','') para_email, m->>'para_nome' para_nome, (m->>'valor')::numeric valor,
         m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome, false as valido
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;

  update _exec e set valido = true from public.casos c
  where c.id = e.caso_id and c.operador_email is not distinct from e.de_email
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    -- Retirada so vale se o caso ja estiver fora dos 10 dias de fidelizacao.
    and (e.de_email is null or not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento));
  select count(*) filter (where not valido) into v_pulados from _exec;

  update public.casos c set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador='Retirado por nivelamento', nivelamento_em=now(), nivelamento_simulacao_id=p_id
    from _exec e where e.valido and c.id = e.caso_id and e.de_email is not null;

  update public.casos c set operador_email=e.para_email, operador_nome=e.para_nome, operador=upper(coalesce(e.para_nome,''))
    from _exec e where e.valido and c.id = e.caso_id and e.para_email is not null;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'MOVIMENTACAO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor, e.motivo,
    upper(coalesce(v_sim.resultado->>'metrica','NIVELAMENTO_500')),
    jsonb_build_object('operador_email', e.de_email, 'operador_nome', e.de_nome),
    jsonb_build_object('operador_email', e.para_email, 'operador_nome', e.para_nome, 'marcador','Retirado por nivelamento'),
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
  from _exec e join public.casos c on c.id = e.caso_id where e.valido;
  get diagnostics v_executados = row_count;

  update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'EXECUTADA', 'executados', v_executados, 'pulados', v_pulados);
end; $function$;

CREATE OR REPLACE FUNCTION public.calibragem_executar_nivelamento_lote_impl(p_id uuid, p_tamanho integer DEFAULT 150)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '90s'
AS $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_movidos int := 0; v_pulados int := 0; v_total int; v_feitos int; v_restantes int;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar a Calibragem.'; end if;
  if p_tamanho is null or p_tamanho < 1 then p_tamanho := 150; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status not in ('APROVADA','EXECUTANDO') then raise exception 'Simulação precisa estar APROVADA ou EXECUTANDO (atual: %).', v_sim.status; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));

  if v_sim.status = 'APROVADA' then
    update public.calibragem_simulacoes set status='EXECUTANDO' where id=p_id;
  end if;

  v_total := coalesce(jsonb_array_length(v_sim.resultado->'movimentacoes'), 0);
  perform set_config('calibragem.bypass_teto','on', true);

  create temp table _slice on commit drop as
  select (m->>'caso_id')::uuid caso_id, nullif(m->>'de_email','') de_email, m->>'de_nome' de_nome,
         nullif(m->>'para_email','') para_email, m->>'para_nome' para_nome, (m->>'valor')::numeric valor,
         m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome, false as valido
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m
  where not exists (
     select 1 from public.calibragem_auditoria a
     where a.simulacao_id=p_id and a.caso_id=(m->>'caso_id')::uuid
       and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO'))
  order by (m->>'caso_id')
  limit p_tamanho;

  update _slice e set valido = true from public.casos c
  where c.id = e.caso_id and c.operador_email is not distinct from e.de_email
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    -- Retirada so vale se o caso ja estiver fora dos 10 dias de fidelizacao.
    and (e.de_email is null or not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento));

  update public.casos c set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador='Retirado por nivelamento', nivelamento_em=now(), nivelamento_simulacao_id=p_id
    from _slice e where e.valido and c.id = e.caso_id and e.de_email is not null;

  update public.casos c set operador_email=e.para_email, operador_nome=e.para_nome, operador=upper(coalesce(e.para_nome,''))
    from _slice e where e.valido and c.id = e.caso_id and e.para_email is not null;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'MOVIMENTACAO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor, e.motivo,
    upper(coalesce(v_sim.resultado->>'metrica','NIVELAMENTO_500')),
    jsonb_build_object('operador_email', e.de_email, 'operador_nome', e.de_nome),
    jsonb_build_object('operador_email', e.para_email, 'operador_nome', e.para_nome, 'marcador','Retirado por nivelamento'),
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
  from _slice e join public.casos c on c.id = e.caso_id where e.valido;
  get diagnostics v_movidos = row_count;

  -- Marca os pulados para não reprocessar (LEFT JOIN cobre caso inexistente)
  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'PULADO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor,
    'Pulado: caso já não pertence ao operador de origem, está protegido ou está dentro dos 10 dias de fidelização.',
    upper(coalesce(v_sim.resultado->>'metrica','NIVELAMENTO_500')),
    '{}'::jsonb, '{}'::jsonb, v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
  from _slice e left join public.casos c on c.id = e.caso_id where not e.valido;
  get diagnostics v_pulados = row_count;

  select count(distinct a.caso_id) into v_feitos
  from public.calibragem_auditoria a
  where a.simulacao_id=p_id and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO');
  v_restantes := greatest(v_total - v_feitos, 0);

  if v_restantes = 0 then
    update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  end if;

  return jsonb_build_object('id', p_id, 'movidos_lote', v_movidos, 'pulados_lote', v_pulados,
    'feitos', v_feitos, 'restantes', v_restantes, 'total', v_total, 'concluido', v_restantes = 0);
end; $function$;

-- ---------------------------------------------------------------------------
-- 6. Card "Sem acionamento (risco de perder)": fonte unica.
--    Risco de perder = o que o cron da fidelizacao PODE soltar:
--      * fora do prazo (11 dias ou mais sem acionamento) OU nunca acionado;
--      * nao protegido (acordo ativo, link, baixa, confirmacao, tabulacao em
--        andamento) -- protegido nao se perde, nao e risco;
--      * nao encerrado operacionalmente.
--    Ordem: nunca acionado primeiro, depois o mais parado.
-- ---------------------------------------------------------------------------
create or replace function public.casos_risco_perder(p_email text default null)
returns table(
  caso_id uuid,
  aluno_id uuid,
  operador_email text,
  data_ultimo_acionamento date,
  dias_parado int,
  nunca_acionado boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_jwt text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_alvo text := nullif(lower(coalesce(p_email,'')),'');
begin
  -- Operador so enxerga a propria carteira; gestao/diretoria enxerga todas.
  if v_jwt <> '' and not (public.usuario_e_gestao() or public.usuario_tem_visao_geral()) then
    v_alvo := v_jwt;
  end if;

  return query
  select c.id, c.aluno_id, c.operador_email, c.data_ultimo_acionamento,
         case when c.data_ultimo_acionamento is null then null
              else (current_date - c.data_ultimo_acionamento)::int end,
         (c.data_ultimo_acionamento is null)
  from public.casos c
  where c.operador_email is not null
    and (v_alvo is null or lower(c.operador_email) = v_alvo)
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
  order by (c.data_ultimo_acionamento is null) desc, c.data_ultimo_acionamento asc nulls first;
end;
$function$;

comment on function public.casos_risco_perder(text) is
  'Casos que o operador pode PERDER de fato: fora dos 10 dias de fidelizacao (11d+ ou nunca acionado) e nao protegidos. Fonte do card "Sem acionamento (risco de perder)".';

revoke all on function public.casos_risco_perder(text) from public;
grant execute on function public.casos_risco_perder(text) to authenticated;
grant execute on function public.caso_dentro_prazo_fidelizacao(date) to authenticated;
