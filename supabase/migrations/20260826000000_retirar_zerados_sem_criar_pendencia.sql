-- PREMISSA: não tem dívida, sai da operação -- e sem virar retrabalho.
--
-- Medido em prod (2026-08-25): 259 casos com saldo real ZERO ainda estavam na
-- mão de 10 operadores; 199 deles nem marcados como sem saldo -- o operador via
-- como trabalho normal.
--
-- Já existia public.retirar_zerados_reais_sem_saldo, que faz o essencial. Só que
-- ela termina com `perform internal.encaminhar_saldo_zerado_confirmacao(...)`,
-- que CRIA uma solicitação AGUARDANDO_CONFIRMACAO para cada caso. Rodando nos
-- 259, o trabalho não sumiria: mudaria da fila do operador para a fila de
-- confirmação. Testado em 5 casos e revertido na hora -- Gabriele e Selso, já
-- conferidos como zerados, voltaram como pendência.
--
-- Esta versão faz o mesmo que a original MENOS essa linha. Nada mais muda:
--   - mesma fonte de verdade do saldo (caso_saldo_zerado_real);
--   - mesmas exclusões (CANCELADO, JURÍDICO, já quitado, já marcado);
--   - mesmo registro em aluno_movimentacoes e historico_operadores_alunos;
--   - RESPONSÁVEL PRESERVADO, como em todo o resto do CRM: o caso sai das filas
--     de trabalho pelo status, mas continua sabendo de quem era. Apagar o
--     operador quebraria histórico e atribuição de fechamento.
--   - NÃO dá baixa e NÃO quita: o saldo já é zero, não há o que baixar.
--
-- Rollback: supabase/rollbacks/20260826000000_retirar_zerados_sem_criar_pendencia.rollback.sql

create or replace function public.retirar_zerados_da_operacao(
    p_aluno_id uuid default null,
    p_limite   integer default null,
    p_dry_run  boolean default true
  )
  returns table(caso_id uuid, aluno_id uuid, matricula text, operador_email text,
                status_anterior text, status_novo text)
  language plpgsql
  security definer
  set search_path to 'public'
  set statement_timeout to '180s'
as $function$
declare
  r record;
  v_novo text := 'SEM_SALDO_EM_ABERTO';
  v_n int := 0;
begin
  if not public.usuario_e_gestao_fila() then
    raise exception 'Usuario nao autorizado.' using errcode = '42501';
  end if;

  for r in
    select c.id, c.aluno_id as caso_aluno, c.matricula, c.operador_email as op,
           c.status_acionamento as st_ant,
           internal.resolver_aluno_por_matricula(c.aluno_id, c.matricula) as aid
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

    if not p_dry_run then
      update public.casos
         set status_acionamento = v_novo,
             caso_atualizado_por = 'sistema_zerado_sem_pendencia',
             caso_atualizado_em = now()
       where id = r.id;

      if r.aid is not null then
        update public.alunos
           set status_jornada = v_novo, status_atual = v_novo, status_acionamento = v_novo,
               fila_destino = null, proxima_acao = null,
               registrado_por_email = 'sistema_zerado_sem_pendencia', registrado_em = now()
         where id = r.aid;
      end if;

      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em)
      values
        (coalesce(r.aid, r.caso_aluno)::text, 'ZERADO_REAL_SEM_SALDO',
         'Sem saldo em aberto (fonte unica): retirado das filas. Matricula '
           || coalesce(r.matricula,'-') || '. Sem baixa, sem quitacao e SEM criar pendencia de confirmacao.',
         coalesce(r.st_ant,'(sem)'), v_novo, 'Sistema', 'sistema_zerado_sem_pendencia', now());

      insert into public.historico_operadores_alunos
        (aluno_id, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
      select r.aid, c.nome, c.cpf, 'ZERADO_REAL_SEM_SALDO', c.operador_nome, c.operador_email,
             'Retirado das filas por saldo zero real. Responsavel preservado. Sem pendencia criada.', now()
        from public.casos c where c.id = r.id;
    end if;

    caso_id := r.id; aluno_id := r.aid; matricula := r.matricula; operador_email := r.op;
    status_anterior := coalesce(r.st_ant,'(sem)'); status_novo := v_novo;
    v_n := v_n + 1;
    return next;
  end loop;
end;
$function$;

revoke all on function public.retirar_zerados_da_operacao(uuid, integer, boolean) from public, anon;
grant execute on function public.retirar_zerados_da_operacao(uuid, integer, boolean) to authenticated, service_role;
