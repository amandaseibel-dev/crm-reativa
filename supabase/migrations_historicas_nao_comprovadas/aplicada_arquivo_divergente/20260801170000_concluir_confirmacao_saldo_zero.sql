-- Botao "Concluir como saldo zero" na aba "Confirmacao de Acordo sem valor".
--
-- Contexto: sobraram confirmacoes AGUARDANDO_CONFIRMACAO de acordos SEM VALOR
-- (valor_informado=0 e valor_entrada=0). O caso ja foi retirado das filas
-- operacionais (operador nulo, aluno com saldo 0), mas a solicitacao de
-- confirmacao continua aberta, sem forma de conclui-la -- fica presa na fila.
--
-- Esta RPC conclui UMA confirmacao (pelo id), SEM mexer de novo em carteira/
-- filas (isso ja ocorreu). Fluxo:
--   1) exige motivo;
--   2) roda a validacao de saldo zero ja criada (caso_saldo_operacional ->> total):
--      o saldo financeiro real (mensalidades + parcelas), IGNORANDO a propria
--      confirmacao pendente, precisa ser 0. Isso bloqueia os casos que ainda
--      tem mensalidade/parcela real em aberto;
--   3) muda a confirmacao para CONCLUIDA_SALDO_ZERO (encerra a solicitacao);
--   4) preserva financeiro e historico (nada apagado) + auditoria.
-- Idempotente (lock + checagem de status). Somente Amanda, Fernanda e Amanda ADM.

create or replace function public.concluir_confirmacao_saldo_zero(p_confirmacao_id uuid, p_motivo text)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_sol   record;
  v_alu   record;
  v_total numeric;
  v_nome  text;
begin
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then
    raise exception 'Sem permissao: apenas Amanda, Fernanda ou Amanda ADM podem concluir como saldo zero.' using errcode='42501';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatorio para concluir como saldo zero.' using errcode='22023';
  end if;
  if p_confirmacao_id is null then raise exception 'confirmacao_id nulo.'; end if;

  -- Trava a linha da solicitacao (idempotencia / anti duplo clique).
  select * into v_sol
  from public.solicitacoes_confirmacao_pagamento
  where id = p_confirmacao_id
  for update;

  if not found then
    raise exception 'Solicitacao de confirmacao nao encontrada.' using errcode='P0002';
  end if;

  -- Ja concluida: nao faz nada (idempotente).
  if v_sol.status = 'CONCLUIDA_SALDO_ZERO' then
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_sol.status);
  end if;

  -- So conclui o que ainda esta aberto.
  if v_sol.status not in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO') then
    raise exception 'Confirmacao ja encerrada (status %). Nao pode concluir como saldo zero.', v_sol.status using errcode='22023';
  end if;

  if v_sol.aluno_id is null then
    raise exception 'Confirmacao sem aluno vinculado.' using errcode='22023';
  end if;

  select id, nome, matricula into v_alu from public.alunos where id = v_sol.aluno_id::uuid;
  if not found then
    raise exception 'Aluno da confirmacao nao encontrado.' using errcode='P0002';
  end if;

  -- 2) Validacao de saldo zero ja criada: saldo financeiro real (sem contar a
  --    propria confirmacao pendente) precisa ser 0.
  v_total := coalesce((public.caso_saldo_operacional(v_alu.id, v_alu.matricula) ->> 'total')::numeric, 0);
  if v_total > 0.005 then
    raise exception 'Aluno ainda tem saldo real em aberto (%). Nao pode concluir como saldo zero.',
      to_char(v_total, 'FM999G999G990D00') using errcode='22023';
  end if;

  -- 3) Encerra a solicitacao como CONCLUIDA_SALDO_ZERO (sai da fila).
  update public.solicitacoes_confirmacao_pagamento set
     status = 'CONCLUIDA_SALDO_ZERO',
     observacao_adm = coalesce(observacao_adm,'') || case when coalesce(observacao_adm,'')='' then '' else ' | ' end
                      || 'Concluida como saldo zero: ' || p_motivo,
     confirmado_por = v_email,
     confirmado_em  = now(),
     atualizado_em  = now()
   where id = p_confirmacao_id;

  -- 4) Auditoria + historico (financeiro preservado; nada apagado).
  insert into public.saldo_zero_confirmado_auditoria
    (aluno_id, motivo, operador_anterior_email, responsavel_anterior_email, valor_em_aberto_anterior, executado_por)
  values (v_alu.id, 'Conclusao de confirmacao sem valor (saldo zero): ' || p_motivo,
          v_sol.operador_email, v_sol.operador_email, 0, v_email);

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
  values (v_sol.aluno_id, 'CONFIRMACAO_CONCLUIDA_SALDO_ZERO',
          'Confirmacao de acordo sem valor concluida como saldo zero (financeiro preservado). Motivo: ' || p_motivo,
          'CONCLUIDA_SALDO_ZERO', coalesce(v_alu.nome, v_email), v_email, now());

  return jsonb_build_object('ok', true, 'ja_processado', false,
                            'confirmacao_id', p_confirmacao_id, 'status', 'CONCLUIDA_SALDO_ZERO');
end; $$;

revoke all on function public.concluir_confirmacao_saldo_zero(uuid,text) from public, anon, authenticated;
grant execute on function public.concluir_confirmacao_saldo_zero(uuid,text) to authenticated, service_role;
