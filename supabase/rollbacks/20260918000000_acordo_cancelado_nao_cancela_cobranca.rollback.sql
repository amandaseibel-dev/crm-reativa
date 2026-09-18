-- ROLLBACK de 20260918000000_acordo_cancelado_nao_cancela_cobranca.
--
-- Devolve as tres funcoes ao corpo que estava em producao em 17/09/2026.
-- NAO derruba public.cobranca_nao_reabrir: a tabela guarda decisao de gestao e
-- perde-la seria perder informacao que a migration nao criou, so mudou de casa.
-- Depois deste rollback, casos com status_acionamento='ACORDO_CANCELADO'
-- gravados pela versao nova continuam na fila (o valor novo nunca bloqueou);
-- quem voltou a cobrar NAO e reencerrado automaticamente.

begin;

create or replace function public.liberar_caso_por_evento(
  p_aluno_id uuid, p_evento text, p_valor_pago numeric default null::numeric,
  p_data_pagamento date default current_date)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_det jsonb;
begin
  IF p_evento = 'LINK_PAGO' THEN
    v_det := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);
    IF (v_det ->> 'tem_pendencia')::boolean THEN
      insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe)
      values (p_aluno_id, 'LINK_PAGAMENTO', (v_det ->> 'total')::numeric, v_det);
      RETURN;
    END IF;
    UPDATE public.casos
    SET status_financeiro = 'QUITADO_LINK_PAGAMENTO', quitado_em = p_data_pagamento,
        valor_quitado = COALESCE(p_valor_pago, 0), origem_quitacao = 'LINK_PAGAMENTO',
        caso_atualizado_por = 'sistema_link_pagamento', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'CANCELADO' THEN
    UPDATE public.casos
    SET status_acionamento = 'CANCELADO', caso_atualizado_por = 'sistema_cancelamento_acordo', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
    PERFORM public.retirar_zerados_reais_sem_saldo(p_aluno_id, null);
  ELSIF p_evento = 'JURIDICO' THEN
    UPDATE public.casos
    SET status_acionamento = 'JURIDICO', caso_atualizado_por = 'sistema_juridico', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'ACORDO_MENSALIDADE_LIBERADA' THEN
    UPDATE public.casos
    SET status_acionamento = 'ACORDO FECHADO', caso_atualizado_por = 'sistema_acordo_fechado', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  END IF;
end;
$function$;

create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text,
  p_status_financeiro text, p_status_jornada text)
returns boolean language plpgsql stable set search_path to 'public'
as $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

create or replace function public.casos_reabrir_com_divida(p_limite integer default null::integer)
returns integer language plpgsql security definer set search_path to 'public'
set statement_timeout to '180s'
as $function$
declare
  v_bloq text[] := array['JURIDICO','CANCELAMENTO COBRANCA','SUSPENSAO COBRANCA',
                         'SUSPENSAO DE COBRANCA','CANCELADO'];
  v_n integer := 0;
  v_pulados integer := 0;
  v_falhas integer := 0;
  r record;
begin
  for r in
    select c.id, c.aluno_id, c.status_atual as st_ant
      from public.casos c
     where c.aluno_id is not null
       and (coalesce(c.encerrado_operacional, false)
            or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                                 c.status_financeiro, c.status_jornada))
       and not exists (
         select 1 from public.casos c2
          where c2.aluno_id = c.aluno_id and c2.id <> c.id
            and not coalesce(c2.encerrado_operacional, false))
       and public.normalizar_status_acionamento(coalesce(c.status_atual,''))       <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_acionamento,'')) <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_financeiro,''))  <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_jornada,''))     <> all(v_bloq)
       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'
       and not exists (select 1 from public.alunos al
                        where al.id = c.aluno_id
                          and upper(coalesce(al.status_atual,'')) ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO')
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric > 0.005
     limit coalesce(p_limite, 100000)
  loop
    if exists (
      select 1 from public.casos c2
       where c2.aluno_id = r.aluno_id and c2.id <> r.id
         and not coalesce(c2.encerrado_operacional, false)
         and public.caso_encerrado_operacional(c2.cpf, c2.status_atual, c2.status_acionamento,
                                               c2.status_financeiro, c2.status_jornada) = false
    ) then
      v_pulados := v_pulados + 1;
      continue;
    end if;

    begin
      update public.casos
         set status_atual = 'Em cobrança', status_acionamento = null, status_jornada = 'Em cobrança',
             status_financeiro = case
               when public.normalizar_status_acionamento(coalesce(status_financeiro,''))
                    in ('QUITADO','PAGO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                        'SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO')
                 then null else status_financeiro end,
             encerrado_operacional = false,
             caso_atualizado_por = 'sistema_reabrir_com_divida', caso_atualizado_em = now()
       where id = r.id;

      update public.alunos
         set status_atual = 'Em cobrança', status_jornada = 'Em cobrança', status_acionamento = null
       where id = r.aluno_id
         and upper(coalesce(status_atual,'')) !~ 'JURIDICO|CANCELAMENTO|SUSPENSAO';

      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em)
      values (r.aluno_id::text, 'REABERTURA_DIVIDA_NOVA',
              'Caso estava fora da base como "' || coalesce(r.st_ant,'(sem status)')
              || '" mas voltou a ter saldo em aberto. Devolvido para a fila.',
              coalesce(r.st_ant,'(sem)'), 'Em cobrança',
              'Sistema', 'sistema_reabrir_com_divida', now());

      perform public.recalcular_situacao_aluno(r.aluno_id, 'reabrir_com_divida');
      v_n := v_n + 1;
    exception when others then
      v_falhas := v_falhas + 1;
      raise warning 'casos_reabrir_com_divida: caso % do aluno % nao foi reaberto e foi pulado: %',
        r.id, r.aluno_id, sqlerrm;
    end;
  end loop;

  if v_pulados > 0 or v_falhas > 0 then
    raise warning 'casos_reabrir_com_divida: % reaberto(s), % pulado(s) por ja terem caso aberto, % com erro',
      v_n, v_pulados, v_falhas;
  end if;
  return v_n;
end;
$function$;

commit;
