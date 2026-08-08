-- Blindagem do executor de acoes massivas agendadas (cron job 9).
--
-- Contexto: incidente de 2026-08-07. O job 9 (schedule "* * * * *") NAO foi a
-- causa da queda (tabela de agendamentos vazia), mas roda a cada minuto sem
-- trava anti-sobreposicao e com retry que re-qualifica na hora. Quando houver
-- campanha grande, a query de elegibilidade e pesada e uma execucao pode passar
-- de 1 min -> execucoes sobrepostas -> risco de saturacao. Esta migration adiciona
-- guarda tripla SEM alterar a regra de negocio:
--   1) advisory lock: se ja houver execucao em andamento, retorna sem trabalhar.
--   2) statement_timeout proprio: a execucao nao pode correr solta.
--   3) respeita proxima_tentativa_em: campanha que falhou nao re-tenta antes da hora.
--
-- O job permanece DESLIGADO (active=false). Reativar so apos revisar o intervalo.

CREATE OR REPLACE FUNCTION public.acoes_massivas_executar_agendadas()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c record; a record;
  v_proc int := 0; v_camp int := 0;
  v_eleg int; v_excl int; v_env int; v_err int;
  v_motivo text; v_tipo text; v_retorno date := current_date + 10; v_ins uuid; v_maxtent int := 3;
begin
  if not public.acoes_massivas_e_executor_tecnico() then
    raise exception 'Executor restrito a service_role/pg_cron.' using errcode='42501';
  end if;

  -- GUARDA 1: advisory lock nao-bloqueante. Se outra execucao ja esta rodando,
  -- sai imediatamente em vez de empilhar (evita sobreposicao sob agenda "* * * * *").
  if not pg_try_advisory_xact_lock(hashtext('acoes_massivas_executar_agendadas')) then
    return jsonb_build_object('skipped', true, 'motivo', 'execucao_em_andamento');
  end if;

  -- GUARDA 2: teto de tempo proprio desta execucao (nao corre solto sob pressao).
  perform set_config('statement_timeout', '90000', true);

  for c in
    select * from public.acoes_massivas_agendamentos
     where status='AGENDADO' and programado_para <= now()
       -- GUARDA 3: nao re-qualifica antes da proxima tentativa agendada.
       and (proxima_tentativa_em is null or proxima_tentativa_em <= now())
     order by programado_para
     for update skip locked
     limit 10
  loop
    v_camp := v_camp + 1;
    update public.acoes_massivas_agendamentos
       set status='PROCESSANDO', iniciado_em=now(), executado_por='SISTEMA',
           executor_tecnico=coalesce(auth.role(), session_user), tentativa=tentativa+1
     where id=c.id;

    v_eleg:=0; v_excl:=0; v_env:=0; v_err:=0;
    v_tipo := case when c.canal='WHATSAPP' then 'ACAO_MASSIVA_EXTERNA' else 'ACAO_MASSIVA_EXTERNA_EMAIL' end;

    begin
      for a in
        with sol_conf as materialized (
          select distinct s.aluno_id from public.solicitacoes_confirmacao_pagamento s
          where s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
        )
        select al.id, al.nome, al.telefone, al.email
        from public.alunos al
        left join public.casos cs on cs.aluno_id = al.id and cs.operador_email is null
        where al.responsavel_atual_email is null
          and (al.data_retorno is null or al.data_retorno <= current_date)
          and coalesce(al.status_jornada,'') not in ('QUITADO','QUITADO_MANUAL')
          and coalesce(al.status_atual,'')   not in ('QUITADO','QUITADO_MANUAL')
          and coalesce(cs.total_em_aberto,0) > 0
          and ((c.filtros->>'unidade') is null or al.unidade = c.filtros->>'unidade')
          and ((c.filtros->>'curso')   is null or al.curso   = c.filtros->>'curso')
          and ((c.filtros->>'situacao_academica') is null
               or nullif(btrim(al.situacao_academica),'') = c.filtros->>'situacao_academica')
          and not public.caso_encerrado_operacional(al.cpf, al.status_atual, al.status_acionamento, null::text, al.status_jornada)
          and not exists (select 1 from public.acordos ac where ac.aluno_id=al.id and ac.status='ATIVO')
          and not exists (select 1 from public.casos cx where cx.aluno_id=al.id and coalesce(cx.nao_acionar,false))
          and ((c.filtros->>'ano_vencimento') is null or exists (
                select 1 from public.acordos_titulos at where at.aluno_id=al.id and at.situacao='ABERTO'
                  and at.vencimento between ((c.filtros->>'ano_vencimento')||'-01-01')::date and ((c.filtros->>'ano_vencimento')||'-12-31')::date))
          and (coalesce((c.filtros->>'apenas_nunca_acionado')::boolean,false)=false or al.data_ultimo_acionamento is null)
          and (coalesce((c.filtros->>'apenas_ja_acionado')::boolean,false)=false or al.data_ultimo_acionamento is not null)
          and ( nullif(c.filtros->>'dias_minimo_sem_contato','') is null or al.data_ultimo_acionamento is null
                or al.data_ultimo_acionamento <= now() - ((c.filtros->>'dias_minimo_sem_contato')||' days')::interval)
          and ( case when c.canal='WHATSAPP'
                     then nullif(regexp_replace(coalesce(al.telefone,''),'[^0-9]','','g'),'') is not null
                     else btrim(coalesce(al.email,'')) <> '' end )
        order by al.data_ultimo_acionamento asc nulls first
        limit coalesce((c.filtros->>'limite')::int, 6000)
      loop
        v_eleg := v_eleg + 1;
        if exists (select 1 from public.acoes_massivas_destinatarios d
                    where d.campanha_id=c.id and d.aluno_id=a.id::text and d.canal=c.canal and d.finalidade=c.finalidade and d.status='ENVIADO') then
          continue;
        end if;
        v_motivo := public.aluno_em_confirmacao_pagamento(a.id::text);
        if v_motivo is not null then
          insert into public.acoes_massivas_destinatarios(campanha_id,aluno_id,canal,finalidade,status,motivo_exclusao,chave_idempotencia)
          values (c.id, a.id::text, c.canal, c.finalidade, 'EXCLUIDO', v_motivo, c.chave_idempotencia||':'||a.id::text)
          on conflict (campanha_id,aluno_id,canal,finalidade) do nothing;
          v_excl := v_excl + 1; continue;
        end if;
        update public.alunos
           set data_retorno=v_retorno,
               status_acionamento='Ação massiva externa enviada — aguardando retorno',
               data_ultimo_acionamento=now()
         where id=a.id and responsavel_atual_email is null;
        if found then
          insert into public.acoes_massivas_destinatarios(campanha_id,aluno_id,canal,finalidade,status,enviado_em,chave_idempotencia)
          values (c.id, a.id::text, c.canal, c.finalidade, 'ENVIADO', now(), c.chave_idempotencia||':'||a.id::text)
          on conflict (campanha_id,aluno_id,canal,finalidade) do nothing
          returning id into v_ins;
          if v_ins is not null then
            insert into public.aluno_movimentacoes(aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
            values (a.id::text, v_tipo,
              'Ação massiva AGENDADA executada por SISTEMA via '||case when c.canal='WHATSAPP' then 'WhatsApp' else 'e-mail' end
                ||' (campanha '||coalesce(c.nome,'-')||'). Retorno agendado para '||to_char(v_retorno,'DD/MM/YYYY')||'.',
              'SISTEMA', 'SISTEMA', now());
            v_env := v_env + 1;
          end if;
        else
          v_excl := v_excl + 1;
          insert into public.acoes_massivas_destinatarios(campanha_id,aluno_id,canal,finalidade,status,motivo_exclusao,chave_idempotencia)
          values (c.id, a.id::text, c.canal, c.finalidade, 'EXCLUIDO', 'Deixou de ser elegível (com operador/inexistente)', c.chave_idempotencia||':'||a.id::text)
          on conflict (campanha_id,aluno_id,canal,finalidade) do nothing;
        end if;
      end loop;

      update public.acoes_massivas_agendamentos
         set status = case when v_err>0 then 'CONCLUIDO_COM_ERROS' else 'CONCLUIDO' end,
             finalizado_em=now(), quantidade_elegivel_execucao=v_eleg,
             quantidade_excluida_revalidacao=v_excl, quantidade_enviada=v_env, quantidade_erros=v_err
       where id=c.id;
      v_proc := v_proc + v_env;

    exception when others then
      if c.tentativa + 1 < v_maxtent then
        update public.acoes_massivas_agendamentos
           set status='AGENDADO', proxima_tentativa_em=now()+interval '5 minutes',
               erro_execucao=left(sqlerrm,500)
         where id=c.id;
      else
        update public.acoes_massivas_agendamentos
           set status='FALHOU', finalizado_em=now(), erro_execucao=left(sqlerrm,500)
         where id=c.id;
      end if;
    end;
  end loop;

  return jsonb_build_object('campanhas_processadas', v_camp, 'registros', v_proc);
end $function$;
