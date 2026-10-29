-- ============================================================================
-- CALIBRAGEM — APROVAR + EXECUTOR TRANSACIONAL (itens 2.3 / 2.4 / 3.3 / 14)
-- ----------------------------------------------------------------------------
-- Fluxo: simular (RASCUNHO) -> calibragem_aprovar_simulacao (APROVADA)
--        -> calibragem_executar_simulacao (EXECUTADA, move casos).
--
-- Responsabilidade automática (2.4): ao executar, o caso é gravado direto no
-- novo operador — sem etapa manual. Transacional: tudo numa função (rollback
-- total se qualquer passo falhar). Revalida elegibilidade no momento da
-- execução (o caso pode ter mudado de dono desde a simulação -> é pulado).
--
-- Interação com triggers existentes de `casos` (crítica):
--   * two-phase (zera operador de TODOS os casos, depois atribui) para nunca
--     exceder 500 e não disparar trg_impor_teto_operador no meio da troca;
--   * só altera operador_email/nome/operador + colunas de marcador novas
--     (não toca colunas restritas -> não é barrado por bloquear_alteracoes);
--   * a sincronização casos->alunos ocorre pelo gatilho já existente.
--
-- Marcador "Retirado por nivelamento" (3.3) em colunas novas de `casos`.
-- Auditoria completa em calibragem_auditoria (append-only).
-- Reversível (drop functions + drop columns).
-- ============================================================================

begin;

-- Colunas de marcador (aditivas) --------------------------------------------
alter table public.casos add column if not exists nivelamento_marcador text;
alter table public.casos add column if not exists nivelamento_em timestamptz;
alter table public.casos add column if not exists nivelamento_simulacao_id uuid;

-- APROVAR --------------------------------------------------------------------
create or replace function public.calibragem_aprovar_simulacao(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_email text := coalesce(auth.jwt() ->> 'email','server'); v_status text;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para aprovar a Calibragem.';
  end if;
  select status into v_status from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_status <> 'RASCUNHO' then raise exception 'Só é possível aprovar uma simulação RASCUNHO (atual: %).', v_status; end if;
  update public.calibragem_simulacoes
     set status='APROVADA', aprovado_por_email=v_email, aprovado_por_nome=v_email, aprovado_em=now()
   where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'APROVADA');
end; $$;
revoke all on function public.calibragem_aprovar_simulacao(uuid) from public;
grant execute on function public.calibragem_aprovar_simulacao(uuid) to authenticated;

-- EXECUTAR (transacional) ----------------------------------------------------
create or replace function public.calibragem_executar_simulacao(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_executados int := 0; v_pulados int := 0; r record;
  v_op_atual text; v_protegido boolean; v_aluno uuid;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para executar a Calibragem.';
  end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status <> 'APROVADA' then raise exception 'Simulação precisa estar APROVADA (atual: %).', v_sim.status; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_simulacao'));

  -- carrega as movimentações e revalida elegibilidade AGORA
  create temp table _exec on commit drop as
  select (m->>'caso_id')::uuid caso_id, m->>'de_email' de_email, m->>'de_nome' de_nome,
         m->>'para_email' para_email, m->>'para_nome' para_nome,
         (m->>'valor')::numeric valor, m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome,
         false as valido
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;

  update _exec e set valido = true
  from public.casos c
  where c.id = e.caso_id
    and c.operador_email = e.de_email  -- ainda pertence ao doador previsto
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  select count(*) filter (where not valido) into v_pulados from _exec;

  -- FASE A: zera o operador de todos os casos válidos (evita >500 transitório)
  update public.casos c
     set operador_email = null, operador_nome = null, operador = null,
         nivelamento_marcador = 'Retirado por nivelamento',
         nivelamento_em = now(), nivelamento_simulacao_id = p_id
    from _exec e
   where e.valido and c.id = e.caso_id;

  -- FASE B: atribui ao novo operador (responsabilidade automática, item 2.4)
  update public.casos c
     set operador_email = e.para_email,
         operador_nome  = e.para_nome,
         operador       = upper(coalesce(e.para_nome, ''))
    from _exec e
   where e.valido and c.id = e.caso_id;

  -- auditoria completa (item 3.3 / 14) — 1 registro por caso movido
  for r in select * from _exec where valido loop
    select c.aluno_id into v_aluno from public.casos c where c.id = r.caso_id;
    insert into public.calibragem_auditoria(
      evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
      operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
      valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
      aprovado_por_email, aprovado_por_nome, registrado_por_email)
    values (
      'MOVIMENTACAO_NIVELAMENTO', p_id, r.caso_id, v_aluno, r.cpf, r.nome,
      r.de_email, r.de_nome, r.para_email, r.para_nome,
      r.valor, r.motivo, upper(coalesce(v_sim.resultado->>'metrica','SALDO')),
      jsonb_build_object('operador_email', r.de_email, 'operador_nome', r.de_nome),
      jsonb_build_object('operador_email', r.para_email, 'operador_nome', r.para_nome, 'marcador','Retirado por nivelamento'),
      v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email);
    v_executados := v_executados + 1;
  end loop;

  update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;

  return jsonb_build_object('id', p_id, 'status', 'EXECUTADA',
    'executados', v_executados, 'pulados', v_pulados);
end; $$;
revoke all on function public.calibragem_executar_simulacao(uuid) from public;
grant execute on function public.calibragem_executar_simulacao(uuid) to authenticated;

commit;
