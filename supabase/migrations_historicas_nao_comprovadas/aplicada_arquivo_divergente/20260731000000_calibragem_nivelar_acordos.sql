-- ============================================================================
-- CALIBRAGEM — NIVELAR ACORDOS (equiparar quantidade de acordos por operador)
-- ----------------------------------------------------------------------------
-- Move acordos ATIVO de quem tem muitos para quem tem poucos, equiparando a
-- QUANTIDADE. Separado do executor de mensalidades (casos) — acordos têm dono
-- próprio (operador_responsavel_email) e carregam comissão/responsabilidade.
--
--   calibragem_simular_acordos(criterio)  -> RASCUNHO em calibragem_simulacoes
--   calibragem_executar_acordos(id)       -> move acordos + auditoria
--   (aprovação reusa calibragem_aprovar_simulacao)
--
-- Ordena a SAÍDA pelos acordos de MENOR saldo primeiro (menor impacto de
-- comissão). Não há teto de 500 para acordos. Reversível.
-- ============================================================================

begin;

create or replace function public.calibragem_simular_acordos(p_criterio jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ops text[]; v_sim_id uuid; v_target numeric;
  v_resultado jsonb; v_indice_antes numeric; v_indice_depois numeric;
  r record; rec_op text; v_best_deficit numeric; v_best text;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para simular acordos.'; end if;
  if p_criterio ? 'operadores' then v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores')); end if;

  create temp table _opa on commit drop as
    select a.operador_responsavel_email op_email, max(a.operador_responsavel_nome) op_nome, count(*)::numeric qtd
    from public.acordos a
    where a.operador_responsavel_email is not null and upper(coalesce(a.status,''))='ATIVO'
      and (v_ops is null or a.operador_responsavel_email = any(v_ops))
    group by a.operador_responsavel_email;
  create temp table _opa_antes on commit drop as select * from _opa;

  create temp table _poola on commit drop as
    select a.id acordo_id, a.operador_responsavel_email de_email, a.operador_responsavel_nome de_nome,
           a.cpf, coalesce(a.saldo,0) valor,
           (select max(coalesce(c.nome,c.nome_aluno)) from public.casos c where c.aluno_id=a.aluno_id) nome,
           row_number() over (partition by a.operador_responsavel_email order by coalesce(a.saldo,0) asc, a.criado_em desc) rn,
           false movido, null::text para_email, null::text para_nome, null::text motivo
    from public.acordos a
    where a.operador_responsavel_email is not null and upper(coalesce(a.status,''))='ATIVO'
      and (v_ops is null or a.operador_responsavel_email = any(v_ops));

  select avg(qtd) into v_target from _opa;
  v_indice_antes := public.calibragem_indice_equilibrio(array(select qtd from _opa));

  for r in
    select p.* from _poola p join _opa o on o.op_email=p.de_email
    where o.qtd > v_target order by o.qtd desc, p.de_email, p.rn
  loop
    if (select qtd from _opa where op_email=r.de_email) <= v_target then continue; end if;
    v_best := null; v_best_deficit := 0;
    for rec_op in select op_email from _opa where op_email <> r.de_email loop
      declare v_q numeric; v_def numeric;
      begin
        select qtd into v_q from _opa where op_email=rec_op;
        v_def := v_target - v_q;
        if v_def > v_best_deficit then v_best_deficit := v_def; v_best := rec_op; end if;
      end;
    end loop;
    if v_best is null then continue; end if;
    update _poola set movido=true, para_email=v_best, para_nome=(select op_nome from _opa where op_email=v_best),
           motivo='Nivelamento de quantidade de acordos' where acordo_id=r.acordo_id;
    update _opa set qtd=qtd-1 where op_email=r.de_email;
    update _opa set qtd=qtd+1 where op_email=v_best;
  end loop;

  v_indice_depois := public.calibragem_indice_equilibrio(array(select qtd from _opa));

  select jsonb_build_object(
    'criterio', p_criterio, 'metrica', 'ACORDOS', 'alvo', round(v_target,1),
    'indice_antes', v_indice_antes, 'indice_depois', v_indice_depois,
    'antes', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',0) order by op_nome),'[]') from _opa_antes),
    'depois',(select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',0) order by op_nome),'[]') from _opa),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object('acordo_id',acordo_id,'cpf',cpf,'nome',coalesce(nome,cpf),'valor',round(valor,2),'de_email',de_email,'de_nome',de_nome,'para_email',para_email,'para_nome',para_nome,'motivo',motivo) order by de_email, valor asc),'[]') from _poola where movido),
    'total_movimentacoes', (select count(*) from _poola where movido)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt() ->> 'email','server'), coalesce(auth.jwt() ->> 'email','server'), p_criterio, v_resultado, 'RASCUNHO')
  returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $$;
revoke all on function public.calibragem_simular_acordos(jsonb) from public;
grant execute on function public.calibragem_simular_acordos(jsonb) to authenticated;

create or replace function public.calibragem_executar_acordos(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_exec int := 0; v_pul int := 0; r record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar acordos.'; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status <> 'APROVADA' then raise exception 'Simulação precisa estar APROVADA (atual: %).', v_sim.status; end if;
  if upper(coalesce(v_sim.resultado->>'metrica','')) <> 'ACORDOS' then raise exception 'Esta simulação não é de acordos.'; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_acordos'));

  for r in select * from jsonb_array_elements(v_sim.resultado->'movimentacoes') m,
                        lateral (select (m->>'acordo_id')::uuid acordo_id, m->>'de_email' de_email, m->>'para_email' para_email,
                                        m->>'para_nome' para_nome, m->>'de_nome' de_nome, (m->>'valor')::numeric valor, m->>'cpf' cpf, m->>'nome' nome) x
  loop
    -- revalida: acordo ainda ATIVO e do doador previsto
    if not exists (select 1 from public.acordos a where a.id=r.acordo_id and a.operador_responsavel_email=r.de_email and upper(coalesce(a.status,''))='ATIVO') then
      v_pul := v_pul + 1; continue;
    end if;
    update public.acordos set operador_responsavel_email=r.para_email, operador_responsavel_nome=r.para_nome, atualizado_em=now()
      where id=r.acordo_id;
    insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, cpf, nome_aluno,
      operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
      valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
    values ('MOVIMENTACAO_NIVELAMENTO_ACORDO', p_id, r.acordo_id, r.cpf, r.nome, r.de_email, r.de_nome, r.para_email, r.para_nome,
      r.valor, r.motivo, 'ACORDOS',
      jsonb_build_object('acordo_id', r.acordo_id, 'operador_email', r.de_email),
      jsonb_build_object('acordo_id', r.acordo_id, 'operador_email', r.para_email),
      v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email);
    v_exec := v_exec + 1;
  end loop;

  update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'EXECUTADA', 'executados', v_exec, 'pulados', v_pul);
end; $$;
revoke all on function public.calibragem_executar_acordos(uuid) from public;
grant execute on function public.calibragem_executar_acordos(uuid) to authenticated;

commit;
