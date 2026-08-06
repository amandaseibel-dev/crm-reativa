-- ============================================================================
-- CALIBRAGEM — DEIXAR TODOS COM 500 CASOS + SALDO EQUILIBRADO
-- ----------------------------------------------------------------------------
-- calibragem_simular_500(criterio) monta, SEM MOVER nada, uma proposta que:
--   1) FASE CONTAGEM: leva todos os operadores ao teto de 500 casos —
--      quem está ACIMA de 500 (mais CPFs) manda o excedente para quem está
--      ABAIXO. Se um ANO for informado, os casos daquele ano saem primeiro
--      ("o ano que quero passar"). O destino preferido é o operador com MENOR
--      saldo (para já ajudar o equilíbrio financeiro), e o caso enviado é o de
--      MAIOR valor do doador.
--   2) FASE SALDO: com as contagens fixas em ~500, faz TROCAS (swap, não muda a
--      contagem) mandando o caso de maior valor de quem tem mais saldo para
--      quem tem menos, até os saldos ficarem praticamente iguais.
--
-- Parâmetros do criterio (jsonb):
--   operadores : text[]  (opcional — default: todos os cobranca*)
--   ano        : int|null (opcional — 2024/2025/2026; null = qualquer ano)
--   limite_mov : int|null (opcional — teto de movimentações; null = sem teto)
--   teto       : int      (opcional — alvo de casos por operador; default 500)
--
-- Gera `movimentacoes` (caso_id -> para_email) no MESMO formato das outras
-- simulações -> a EXECUÇÃO reusa calibragem_executar_simulacao (validado).
-- metrica='500' (rótulo de auditoria). Grava RASCUNHO. Reversível (drop function).
-- ============================================================================

begin;

create or replace function public.calibragem_simular_500(p_criterio jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ops text[];
  v_ano int := nullif(p_criterio->>'ano','')::int;
  v_limite_mov int := nullif(p_criterio->>'limite_mov','')::int;
  v_teto int := coalesce(nullif(p_criterio->>'teto','')::int, 500);   -- TETO (cap): ninguém passa disso
  v_alvo numeric := nullif(p_criterio->>'alvo','')::numeric;           -- ALVO de contagem; null = média
  v_sim_id uuid; v_resultado jsonb;
  v_ia_qtd numeric; v_id_qtd numeric; v_ia_sal numeric; v_id_sal numeric;
  v_iter int := 0; v_max int := 20000; v_movs int := 0;
  v_doador text; v_receptor text;
  v_rich text; v_poor text; v_gap numeric; v_delta numeric;
  v_cS record; v_cH record; v_cL record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para simular a Calibragem.';
  end if;
  if p_criterio ? 'operadores' then
    v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores'));
    if array_length(v_ops,1) is null then v_ops := null; end if;
  end if;

  -- Base elegível: casos de mensalidade não protegidos, com saldo e ano da dívida
  create temp table _pool on commit drop as
    select c.id caso_id, c.operador_email de_email, c.operador_nome de_nome,
           coalesce(c.cpf_limpo,c.cpf) cpf, coalesce(c.nome,c.nome_aluno) nome,
           round(coalesce(s.saldo_total,0),2) valor,
           (extract(year from s.venc_min) = v_ano) eh_ano,
           false as movido, null::text as para_email, null::text as para_nome, null::text as motivo
    from public.casos c
    left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where c.operador_email is not null
      and (v_ops is null or c.operador_email = any(v_ops))
      and not public.caso_protegido_redistribuicao(
            c.cpf_limpo, c.status_acionamento, c.nao_acionar,
            c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  -- Estado por operador (contagem inclui TODOS os casos; só os do _pool podem mover)
  create temp table _op on commit drop as
    select c.operador_email op_email, max(c.operador_nome) op_nome,
           count(*)::numeric qtd,
           round(sum(coalesce(s.saldo_total,0)),2) saldo
    from public.casos c
    left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where c.operador_email is not null
      and (v_ops is null or c.operador_email = any(v_ops))
    group by c.operador_email;
  create temp table _op_antes on commit drop as select * from _op;

  -- ALVO de contagem: se não informado, é a MÉDIA de casos dos participantes
  -- (todos convergem para a média; o TETO 500 é só o limite máximo). "Todos com
  -- 500" só seria possível se houvesse casos suficientes — quando não há, a média
  -- é o ponto de equilíbrio real. Nunca deixa o alvo passar do teto.
  if v_alvo is null then select round(avg(qtd)) into v_alvo from _op; end if;
  v_alvo := least(v_alvo, v_teto);

  v_ia_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _op));
  v_ia_sal := public.calibragem_indice_equilibrio(array(select saldo from _op));

  -- ------------------------------------------------------------------
  -- FASE CONTAGEM: quem está acima do alvo manda excedente para quem está abaixo
  -- ------------------------------------------------------------------
  loop
    v_iter := v_iter + 1; exit when v_iter > v_max;
    exit when v_limite_mov is not null and v_movs >= v_limite_mov;
    -- doador = maior qtd acima do alvo que ainda tenha caso disponível
    select op_email into v_doador from _op
      where qtd > v_alvo
        and exists (select 1 from _pool p where p.de_email = _op.op_email and not p.movido)
      order by qtd desc limit 1;
    exit when v_doador is null;
    -- receptor = menor saldo entre os abaixo do alvo (e do teto); ajuda o saldo
    select op_email into v_receptor from _op
      where op_email <> v_doador and qtd < v_alvo and qtd < v_teto
      order by saldo asc, qtd asc limit 1;
    exit when v_receptor is null;
    -- caso a mover: prioriza o ANO escolhido; depois o de MAIOR valor
    select * into v_cS from _pool
      where de_email = v_doador and not movido
      order by (case when v_ano is not null and eh_ano then 0 else 1 end), valor desc
      limit 1;
    exit when v_cS is null;
    update _pool set movido=true, para_email=v_receptor,
           para_nome=(select op_nome from _op where op_email=v_receptor),
           motivo = 'Nivelamento de quantidade (alvo '||round(v_alvo)||', teto '||v_teto||')'
             || case when v_ano is not null and v_cS.eh_ano then ' — dívida '||v_ano else '' end
      where caso_id = v_cS.caso_id;
    update _op set qtd=qtd-1, saldo=saldo-v_cS.valor where op_email=v_doador;
    update _op set qtd=qtd+1, saldo=saldo+v_cS.valor where op_email=v_receptor;
    v_movs := v_movs + 1;
  end loop;

  -- ------------------------------------------------------------------
  -- FASE SALDO: trocas (mantém a contagem) até os saldos ficarem parecidos
  -- ------------------------------------------------------------------
  v_iter := 0;
  loop
    v_iter := v_iter + 1; exit when v_iter > v_max;
    exit when v_limite_mov is not null and v_movs >= v_limite_mov;
    select op_email into v_rich from _op order by saldo desc limit 1;
    select op_email into v_poor from _op order by saldo asc  limit 1;
    exit when v_rich = v_poor;
    v_gap := (select saldo from _op where op_email=v_rich)
           - (select saldo from _op where op_email=v_poor);
    exit when v_gap <= 0;
    select * into v_cH from _pool where de_email=v_rich and not movido order by valor desc limit 1;
    select * into v_cL from _pool where de_email=v_poor and not movido order by valor asc  limit 1;
    exit when v_cH is null or v_cL is null;
    v_delta := v_cH.valor - v_cL.valor;
    exit when v_delta <= 0;      -- nada a ganhar
    exit when v_delta >= v_gap;  -- a troca passaria do ponto (pioraria)
    update _pool set movido=true, para_email=v_poor,
           para_nome=(select op_nome from _op where op_email=v_poor),
           motivo='Troca por equilíbrio de saldo (maior valor)' where caso_id=v_cH.caso_id;
    update _pool set movido=true, para_email=v_rich,
           para_nome=(select op_nome from _op where op_email=v_rich),
           motivo='Troca por equilíbrio de saldo (menor valor)' where caso_id=v_cL.caso_id;
    update _op set saldo=saldo - v_delta where op_email=v_rich;
    update _op set saldo=saldo + v_delta where op_email=v_poor;
    v_movs := v_movs + 2;
  end loop;

  v_id_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _op));
  v_id_sal := public.calibragem_indice_equilibrio(array(select saldo from _op));

  select jsonb_build_object(
    'criterio', p_criterio, 'metrica', '500', 'ano', v_ano, 'teto', v_teto,
    'alvo', round(v_alvo),
    'indice_antes', v_ia_sal, 'indice_depois', v_id_sal,
    'indice_qtd_antes', v_ia_qtd, 'indice_qtd_depois', v_id_qtd,
    'antes', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op_antes),
    'depois',(select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object('caso_id',caso_id,'cpf',cpf,'nome',nome,'valor',valor,'de_email',de_email,'de_nome',de_nome,'para_email',para_email,'para_nome',para_nome,'motivo',motivo) order by de_email, valor desc),'[]') from _pool where movido),
    'total_movimentacoes', (select count(*) from _pool where movido)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt() ->> 'email','server'), coalesce(auth.jwt() ->> 'email','server'), p_criterio, v_resultado, 'RASCUNHO')
  returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $$;

revoke all on function public.calibragem_simular_500(jsonb) from public;
grant execute on function public.calibragem_simular_500(jsonb) to authenticated;

commit;
