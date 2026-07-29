-- Rollback de 20260729194000_saldo_zero_reconciliacao.sql
-- Remove a rotina em lotes e restaura retirar_zerados_reais_sem_saldo SEM o
-- encaminhamento a Confirmacao (estado da migration 20260724180000).
BEGIN;

DROP FUNCTION IF EXISTS public.reconciliar_saldo_zerado(int, boolean, uuid);

CREATE OR REPLACE FUNCTION public.retirar_zerados_reais_sem_saldo(p_aluno_id uuid DEFAULT NULL, p_limite int DEFAULT NULL)
RETURNS TABLE(caso_id uuid, aluno_id uuid, matricula text, status_anterior text, status_novo text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare r record; v_novo text := 'SEM_SALDO_EM_ABERTO'; v_n int := 0;
begin
  for r in
    select c.id, c.aluno_id, c.matricula, c.status_acionamento AS st_ant,
           internal.resolver_aluno_por_matricula(c.aluno_id, c.matricula) AS aid
    from public.casos c
    where c.operador_email is not null
      and c.quitado_em is null
      and (p_aluno_id is null or c.aluno_id = p_aluno_id)
      and coalesce(c.status_acionamento,'') not ilike '%CANCEL%'
      and coalesce(c.status_acionamento,'') not ilike '%JURIDIC%'
      and public.normalizar_status_acionamento(c.status_acionamento) <> 'SEM SALDO EM ABERTO'
      and public.caso_saldo_zerado_real(c.aluno_id, c.matricula)
  loop
    exit when p_limite is not null and v_n >= p_limite;
    update public.casos set status_acionamento = v_novo, caso_atualizado_por = 'sistema_zerado_real', caso_atualizado_em = now() where id = r.id;
    if r.aid is not null then
      update public.alunos set status_jornada = v_novo, status_atual = v_novo, status_acionamento = v_novo, registrado_por_email = 'sistema_zerado_real', registrado_em = now() where id = r.aid;
    end if;
    insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values (coalesce(r.aid, r.aluno_id)::text, 'ZERADO_REAL_SEM_SALDO', 'Sem saldo em aberto (fonte unica): retirado da fila ativa. Matricula '||coalesce(r.matricula,'-')||'. Sem baixa/quitacao.', coalesce(r.st_ant,'(sem)'), v_novo, 'Sistema', 'sistema_zerado_real', now());
    insert into public.historico_operadores_alunos (aluno_id, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
    select r.aid, c.nome, c.cpf, 'ZERADO_REAL_SEM_SALDO', c.operador_nome, c.operador_email, 'Retirado da fila por saldo zero real. Responsavel preservado.', now() from public.casos c where c.id = r.id;
    caso_id := r.id; aluno_id := r.aid; matricula := r.matricula; status_anterior := coalesce(r.st_ant,'(sem)'); status_novo := v_novo;
    v_n := v_n + 1;
    return next;
  end loop;
end;
$function$;

COMMIT;
