-- ============================================================================
-- HOTFIX SEGURANÇA — RPCs da Calibragem (minimização de CPF + endurecimento)
-- Contexto: as 5 RPCs são SECURITY DEFINER (owner postgres) e já têm gate
-- calibragem_e_gestao() → gestão-only (operador/sem-perfil/anon recebem exceção).
-- Ajustes:
--  * mask_cpf(): CPF passa a sair mascarado (***NNN) nas listagens/simulações;
--  * listar_casos / simular / simular_ano: aplicam mask_cpf no retorno;
--  * simular / simular_ano: gate jwt-null endurecido (exige session_user técnico),
--    consistente com o padrão do executor técnico. (recomputar_snapshot e
--    criticidade_auto não expõem CPF; recomputar mantém gate — jwt-null não é
--    alcançável externamente.)
--  * REVOKE EXECUTE de PUBLIC/anon nas 5 (idempotente); authenticated mantém
--    EXECUTE porque o gate interno impede ampliação de escopo.
-- Não altera Ações Massivas, GRANT ALL gerais nem as policies USING(true).
-- ============================================================================

-- Helper de máscara de CPF (pura/imutável). CPF completo só na ficha individual.
CREATE OR REPLACE FUNCTION public.mask_cpf(p text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog'
AS $$
  SELECT CASE
           WHEN p IS NULL OR btrim(p) = '' THEN NULL
           ELSE '***' || right(regexp_replace(p, '[^0-9]', '', 'g'), 3)
         END
$$;
REVOKE EXECUTE ON FUNCTION public.mask_cpf(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mask_cpf(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- calibragem_listar_casos: CPF mascarado (gate gestão-only inalterado)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calibragem_listar_casos(p_operador_email text, p_indicador text, p_faixa text DEFAULT NULL::text, p_ano integer DEFAULT NULL::integer, p_limit integer DEFAULT 300, p_filtros jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_rows jsonb; v_fa_min int; v_fa_max int;
  v_valor_min numeric := nullif(p_filtros->>'valor_min','')::numeric;
  v_valor_max numeric := nullif(p_filtros->>'valor_max','')::numeric;
  v_crit text := upper(nullif(p_filtros->>'criticidade',''));
  v_sem_ac int := nullif(p_filtros->>'sem_acionamento_dias','')::int;
  v_unidade text := nullif(p_filtros->>'unidade',''); v_curso text := nullif(p_filtros->>'curso',''); v_origem text := nullif(p_filtros->>'origem','');
begin
  if not public.calibragem_e_gestao() then raise exception 'Sem permissão para detalhar a Calibragem.'; end if;
  if p_faixa is not null then
    v_fa_min := split_part(replace(p_faixa,'+',''), '-', 1)::int;
    v_fa_max := case when p_faixa like '%+' then 100000 else nullif(split_part(p_faixa,'-',2),'')::int end;
  end if;
  select coalesce(jsonb_agg(t order by (t->>'saldo')::numeric desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object('caso_id', c.id, 'aluno_id', c.aluno_id, 'cpf', public.mask_cpf(coalesce(c.cpf_limpo, c.cpf)),
             'nome', coalesce(c.nome, c.nome_aluno), 'saldo', round(coalesce(s.saldo_total,0),2),
             'dias_atraso', coalesce(c.dias_atraso,0), 'criticidade', coalesce(c.criticidade,'-'),
             'status_acionamento', coalesce(c.status_acionamento,'—'), 'ultimo_acionamento', c.data_ultimo_acionamento,
             'unidade', c.unidade, 'curso', c.curso, 'ano_divida', extract(year from s.venc_min)) as t
    from public.casos c left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where c.operador_email = p_operador_email
      and ( p_indicador='cpfs' or p_indicador='saldo_total'
        or (p_indicador='mensalidades' and coalesce(s.saldo_mensalidade,0)>0)
        or (p_indicador='titulos_abertos' and coalesce(s.qtd_titulos_abertos,0)>0)
        or (p_indicador='sem_acionamento' and c.status_acionamento is null)
        or (p_indicador='sem_acionamento_recente' and c.status_acionamento is not null and c.data_ultimo_acionamento < current_date-10)
        or (p_indicador='criticos' and upper(coalesce(c.criticidade,'')) in ('CRITICO','URGENTE'))
        or (p_indicador='antigos' and coalesce(c.dias_atraso,0)>360) or (p_indicador='faixa_atraso') or (p_indicador='ano') )
      and (p_faixa is null or (coalesce(c.dias_atraso,0) between v_fa_min and v_fa_max))
      and (p_ano is null or (extract(year from s.venc_min)=p_ano))
      and (v_valor_min is null or coalesce(s.saldo_total,0) >= v_valor_min)
      and (v_valor_max is null or coalesce(s.saldo_total,0) < v_valor_max)
      and (v_crit is null or upper(coalesce(c.criticidade,'')) = v_crit)
      and (v_sem_ac is null or (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento < current_date - v_sem_ac))
      and (v_unidade is null or c.unidade ilike '%'||v_unidade||'%')
      and (v_curso is null or c.curso ilike '%'||v_curso||'%')
      and (v_origem is null or coalesce(c.origem,'') ilike '%'||v_origem||'%')
    limit p_limit
  ) q;
  return jsonb_build_object('operador_email', p_operador_email, 'indicador', p_indicador, 'faixa', p_faixa, 'ano', p_ano, 'filtros', p_filtros, 'total', jsonb_array_length(v_rows), 'casos', v_rows);
end; $function$;

-- ---------------------------------------------------------------------------
-- calibragem_simular: CPF mascarado + gate jwt-null endurecido
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calibragem_simular(p_criterio jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
-- calibragem_simular_ano: CPF mascarado (inclui fallback de nome) + gate endurecido
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calibragem_simular_ano(p_criterio jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_ops text[]; v_ano int := coalesce((p_criterio->>'ano')::int, 2026);
  v_sim_id uuid; v_target numeric; v_resultado jsonb; v_ia numeric; v_id numeric;
  v_iter int := 0; v_max int := 6000; v_rich text; v_poor text; v_gap numeric; v_cY record; v_cN record;
begin
  if not (public.calibragem_e_gestao() or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'))) then raise exception 'Sem permissão para simular por ano.'; end if;
  if p_criterio ? 'operadores' then v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores')); end if;
  create temp table _b on commit drop as
    select c.id caso_id, c.operador_email op_email, c.operador_nome op_nome, coalesce(c.cpf_limpo,c.cpf) cpf, coalesce(c.nome,c.nome_aluno) nome,
           round(coalesce(s.saldo_total,0),2) valor, (extract(year from s.venc_min) = v_ano) eh_ano
    from public.casos c left join public.calibragem_saldo_aluno s on s.aluno_id=c.aluno_id
    where c.operador_email is not null and (v_ops is null or c.operador_email = any(v_ops))
      and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);
  create temp table _op on commit drop as select op_email, max(op_nome) op_nome, count(*) filter (where eh_ano)::numeric qtd from _b group by op_email;
  create temp table _op_antes on commit drop as select * from _op;
  create temp table _py on commit drop as select caso_id, op_email, cpf, nome, valor, row_number() over (partition by op_email order by valor asc) rn, false usado from _b where eh_ano;
  create temp table _pn on commit drop as select caso_id, op_email, cpf, nome, valor, row_number() over (partition by op_email order by valor asc) rn, false usado from _b where not eh_ano;
  create temp table _mov (caso_id uuid, cpf text, nome text, valor numeric, de_email text, de_nome text, para_email text, para_nome text, motivo text) on commit drop;
  select avg(qtd) into v_target from _op;
  v_ia := public.calibragem_indice_equilibrio(array(select qtd from _op));
  loop
    v_iter := v_iter + 1; exit when v_iter > v_max;
    select op_email into v_rich from _op order by qtd desc limit 1;
    select op_email into v_poor from _op order by qtd asc limit 1;
    exit when v_rich = v_poor;
    v_gap := (select qtd from _op where op_email=v_rich) - (select qtd from _op where op_email=v_poor);
    exit when v_gap <= 1;
    select * into v_cY from _py where op_email=v_rich and not usado order by rn limit 1;
    select * into v_cN from _pn where op_email=v_poor and not usado order by rn limit 1;
    exit when v_cY is null or v_cN is null;
    insert into _mov values (v_cY.caso_id, v_cY.cpf, coalesce(v_cY.nome, public.mask_cpf(v_cY.cpf)), v_cY.valor, v_rich, (select op_nome from _op where op_email=v_rich), v_poor, (select op_nome from _op where op_email=v_poor), 'Troca por nivelamento de dívidas '||v_ano||' (envia '||v_ano||')');
    insert into _mov values (v_cN.caso_id, v_cN.cpf, coalesce(v_cN.nome, public.mask_cpf(v_cN.cpf)), v_cN.valor, v_poor, (select op_nome from _op where op_email=v_poor), v_rich, (select op_nome from _op where op_email=v_rich), 'Troca por nivelamento de dívidas '||v_ano||' (recebe outro ano)');
    update _py set usado=true where caso_id=v_cY.caso_id; update _pn set usado=true where caso_id=v_cN.caso_id;
    update _op set qtd=qtd-1 where op_email=v_rich; update _op set qtd=qtd+1 where op_email=v_poor;
  end loop;
  v_id := public.calibragem_indice_equilibrio(array(select qtd from _op));
  select jsonb_build_object('criterio', p_criterio, 'metrica', 'ANO', 'ano', v_ano, 'alvo', round(v_target,1), 'indice_antes', v_ia, 'indice_depois', v_id,
    'antes', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',0) order by op_nome),'[]') from _op_antes),
    'depois',(select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',0) order by op_nome),'[]') from _op),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object('caso_id',caso_id,'cpf',public.mask_cpf(cpf),'nome',nome,'valor',valor,'de_email',de_email,'de_nome',de_nome,'para_email',para_email,'para_nome',para_nome,'motivo',motivo) order by de_email),'[]') from _mov),
    'total_movimentacoes', (select count(*) from _mov)) into v_resultado;
  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt() ->> 'email','server'), coalesce(auth.jwt() ->> 'email','server'), p_criterio, v_resultado, 'RASCUNHO') returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $function$;

-- ---------------------------------------------------------------------------
-- Privilégios: sem PUBLIC/anon nas 5 RPCs; authenticated (gate interno) + service_role.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.calibragem_listar_casos(text,text,text,integer,integer,jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.calibragem_simular(jsonb)         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.calibragem_simular_ano(jsonb)     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.calibragem_criticidade_auto()     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.calibragem_recomputar_snapshot()  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calibragem_listar_casos(text,text,text,integer,integer,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calibragem_simular(jsonb)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calibragem_simular_ano(jsonb)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calibragem_criticidade_auto()     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calibragem_recomputar_snapshot()  TO authenticated, service_role;
