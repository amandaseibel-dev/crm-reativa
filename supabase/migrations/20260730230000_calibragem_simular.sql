-- ============================================================================
-- CALIBRAGEM — SIMULADOR (preview) — item 2.3
-- ----------------------------------------------------------------------------
-- calibragem_simular(criterio) calcula uma proposta de nivelamento SEM MOVER
-- nenhum caso. Grava em calibragem_simulacoes (status RASCUNHO) e retorna:
--   antes/depois por operador (qtd + saldo), movimentações sugeridas (caso que
--   sai de X e entra em Y, com MOTIVO), impacto no Índice de Equilíbrio.
--
-- Critérios: EQUIPARAR_SALDO (troca/swap — mantém contagem, desloca saldo,
--   necessário porque os operadores estão no teto de 500), EQUIPARAR_QTD
--   (move unidirecional quando há vaga), RETIRAR_SEM_ACIONAMENTO (restringe o
--   pool a casos sem acionamento da origem).
--
-- Elegibilidade p/ sair: não protegido (caso_protegido_redistribuicao).
-- Índice de Equilíbrio (item 2.2): 100*(1 - coef. variação da métrica) ∈ [0,100].
-- Reversível (drop functions).
-- ============================================================================

begin;

create or replace function public.calibragem_indice_equilibrio(p_vals numeric[])
returns numeric language plpgsql immutable as $$
declare v_avg numeric; v_sd numeric; v_cv numeric;
begin
  if p_vals is null or array_length(p_vals,1) is null or array_length(p_vals,1) < 2 then return 100; end if;
  select avg(v), coalesce(stddev_pop(v),0) into v_avg, v_sd from unnest(p_vals) v;
  if coalesce(v_avg,0) = 0 then return 100; end if;
  v_cv := v_sd / v_avg;
  return greatest(0, round((1 - v_cv) * 100, 1));
end; $$;

create or replace function public.calibragem_simular(p_criterio jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
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
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para simular a Calibragem.'; end if;
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
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object('caso_id',caso_id,'cpf',cpf,'nome',nome,'valor',valor,'dias_atraso',dias_atraso,'criticidade',criticidade,'de_email',de_email,'de_nome',de_nome,'para_email',para_email,'para_nome',para_nome,'motivo',motivo) order by de_email, valor desc),'[]') from _pool where movido),
    'total_movimentacoes', (select count(*) from _pool where movido)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt() ->> 'email','server'), coalesce(auth.jwt() ->> 'email','server'), p_criterio, v_resultado, 'RASCUNHO')
  returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $$;

revoke all on function public.calibragem_simular(jsonb) from public;
grant execute on function public.calibragem_simular(jsonb) to authenticated;
revoke all on function public.calibragem_indice_equilibrio(numeric[]) from public;
grant execute on function public.calibragem_indice_equilibrio(numeric[]) to authenticated;

commit;
