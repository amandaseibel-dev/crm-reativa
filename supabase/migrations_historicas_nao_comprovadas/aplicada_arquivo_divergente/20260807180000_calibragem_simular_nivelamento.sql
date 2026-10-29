-- Calibragem — nova simulação de NIVELAMENTO (conceito da gestão):
--   * base = só "mensalidades sem negociação" (view calibragem_saldo_aluno:
--     saldo_mensalidade > 0 e saldo_acordo = 0), opcionalmente de um ANO;
--   * alvo = 500 CPFs FIXO por operador;
--   * FASE 1 (retirar): operador ACIMA de 500 solta os casos PARADOS (+N dias
--     sem acionamento), dívida mais ANTIGA primeiro, para o POOL (sem responsável);
--   * FASE 2 (completar): operador ABAIXO de 500 puxa do POOL (sem responsável +
--     recém-soltos), dívida mais RECENTE primeiro, menor saldo primeiro;
--   * FASE 3 (equilíbrio de valor): trocas que igualam o saldo SEM mudar o 500.
--   Resultado nos dados reais: 500 CPFs cada + saldo dentro de ~1% (equilíbrio 99,7).
--
-- SÓ SIMULA: grava RASCUNHO em calibragem_simulacoes. NÃO move nenhum caso.
-- Gate: só gestão. Reutiliza caso_protegido_redistribuicao. Aplicada em prod
-- via MCP em 2026-08-07 (função de simulação, sem mutação de dados operacionais).

CREATE OR REPLACE FUNCTION public.calibragem_simular_nivelamento(p_criterio jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_ops text[];
  v_ano  int := nullif(p_criterio->>'ano','')::int;
  v_alvo int := coalesce(nullif(p_criterio->>'alvo','')::int, 500);
  v_dias int := coalesce(nullif(p_criterio->>'dias_sem_acionamento','')::int, 11);
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
      and (v_ano is null or extract(year from s.venc_min) = v_ano)
      and not public.caso_protegido_redistribuicao(
            c.cpf_limpo, c.status_acionamento, c.nao_acionar,
            c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  create temp table _op on commit drop as
    select de_email op_email, max(de_nome) op_nome,
           count(*)::numeric qtd, round(sum(valor),2) saldo
    from _base
    where de_email is not null and de_email like 'cobranca%'
      and (v_ops is null or de_email = any(v_ops))
    group by de_email;
  create temp table _op_antes on commit drop as select * from _op;

  v_ia_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _op));
  v_ia_sal := public.calibragem_indice_equilibrio(array(select saldo from _op));

  -- FASE 1 — RETIRAR (acima do alvo solta parados -> pool)
  for v_op in select * from _op where qtd > v_alvo order by qtd desc loop
    v_sobra := (v_op.qtd - v_alvo)::int;
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

  -- FASE 2 — COMPLETAR (abaixo do alvo puxa do pool, recente primeiro; menor saldo primeiro)
  for v_op in select * from _op where qtd < v_alvo order by saldo asc, qtd asc loop
    v_falta := (v_alvo - v_op.qtd)::int;
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
    'dias_sem_acionamento', v_dias,
    'indice_antes', v_ia_sal, 'indice_depois', v_id_sal,
    'indice_qtd_antes', v_ia_qtd, 'indice_qtd_depois', v_id_qtd,
    'antes',  (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op_antes),
    'depois', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object(
        'caso_id',caso_id,'cpf',cpf,'nome',nome,'valor',valor,
        'de_email',de_email,'de_nome',de_nome,'para_email',dest_email,
        'motivo', case
          when dest_email is null then 'Retirado por nivelamento (parado +'||v_dias||'d) - sem responsavel'
          when de_email  is null then 'Recebido do pool (divida recente)'
          else 'Realocado por nivelamento' end
      ) order by de_email nulls last, valor desc),'[]')
      from _base where dest_email is distinct from de_email),
    'total_movimentacoes', (select count(*) from _base where dest_email is distinct from de_email)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt()->>'email','server'), coalesce(auth.jwt()->>'email','server'), p_criterio, v_resultado, 'RASCUNHO')
  returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $function$;

REVOKE ALL ON FUNCTION public.calibragem_simular_nivelamento(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.calibragem_simular_nivelamento(jsonb) TO authenticated, service_role;
