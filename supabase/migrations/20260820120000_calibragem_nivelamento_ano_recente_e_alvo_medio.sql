-- Calibragem / Nivelamento — três correções no motor:
--
-- 1) ANO DO ALUNO = dívida mais RECENTE (venc_max), não a mais antiga (venc_min).
--    Antes, quem devia 2024 e 2026 caía no balde de 2024: o recorte "2026" ficava
--    sem pool (0 casos sem responsável) e a simulação sempre respondia
--    "pool insuficiente". Pela leitura nova existem 242 alunos de 2026 sem dono.
--
-- 2) ALVO EFETIVO = menor entre o alvo pedido (500) e a média disponível por
--    operador. Com alvo fixo de 500 e ninguém acima de 500, a Fase 1 não soltava
--    nada e a Fase 2 não tinha de onde puxar: a tela rodava e não movia nada.
--    Agora quem está acima da média solta os parados e quem está abaixo completa.
--
-- 3) O conjunto de operadores passa a vir de usuarios (perfil=operador, ativo),
--    e não de "email like cobranca%": operador com zero casos no ano continua
--    visível e recebe. Também corrige `para_nome`, que não ia na simulação e
--    deixava casos.operador_nome nulo ao aplicar.

create or replace function public.calibragem_diagnostico_sem_negociacao_impl(p_ano integer default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_res jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão.';
  end if;

  with base as (
    select c.operador_email de_email, c.operador_nome de_nome,
           round(coalesce(s.saldo_mensalidade,0),2) valor
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where coalesce(s.saldo_mensalidade,0) > 0
      and coalesce(s.saldo_acordo,0) = 0
      and (p_ano is null or extract(year from s.venc_max) = p_ano)
      and not public.caso_protegido_redistribuicao(
            c.cpf_limpo, c.status_acionamento, c.nao_acionar,
            c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
  ),
  ops as (
    select u.email op_email,
           coalesce(max(b.de_nome), u.nome) op_nome,
           count(b.de_email) qtd,
           round(coalesce(sum(b.valor),0),2) saldo
    from public.usuarios u
    left join base b on b.de_email = u.email
    where u.ativo and u.perfil = 'operador'
    group by u.email, u.nome
  ),
  pool as (
    select count(*) qtd, round(coalesce(sum(valor),0),2) saldo
    from base where de_email is null
  ),
  anos as (
    select extract(year from s.venc_max)::int ano, count(*) qtd
    from public.casos c join public.calibragem_saldo_aluno s on s.aluno_id=c.aluno_id
    where coalesce(s.saldo_mensalidade,0)>0 and coalesce(s.saldo_acordo,0)=0 and s.venc_max is not null
    group by 1
  )
  select jsonb_build_object(
    'ano', p_ano,
    'base_total', (select count(*) from base),
    'pool_total', (select qtd from pool),
    'pool_saldo', (select saldo from pool),
    'alvo_sugerido', (select case when count(*) = 0 then 0
                              else floor((sum(qtd) + (select qtd from pool))::numeric / count(*))::int end
                      from ops),
    'operadores', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by qtd asc),'[]') from ops),
    'anos', (select coalesce(jsonb_agg(jsonb_build_object('ano',ano,'qtd',qtd) order by ano desc),'[]') from anos)
  ) into v_res;
  return v_res;
end; $function$;

create or replace function public.calibragem_simular_nivelamento_impl(p_criterio jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  if p_criterio ? 'operadores' then
    v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores'));
    if array_length(v_ops,1) is null then v_ops := null; end if;
  end if;

  -- Universo do ano: aluno pertence ao ano da sua dívida MAIS RECENTE (venc_max).
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

  -- Operadores vêm do cadastro: quem está com zero casos no ano também aparece.
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

  -- Alvo efetivo: não adianta mirar 500 se o material disponível não dá 500 por
  -- cabeça. Quando não dá, nivela pela média — quem está acima solta, quem está
  -- abaixo completa.
  select count(*), coalesce(sum(qtd),0)::int into v_n_ops, v_total_disp from _op;
  select count(*) into v_pool_total from _base where de_email is null;
  v_total_disp := v_total_disp + v_pool_total;
  v_alvo_ef := case when v_n_ops = 0 then v_alvo
                    else least(v_alvo, floor(v_total_disp::numeric / v_n_ops)::int) end;

  v_ia_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _op));
  v_ia_sal := public.calibragem_indice_equilibrio(array(select saldo from _op));

  -- FASE 1 — RETIRAR (acima do alvo efetivo solta parados -> pool)
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

  -- FASE 2 — COMPLETAR (abaixo do alvo efetivo puxa do pool, recente primeiro)
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

  -- FASE 3 — EQUILÍBRIO DE VALOR (trocas sem alterar o count)
  loop
    v_iter := v_iter + 1; exit when v_iter > 20000;
    select op_email into v_rich from _op order by saldo desc limit 1;
    select op_email into v_poor from _op order by saldo asc  limit 1;
    exit when v_rich = v_poor;
    v_gap := (select saldo from _op where op_email=v_rich) - (select saldo from _op where op_email=v_poor);
    exit when v_gap <= 0;
    select caso_id, valor into v_ch from _base where dest_email=v_rich order by valor desc limit 1;
    select caso_id, valor into v_cl from _base where dest_email=v_poor order by valor asc  limit 1;
    exit when v_ch.caso_id is null or v_cl.caso_id is null;
    v_delta := v_ch.valor - v_cl.valor;
    exit when v_delta <= 0;      -- nada a ganhar
    exit when v_delta >= v_gap;  -- troca passaria do ponto (overshoot)
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
    -- para_nome vai junto: sem ele o executor gravava casos.operador_nome nulo.
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
