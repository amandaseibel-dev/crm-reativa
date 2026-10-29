-- ============================================================================
-- Agendamento automático das Ações Massivas — RPCs + pg_cron
-- Criação/cancelamento/reagendamento: gestão (gate JWT). Executor: técnico-only.
-- Autoria pelo JWT; executado_por=SISTEMA; idempotência; revalidação completa.
-- ============================================================================

-- Helper de gate técnico (executor). service_role OU sessão interna (postgres/cron).
create or replace function public.acoes_massivas_e_executor_tecnico()
 returns boolean language sql stable security definer set search_path to 'public' as $$
  select (auth.role() = 'service_role')
      or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
$$;
revoke execute on function public.acoes_massivas_e_executor_tecnico() from public, anon;
grant execute on function public.acoes_massivas_e_executor_tecnico() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CRIAR agendamento (gestão). Guarda FILTROS (nunca lista de alunos).
-- Horário informado em America/Sao_Paulo, convertido para timestamptz (UTC).
-- ---------------------------------------------------------------------------
create or replace function public.acoes_massivas_agendar(
  p_nome text, p_finalidade text, p_canal text, p_mensagem text,
  p_filtros jsonb, p_data text, p_hora text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_quando timestamptz;
  v_previa jsonb; v_qtd int; v_id uuid; v_chave text;
begin
  if not (app_usuario_ativo() and usuario_e_gestao()) then
    raise exception 'Acesso negado: agendar acao massiva restrito a gestao.' using errcode='42501';
  end if;
  if coalesce(btrim(p_nome),'')='' or coalesce(btrim(p_finalidade),'')='' then
    raise exception 'Nome e finalidade sao obrigatorios.' using errcode='22023';
  end if;
  if p_canal not in ('WHATSAPP','EMAIL') then
    raise exception 'Canal invalido.' using errcode='22023';
  end if;
  -- Brasília -> UTC (evita interpretar BRT como UTC).
  v_quando := (p_data || ' ' || p_hora)::timestamp at time zone 'America/Sao_Paulo';
  if v_quando <= now() then
    raise exception 'Horario programado deve ser no futuro.' using errcode='22023';
  end if;
  -- Prévia só para contagem estimada (auditoria). Não congela alunos.
  v_previa := public.acoes_massivas_previa(
    p_filtros->>'ano_vencimento',
    coalesce((p_filtros->>'limite')::int, 6000),
    nullif(p_filtros->>'dias_minimo_sem_contato','')::int,
    coalesce((p_filtros->>'apenas_nunca_acionado')::boolean,false),
    p_filtros->>'unidade', p_filtros->>'curso',
    coalesce((p_filtros->>'apenas_ja_acionado')::boolean,false));
  v_qtd := coalesce(jsonb_array_length(v_previa->'elegiveis'),0);
  v_chave := md5(coalesce(p_nome,'')||'|'||p_canal||'|'||p_finalidade||'|'||v_quando::text||'|'||coalesce(p_filtros::text,'{}'));

  insert into public.acoes_massivas_agendamentos
    (nome, finalidade, canal, mensagem, filtros, programado_para, status,
     criado_por, autorizado_por, autorizado_em, quantidade_previa, chave_idempotencia)
  values (p_nome, p_finalidade, p_canal, p_mensagem, coalesce(p_filtros,'{}'::jsonb), v_quando, 'AGENDADO',
     v_email, v_email, now(), v_qtd, v_chave)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'programado_para', v_quando,
    'programado_para_brasilia', to_char(v_quando at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI'),
    'quantidade_previa', v_qtd, 'status','AGENDADO');
exception when unique_violation then
  raise exception 'Ja existe um agendamento identico para este horario.' using errcode='23505';
end $$;
revoke execute on function public.acoes_massivas_agendar(text,text,text,text,jsonb,text,text) from public, anon;
grant execute on function public.acoes_massivas_agendar(text,text,text,text,jsonb,text,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CANCELAR (gestão) — só RASCUNHO/AGENDADO.
-- ---------------------------------------------------------------------------
create or replace function public.acoes_massivas_cancelar(p_id uuid, p_motivo text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_email text := lower(coalesce(auth.email(),'')); v_status text;
begin
  if not (app_usuario_ativo() and usuario_e_gestao()) then
    raise exception 'Acesso negado.' using errcode='42501';
  end if;
  update public.acoes_massivas_agendamentos
     set status='CANCELADO', cancelado_por=v_email, cancelado_em=now(), motivo_cancelamento=p_motivo
   where id=p_id and status in ('RASCUNHO','AGENDADO')
   returning status into v_status;
  if v_status is null then
    raise exception 'Agendamento nao encontrado ou nao cancelavel (status atual impede).' using errcode='22023';
  end if;
  return jsonb_build_object('id',p_id,'status','CANCELADO');
end $$;
revoke execute on function public.acoes_massivas_cancelar(uuid,text) from public, anon;
grant execute on function public.acoes_massivas_cancelar(uuid,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- REAGENDAR (gestão) — só RASCUNHO/AGENDADO; preserva histórico.
-- ---------------------------------------------------------------------------
create or replace function public.acoes_massivas_reagendar(p_id uuid, p_data text, p_hora text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_email text := lower(coalesce(auth.email(),'')); v_novo timestamptz; v_antigo timestamptz; v_status text;
begin
  if not (app_usuario_ativo() and usuario_e_gestao()) then
    raise exception 'Acesso negado.' using errcode='42501';
  end if;
  v_novo := (p_data || ' ' || p_hora)::timestamp at time zone 'America/Sao_Paulo';
  if v_novo <= now() then
    raise exception 'Novo horario deve ser no futuro.' using errcode='22023';
  end if;
  select programado_para, status into v_antigo, v_status
    from public.acoes_massivas_agendamentos where id=p_id for update;
  if v_status is null or v_status not in ('RASCUNHO','AGENDADO') then
    raise exception 'Agendamento nao encontrado ou nao reagendavel.' using errcode='22023';
  end if;
  update public.acoes_massivas_agendamentos
     set programado_para=v_novo, status='AGENDADO',
         historico = coalesce(historico,'[]'::jsonb) || jsonb_build_object(
           'em', now(), 'evento','REAGENDADO', 'de', v_antigo, 'para', v_novo, 'por', v_email)
   where id=p_id;
  return jsonb_build_object('id',p_id,'programado_para',v_novo,
    'programado_para_brasilia', to_char(v_novo at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI'));
end $$;
revoke execute on function public.acoes_massivas_reagendar(uuid,text,text) from public, anon;
grant execute on function public.acoes_massivas_reagendar(uuid,text,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- LISTAR (gestão). Agendamentos não contêm PII. Já mostra horário de Brasília.
-- ---------------------------------------------------------------------------
create or replace function public.acoes_massivas_listar(p_status text default null, p_de text default null, p_ate text default null)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_out jsonb;
begin
  if not (app_usuario_ativo() and usuario_e_gestao()) then
    raise exception 'Acesso negado.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.programado_para desc),'[]'::jsonb) into v_out
  from (
    select id, nome, finalidade, canal, filtros, status,
           programado_para,
           to_char(programado_para at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI') as programado_para_brasilia,
           criado_por, autorizado_por, executado_por, executor_tecnico,
           iniciado_em, finalizado_em, quantidade_previa, quantidade_elegivel_execucao,
           quantidade_excluida_revalidacao, quantidade_enviada, quantidade_erros,
           tentativa, motivo_cancelamento, erro_execucao
    from public.acoes_massivas_agendamentos
    where (p_status is null or status = p_status)
      and (p_de  is null or programado_para >= (p_de ||' 00:00')::timestamp at time zone 'America/Sao_Paulo')
      and (p_ate is null or programado_para <= (p_ate||' 23:59')::timestamp at time zone 'America/Sao_Paulo')
  ) x;
  return v_out;
end $$;
revoke execute on function public.acoes_massivas_listar(text,text,text) from public, anon;
grant execute on function public.acoes_massivas_listar(text,text,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- EXECUTOR automático (técnico-only). Recalcula elegibilidade pelos FILTROS no
-- horário real, revalida por aluno e registra a ação (reuso do mecanismo oficial:
-- UPDATE alunos + aluno_movimentacoes), com idempotência por destinatário.
-- ---------------------------------------------------------------------------
create or replace function public.acoes_massivas_executar_agendadas()
 returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  c record; a record;
  v_proc int := 0; v_camp int := 0;
  v_eleg int; v_excl int; v_env int; v_err int;
  v_motivo text; v_tipo text; v_retorno date := current_date + 10; v_ins uuid; v_maxtent int := 3;
begin
  if not public.acoes_massivas_e_executor_tecnico() then
    raise exception 'Executor restrito a service_role/pg_cron.' using errcode='42501';
  end if;

  for c in
    select * from public.acoes_massivas_agendamentos
     where status='AGENDADO' and programado_para <= now()
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
      -- Recalcula elegibilidade pelos filtros salvos (mesma base da prévia +
      -- saldo>0 + contato válido para o canal + exclusões operacionais).
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
          and coalesce(cs.total_em_aberto,0) > 0                         -- saldo zero excluído
          and ((c.filtros->>'unidade') is null or al.unidade = c.filtros->>'unidade')
          and ((c.filtros->>'curso')   is null or al.curso   = c.filtros->>'curso')
          and not public.caso_encerrado_operacional(al.cpf, al.status_atual, al.status_acionamento, null::text, al.status_jornada)
          and not exists (select 1 from public.acordos ac where ac.aluno_id=al.id and ac.status='ATIVO')
          and not exists (select 1 from public.casos cx where cx.aluno_id=al.id and coalesce(cx.nao_acionar,false)) -- opt-out
          and ((c.filtros->>'ano_vencimento') is null or exists (
                select 1 from public.acordos_titulos at where at.aluno_id=al.id and at.situacao='ABERTO'
                  and at.vencimento between ((c.filtros->>'ano_vencimento')||'-01-01')::date and ((c.filtros->>'ano_vencimento')||'-12-31')::date))
          and (coalesce((c.filtros->>'apenas_nunca_acionado')::boolean,false)=false or al.data_ultimo_acionamento is null)
          and (coalesce((c.filtros->>'apenas_ja_acionado')::boolean,false)=false or al.data_ultimo_acionamento is not null)
          and ( nullif(c.filtros->>'dias_minimo_sem_contato','') is null or al.data_ultimo_acionamento is null
                or al.data_ultimo_acionamento <= now() - ((c.filtros->>'dias_minimo_sem_contato')||' days')::interval)
          and ( case when c.canal='WHATSAPP'
                     then nullif(regexp_replace(coalesce(al.telefone,''),'[^0-9]','','g'),'') is not null
                     else btrim(coalesce(al.email,'')) <> '' end )                 -- contato válido p/ canal
        order by al.data_ultimo_acionamento asc nulls first
        limit coalesce((c.filtros->>'limite')::int, 6000)
      loop
        v_eleg := v_eleg + 1;
        -- Idempotência: se já ENVIADO para (campanha,aluno,canal,finalidade), pula.
        if exists (select 1 from public.acoes_massivas_destinatarios d
                    where d.campanha_id=c.id and d.aluno_id=a.id::text and d.canal=c.canal and d.finalidade=c.finalidade and d.status='ENVIADO') then
          continue;
        end if;
        -- Revalida confirmação IMEDIATAMENTE antes do registro (gate canônico).
        v_motivo := public.aluno_em_confirmacao_pagamento(a.id::text);
        if v_motivo is not null then
          insert into public.acoes_massivas_destinatarios(campanha_id,aluno_id,canal,finalidade,status,motivo_exclusao,chave_idempotencia)
          values (c.id, a.id::text, c.canal, c.finalidade, 'EXCLUIDO', v_motivo, c.chave_idempotencia||':'||a.id::text)
          on conflict (campanha_id,aluno_id,canal,finalidade) do nothing;
          v_excl := v_excl + 1; continue;
        end if;
        -- Registra a ação (mecanismo oficial: só pool; não altera responsável/saldo/acordo).
        update public.alunos
           set data_retorno=v_retorno,
               status_acionamento='Ação massiva externa enviada — aguardando retorno',
               data_ultimo_acionamento=now()
         where id=a.id and responsavel_atual_email is null;
        if found then
          -- registra destinatário ENVIADO (idempotente). Movimentação só se inseriu agora.
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
      -- Falha técnica: retenta de forma controlada (idempotência evita duplicar).
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
end $$;
-- Executor: NUNCA para PUBLIC/anon/authenticated comum. Só técnico.
revoke execute on function public.acoes_massivas_executar_agendadas() from public, anon, authenticated;
grant  execute on function public.acoes_massivas_executar_agendadas() to service_role;

-- ---------------------------------------------------------------------------
-- pg_cron a cada 1 minuto (UTC). Converte agendamentos vencidos.
-- ---------------------------------------------------------------------------
select cron.schedule('acoes_massivas_executar_agendadas', '* * * * *',
  $c$ select public.acoes_massivas_executar_agendadas(); $c$);
