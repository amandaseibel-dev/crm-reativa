-- ============================================================================
-- Ações Massivas agendadas — NÃO há integração automática oficial de WhatsApp/e-mail
-- (envio real depende de wa.me/Gmail/planilha = manual). Portanto o executor NÃO
-- simula envio: passa a MODO PREPARAÇÃO. No horário programado ele revalida a
-- elegibilidade e REGISTRA A LISTA (status PREPARADO), SEM criar movimentação,
-- SEM alterar data_retorno, SEM status ENVIADO. O envio externo segue manual.
-- ============================================================================

-- Amplia os status permitidos (adiciona PREPARADO).
alter table public.acoes_massivas_agendamentos drop constraint if exists acoes_massivas_agendamentos_status_check;
alter table public.acoes_massivas_agendamentos add constraint acoes_massivas_agendamentos_status_check
  check (status in ('RASCUNHO','AGENDADO','PROCESSANDO','PREPARADO','CONCLUIDO','CONCLUIDO_COM_ERROS','CANCELADO','FALHOU'));

alter table public.acoes_massivas_destinatarios drop constraint if exists acoes_massivas_destinatarios_status_check;
alter table public.acoes_massivas_destinatarios add constraint acoes_massivas_destinatarios_status_check
  check (status in ('PREPARADO','ENVIADO','EXCLUIDO','ERRO'));

-- Executor em modo PREPARAÇÃO (técnico-only). Revalidação completa; nenhum envio.
create or replace function public.acoes_massivas_executar_agendadas()
 returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  c record; a record;
  v_prep_total int := 0; v_camp int := 0;
  v_prep int; v_excl int; v_motivo text; v_ins uuid; v_maxtent int := 3;
begin
  if not public.acoes_massivas_e_executor_tecnico() then
    raise exception 'Executor restrito a service_role/pg_cron.' using errcode='42501';
  end if;

  for c in
    select * from public.acoes_massivas_agendamentos
     where status='AGENDADO' and programado_para <= now()
     order by programado_para for update skip locked limit 10
  loop
    v_camp := v_camp + 1;
    update public.acoes_massivas_agendamentos
       set status='PROCESSANDO', iniciado_em=now(), executado_por='SISTEMA',
           executor_tecnico=coalesce(auth.role(), session_user), tentativa=tentativa+1
     where id=c.id;

    v_prep:=0; v_excl:=0;
    begin
      for a in
        select al.id
        from public.alunos al
        left join public.casos cs on cs.aluno_id = al.id and cs.operador_email is null
        where al.responsavel_atual_email is null
          and (al.data_retorno is null or al.data_retorno <= current_date)
          and coalesce(al.status_jornada,'') not in ('QUITADO','QUITADO_MANUAL')
          and coalesce(al.status_atual,'')   not in ('QUITADO','QUITADO_MANUAL')
          and coalesce(cs.total_em_aberto,0) > 0
          and coalesce(cs.total_em_aberto,0) >= coalesce(nullif(c.filtros->>'valor_min','')::numeric, 0)
          and (nullif(c.filtros->>'valor_max','') is null or coalesce(cs.total_em_aberto,0) <= (c.filtros->>'valor_max')::numeric)
          and ((c.filtros->>'unidade') is null or al.unidade = c.filtros->>'unidade')
          and ((c.filtros->>'curso')   is null or al.curso   = c.filtros->>'curso')
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
        -- Revalida confirmação de pagamento imediatamente (gate canônico).
        v_motivo := public.aluno_em_confirmacao_pagamento(a.id::text);
        if v_motivo is not null then
          insert into public.acoes_massivas_destinatarios(campanha_id,aluno_id,canal,finalidade,status,motivo_exclusao,chave_idempotencia)
          values (c.id, a.id::text, c.canal, c.finalidade, 'EXCLUIDO', v_motivo, c.chave_idempotencia||':'||a.id::text)
          on conflict (campanha_id,aluno_id,canal,finalidade) do nothing;
          v_excl := v_excl + 1; continue;
        end if;
        -- PREPARA (não envia): registra o destinatário como PREPARADO, sem movimentação
        -- e sem alterar o aluno. Idempotente por (campanha,aluno,canal,finalidade).
        insert into public.acoes_massivas_destinatarios(campanha_id,aluno_id,canal,finalidade,status,chave_idempotencia)
        values (c.id, a.id::text, c.canal, c.finalidade, 'PREPARADO', c.chave_idempotencia||':'||a.id::text)
        on conflict (campanha_id,aluno_id,canal,finalidade) do nothing
        returning id into v_ins;
        if v_ins is not null then v_prep := v_prep + 1; end if;
      end loop;

      -- PREPARADO: lista pronta para o envio EXTERNO (manual). quantidade_enviada=0
      -- (nenhum disparo automático ocorreu).
      update public.acoes_massivas_agendamentos
         set status='PREPARADO', finalizado_em=now(),
             quantidade_elegivel_execucao=v_prep, quantidade_excluida_revalidacao=v_excl,
             quantidade_enviada=0, quantidade_erros=0
       where id=c.id;
      v_prep_total := v_prep_total + v_prep;

    exception when others then
      if c.tentativa + 1 < v_maxtent then
        update public.acoes_massivas_agendamentos set status='AGENDADO', proxima_tentativa_em=now()+interval '5 minutes', erro_execucao=left(sqlerrm,500) where id=c.id;
      else
        update public.acoes_massivas_agendamentos set status='FALHOU', finalizado_em=now(), erro_execucao=left(sqlerrm,500) where id=c.id;
      end if;
    end;
  end loop;

  return jsonb_build_object('campanhas_preparadas', v_camp, 'destinatarios_preparados', v_prep_total, 'modo','PREPARACAO_SEM_ENVIO_AUTOMATICO');
end $$;
revoke execute on function public.acoes_massivas_executar_agendadas() from public, anon, authenticated;
grant  execute on function public.acoes_massivas_executar_agendadas() to service_role;
