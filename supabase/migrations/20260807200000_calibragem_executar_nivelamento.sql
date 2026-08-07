-- Executor DEDICADO do nivelamento (pool). Igual a calibragem_executar_simulacao,
-- mas com validação NULL-SAFE (c.operador_email IS NOT DISTINCT FROM de_email) para
-- aceitar casos vindos do POOL (de_email NULL) — que o executor original pulava.
-- Isolado: não afeta os outros fluxos de calibragem. Two-phase, advisory lock,
-- auditoria append-only, gate gestão. Aplicada em prod via MCP em 2026-08-07 (dormente:
-- só roda quando uma simulação de nivelamento é APROVADA e o executor é chamado).
CREATE OR REPLACE FUNCTION public.calibragem_executar_nivelamento(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_executados int := 0; v_pulados int := 0; r record; v_aluno uuid;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar a Calibragem.'; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status <> 'APROVADA' then raise exception 'Simulação precisa estar APROVADA (atual: %).', v_sim.status; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));
  create temp table _exec on commit drop as
  select (m->>'caso_id')::uuid caso_id, m->>'de_email' de_email, m->>'de_nome' de_nome,
         m->>'para_email' para_email, m->>'para_nome' para_nome, (m->>'valor')::numeric valor,
         m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome, false as valido
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;
  update _exec e set valido = true from public.casos c
  where c.id = e.caso_id and c.operador_email is not distinct from e.de_email
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);
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
      r.valor, r.motivo, upper(coalesce(v_sim.resultado->>'metrica','NIVELAMENTO_500')),
      jsonb_build_object('operador_email', r.de_email, 'operador_nome', r.de_nome),
      jsonb_build_object('operador_email', r.para_email, 'operador_nome', r.para_nome, 'marcador','Retirado por nivelamento'),
      v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email);
    v_executados := v_executados + 1;
  end loop;
  update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'EXECUTADA', 'executados', v_executados, 'pulados', v_pulados);
end; $function$;

REVOKE ALL ON FUNCTION public.calibragem_executar_nivelamento(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.calibragem_executar_nivelamento(uuid) TO authenticated, service_role;
