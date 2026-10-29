-- P0 Saldo zerado fora das filas -- FASE 2/C + FASE 3: reconciliacao idempotente.
--
-- Depende de:
--   20260724170000_saldo_operacional_zerado_real.sql (caso_saldo_zerado_real)
--   20260724180000_retirar_zerados_reais.sql          (retirar_zerados_reais_sem_saldo)
--   20260729193000_saldo_zero_confirmacao_e_guards.sql (encaminhar_saldo_zerado_confirmacao)
--
-- O que faz:
--   1) Passa a ENCAMINHAR para a fila oficial de Confirmacao (idempotente) sempre
--      que um caso atribuido e retirado por saldo zero real (reuso do ponto de
--      reconciliacao ja existente -- avaliar_quitacao_aluno / liberar_caso_por_evento
--      chamam retirar_zerados_reais_sem_saldo).
--   2) Adiciona uma rotina de reconciliacao em lotes (reconciliar_saldo_zerado) que
--      cobre tambem o pool de LIVRES (nao atribuidos), com paginacao (p_limite),
--      sem duplicar solicitacoes, preservando responsavel e historico.
--
-- NAO cria pagamento/baixa/comprovante. NAO quita. NAO apaga. NAO instala pg_cron
-- (a frequencia/custo serao apresentados e validados manualmente antes). Idempotente.
-- Rollback: supabase/rollbacks/20260729194000_saldo_zero_reconciliacao_down.sql.

BEGIN;

-- ===========================================================================
-- 1) retirar_zerados_reais_sem_saldo: mesma logica de marcacao (SEM_SALDO,
--    preservando responsavel/historico) + ENCAMINHAMENTO idempotente a Confirmacao.
--    Unica alteracao vs. a versao 20260724180000: a chamada a
--    internal.encaminhar_saldo_zerado_confirmacao apos registrar o historico.
-- ===========================================================================
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

    update public.casos
       set status_acionamento = v_novo,
           caso_atualizado_por = 'sistema_zerado_real', caso_atualizado_em = now()
     where id = r.id;

    if r.aid is not null then
      update public.alunos
         set status_jornada = v_novo, status_atual = v_novo, status_acionamento = v_novo,
             registrado_por_email = 'sistema_zerado_real', registrado_em = now()
       where id = r.aid;
    end if;

    insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values (coalesce(r.aid, r.aluno_id)::text, 'ZERADO_REAL_SEM_SALDO',
            'Sem saldo em aberto (fonte unica): retirado da fila ativa. Matricula '||coalesce(r.matricula,'-')||'. Sem baixa/quitacao.',
            coalesce(r.st_ant,'(sem)'), v_novo, 'Sistema', 'sistema_zerado_real', now());

    insert into public.historico_operadores_alunos (aluno_id, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
    select r.aid, c.nome, c.cpf, 'ZERADO_REAL_SEM_SALDO', c.operador_nome, c.operador_email,
           'Retirado da fila por saldo zero real. Responsavel preservado.', now()
    from public.casos c where c.id = r.id;

    -- NOVO: encaminha uma unica vez para a fila oficial de Confirmacao (idempotente).
    perform internal.encaminhar_saldo_zerado_confirmacao(coalesce(r.aid, r.aluno_id));

    caso_id := r.id; aluno_id := r.aid; matricula := r.matricula; status_anterior := coalesce(r.st_ant,'(sem)'); status_novo := v_novo;
    v_n := v_n + 1;
    return next;
  end loop;
end;
$function$;

-- ===========================================================================
-- 2) reconciliar_saldo_zerado: rotina em lotes, idempotente.
--    p_limite         -> teto de casos processados nesta chamada (paginacao).
--    p_incluir_livres -> tambem trata o pool de nao-atribuidos (LIVRES).
--    p_aluno_id       -> restringe a um aluno (uso pontual).
--    Retorna cada caso tratado. Reexecucoes nao duplicam solicitacoes nem
--    reprocessam quem ja esta SEM_SALDO.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.reconciliar_saldo_zerado(p_limite int DEFAULT NULL, p_incluir_livres boolean DEFAULT false, p_aluno_id uuid DEFAULT NULL)
RETURNS TABLE(escopo text, caso_id uuid, aluno_id uuid, status_novo text, solicitacao_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  r record;
  v_novo text := 'SEM_SALDO_EM_ABERTO';
  v_restante int := coalesce(p_limite, 2147483647);
  v_sol uuid;
begin
  -- ---- ATRIBUIDOS: reaproveita a rotina existente (marca + encaminha) ----
  for r in
    select * from public.retirar_zerados_reais_sem_saldo(p_aluno_id, case when p_limite is null then null else v_restante end)
  loop
    escopo := 'ATRIBUIDO'; caso_id := r.caso_id; aluno_id := r.aluno_id; status_novo := r.status_novo;
    select s.id into solicitacao_id from public.solicitacoes_confirmacao_pagamento s
     where s.aluno_id = coalesce(r.aluno_id::text, '') and s.motivo='SALDO_ZERADO_IDENTIFICADO' and s.status='AGUARDANDO_CONFIRMACAO'
     order by s.criado_em desc limit 1;
    v_restante := v_restante - 1;
    return next;
  end loop;

  if not p_incluir_livres then return; end if;

  -- ---- LIVRES (pool nao atribuido): bloqueia da distribuicao + encaminha ----
  for r in
    select c.id, c.aluno_id, c.matricula, c.status_acionamento AS st_ant,
           internal.resolver_aluno_por_matricula(c.aluno_id, c.matricula) AS aid
    from public.casos c
    where c.operador_email is null
      and c.quitado_em is null
      and (p_aluno_id is null or c.aluno_id = p_aluno_id)
      and coalesce(c.status_acionamento,'') not ilike '%CANCEL%'
      and coalesce(c.status_acionamento,'') not ilike '%JURIDIC%'
      and public.normalizar_status_acionamento(c.status_acionamento) <> 'SEM SALDO EM ABERTO'
      and public.caso_saldo_zerado_real(c.aluno_id, c.matricula)
  loop
    exit when v_restante <= 0;

    update public.casos
       set status_acionamento = v_novo,
           caso_atualizado_por = 'sistema_zerado_real', caso_atualizado_em = now()
     where id = r.id;

    if r.aid is not null then
      update public.alunos
         set status_jornada = v_novo, status_atual = v_novo, status_acionamento = v_novo,
             registrado_por_email = 'sistema_zerado_real', registrado_em = now()
       where id = r.aid;
    end if;

    insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values (coalesce(r.aid, r.aluno_id)::text, 'ZERADO_REAL_SEM_SALDO',
            'Sem saldo em aberto (fonte unica): bloqueado da distribuicao (pool livre). Matricula '||coalesce(r.matricula,'-')||'. Sem baixa/quitacao.',
            coalesce(r.st_ant,'(sem)'), v_novo, 'Sistema', 'sistema_zerado_real', now());

    v_sol := internal.encaminhar_saldo_zerado_confirmacao(coalesce(r.aid, r.aluno_id));

    escopo := 'LIVRE'; caso_id := r.id; aluno_id := coalesce(r.aid, r.aluno_id); status_novo := v_novo; solicitacao_id := v_sol;
    v_restante := v_restante - 1;
    return next;
  end loop;
end;
$function$;

REVOKE ALL ON FUNCTION public.reconciliar_saldo_zerado(int, boolean, uuid) FROM PUBLIC;

COMMIT;
