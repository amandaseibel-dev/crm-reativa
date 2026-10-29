-- ============================================================================
-- CALIBRAGEM — EQUIPARAR DÍVIDAS POR ANO (ex.: nivelar 2026 entre operadores)
-- ----------------------------------------------------------------------------
-- calibragem_simular_ano(criterio{ano}) — equipara a QUANTIDADE de casos de um
-- determinado ano (2024/2025/2026) entre os operadores, via TROCA: o operador
-- que tem muitos casos daquele ano manda um caso do ano e recebe de volta um
-- caso de OUTRO ano — mantém a carteira em 500 e rebalanceia a composição.
--
-- Gera movimentos de `casos` (caso_id) -> a EXECUÇÃO reusa o executor de
-- mensalidades já validado (calibragem_executar_simulacao). metrica='ANO'.
-- Ano do caso = ano do vencimento mais antigo aberto (calibragem_saldo_aluno).
-- Reversível.
-- ============================================================================

begin;

create or replace function public.calibragem_simular_ano(p_criterio jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ops text[]; v_ano int := coalesce((p_criterio->>'ano')::int, 2026);
  v_sim_id uuid; v_target numeric; v_resultado jsonb; v_ia numeric; v_id numeric;
  v_iter int := 0; v_max int := 6000; v_rich text; v_poor text; v_gap numeric;
  v_cY record; v_cN record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para simular por ano.'; end if;
  if p_criterio ? 'operadores' then v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores')); end if;

  -- base: casos elegíveis com ano derivado
  create temp table _b on commit drop as
    select c.id caso_id, c.operador_email op_email, c.operador_nome op_nome,
           coalesce(c.cpf_limpo,c.cpf) cpf, coalesce(c.nome,c.nome_aluno) nome,
           round(coalesce(s.saldo_total,0),2) valor,
           (extract(year from s.venc_min) = v_ano) eh_ano
    from public.casos c
    left join public.calibragem_saldo_aluno s on s.aluno_id=c.aluno_id
    where c.operador_email is not null and (v_ops is null or c.operador_email = any(v_ops))
      and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  create temp table _op on commit drop as
    select op_email, max(op_nome) op_nome,
           count(*) filter (where eh_ano)::numeric qtd
    from _b group by op_email;
  create temp table _op_antes on commit drop as select * from _op;

  -- pools: casos do ano (para enviar) e de outros anos (para receber de volta)
  create temp table _py on commit drop as
    select caso_id, op_email, cpf, nome, valor,
           row_number() over (partition by op_email order by valor asc) rn, false usado
    from _b where eh_ano;
  create temp table _pn on commit drop as
    select caso_id, op_email, cpf, nome, valor,
           row_number() over (partition by op_email order by valor asc) rn, false usado
    from _b where not eh_ano;

  create temp table _mov (
    caso_id uuid, cpf text, nome text, valor numeric, de_email text, de_nome text, para_email text, para_nome text, motivo text) on commit drop;

  select avg(qtd) into v_target from _op;
  v_ia := public.calibragem_indice_equilibrio(array(select qtd from _op));

  loop
    v_iter := v_iter + 1; exit when v_iter > v_max;
    select op_email into v_rich from _op order by qtd desc limit 1;
    select op_email into v_poor from _op order by qtd asc  limit 1;
    exit when v_rich = v_poor;
    v_gap := (select qtd from _op where op_email=v_rich) - (select qtd from _op where op_email=v_poor);
    exit when v_gap <= 1;
    select * into v_cY from _py where op_email=v_rich and not usado order by rn limit 1;
    select * into v_cN from _pn where op_email=v_poor and not usado order by rn limit 1;
    exit when v_cY is null or v_cN is null;
    -- caso do ano: rich -> poor ; caso de outro ano: poor -> rich
    insert into _mov values (v_cY.caso_id, v_cY.cpf, coalesce(v_cY.nome,v_cY.cpf), v_cY.valor, v_rich, (select op_nome from _op where op_email=v_rich), v_poor, (select op_nome from _op where op_email=v_poor), 'Troca por nivelamento de dívidas '||v_ano||' (envia '||v_ano||')');
    insert into _mov values (v_cN.caso_id, v_cN.cpf, coalesce(v_cN.nome,v_cN.cpf), v_cN.valor, v_poor, (select op_nome from _op where op_email=v_poor), v_rich, (select op_nome from _op where op_email=v_rich), 'Troca por nivelamento de dívidas '||v_ano||' (recebe outro ano)');
    update _py set usado=true where caso_id=v_cY.caso_id;
    update _pn set usado=true where caso_id=v_cN.caso_id;
    update _op set qtd=qtd-1 where op_email=v_rich;
    update _op set qtd=qtd+1 where op_email=v_poor;
  end loop;

  v_id := public.calibragem_indice_equilibrio(array(select qtd from _op));

  select jsonb_build_object(
    'criterio', p_criterio, 'metrica', 'ANO', 'ano', v_ano, 'alvo', round(v_target,1),
    'indice_antes', v_ia, 'indice_depois', v_id,
    'antes', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',0) order by op_nome),'[]') from _op_antes),
    'depois',(select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',0) order by op_nome),'[]') from _op),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object('caso_id',caso_id,'cpf',cpf,'nome',nome,'valor',valor,'de_email',de_email,'de_nome',de_nome,'para_email',para_email,'para_nome',para_nome,'motivo',motivo) order by de_email),'[]') from _mov),
    'total_movimentacoes', (select count(*) from _mov)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt() ->> 'email','server'), coalesce(auth.jwt() ->> 'email','server'), p_criterio, v_resultado, 'RASCUNHO')
  returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $$;
revoke all on function public.calibragem_simular_ano(jsonb) from public;
grant execute on function public.calibragem_simular_ano(jsonb) to authenticated;

commit;
