-- Portão de validação ADM para termos assinados via gov.br
--
-- Contexto e decisão (Amanda 2026-08-12):
-- Termos gov.br entram direto em TERMO_LIBERADO_AUTOMATICO_GOV e, desde
-- 2026-08-11 (migration 20260811190000), o trigger _trg_notif_termo_gov avisava
-- o operador ("✅ termo aprovado, libere o acordo") NO INSTANTE da assinatura.
-- Isso contradiz o próprio aviso do app (FinalizacaoTermo: "Não libere o boleto
-- ainda — a ADM ainda precisa validar a assinatura antes da liberação").
-- Regra correta: o operador só é avisado DEPOIS que a ADM conferir o documento
-- gov na fila de auditoria (/termos-adm) e devolver (aprovar/rejeitar).
--
-- Este migration:
--   1) Rotula os gov já existentes como legado — não caem na nova fila de
--      validação (já foram liberados; sem backfill de notificação).
--   2) Trigger gov passa a avisar SÓ a ADM (auditoria); remove o aviso
--      automático ao operador.
--   3) validar_assinatura_termo passa a aceitar gov PENDENTE
--      (validado_por = 'AUTOMATICO_GOV_BR'); ao APROVAR/REJEITAR aí sim notifica
--      o operador dono via sistema_retorno_termo (mesmo fluxo do termo manual).
--   4) contadores_cabecalho: o badge "termos aguardando ADM" passa a somar os
--      gov pendentes de auditoria.
--
-- Discriminador (sem timestamp mágico): gov "pendente de auditoria" =
--   status = 'TERMO_LIBERADO_AUTOMATICO_GOV' AND validado_por = 'AUTOMATICO_GOV_BR'.
-- Todo gov novo já nasce assim (FinalizacaoTermo grava validado_por =
-- 'AUTOMATICO_GOV_BR'); ao validar, validado_por vira o e-mail da ADM e o termo
-- sai do conjunto pendente.

-- 1) Legado: tira os gov antigos (477 em 2026-08-12) da fila de validação. -----
--    Eles já foram liberados na prática; não devem virar backlog para a ADM nem
--    disparar notificação retroativa.
update public.termos_acordo
   set validado_por = 'LEGADO_GOV_PRE_AUDITORIA'
 where status = 'TERMO_LIBERADO_AUTOMATICO_GOV'
   and coalesce(validado_por, '') = 'AUTOMATICO_GOV_BR';

-- 2) Trigger gov: avisa só a ADM (auditoria); NÃO avisa mais o operador. --------
create or replace function public._trg_notif_termo_gov()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'internal'
as $function$
declare
  v_aluno_uuid uuid;
  v_nome_aluno text;
  v_adm text;
  v_admins text[] := array[
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  ];
begin
  if new.status <> 'TERMO_LIBERADO_AUTOMATICO_GOV' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  begin
    v_aluno_uuid := nullif(new.aluno_id, '')::uuid;
  exception when others then
    v_aluno_uuid := null;
  end;

  if v_aluno_uuid is not null then
    select coalesce(nome_aluno, nome) into v_nome_aluno
      from public.alunos where id = v_aluno_uuid;
  end if;

  -- Aviso à gestão/ADM: há um gov para VALIDAR na fila de auditoria.
  -- O operador NÃO é avisado aqui; só depois que a ADM validar e devolver
  -- (validar_assinatura_termo -> sistema_retorno_termo).
  foreach v_adm in array v_admins loop
    insert into public.notificacoes(
      usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
      aluno_id, url_destino, lida, criado_em)
    values (
      lower(v_adm), null, 'TERMO_GOV_AUDITORIA',
      '📄 Termo gov.br para validar',
      'Termo assinado via gov.br' || coalesce(' de ' || v_nome_aluno, '')
        || ' enviado por ' || coalesce(new.operador_nome, new.operador_email, 'operador')
        || '. Valide o documento na fila de auditoria (gov.br) para liberar o operador.',
      coalesce(new.aluno_id, ''), '/termos-adm', false, now());
  end loop;

  return new;
end;
$function$;

drop trigger if exists trg_notif_termo_gov on public.termos_acordo;
create trigger trg_notif_termo_gov
  after insert or update on public.termos_acordo
  for each row
  execute function public._trg_notif_termo_gov();

-- 3) validar_assinatura_termo: aceita gov PENDENTE; avisa o operador na validação
--    (mantém o gate usuario_e_gestao e todo o fluxo do termo manual).
create or replace function public.validar_assinatura_termo(
    p_termo_id uuid,
    p_decisao text,
    p_observacao text default null::text,
    p_motivo text default null::text,
    p_abrir_proximo boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'internal'
as $function$
declare
  v_termo public.termos_acordo%rowtype;
  v_ator text; v_decisao text := upper(coalesce(p_decisao, ''));
  v_novo_status text; v_obs text; v_prox jsonb := null; v_aluno_uuid uuid;
  v_eh_gov boolean;
begin
  if not public.usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  v_ator := coalesce(public.app_email(), 'ADM');
  if v_decisao not in ('APROVAR', 'REJEITAR') then
    return jsonb_build_object('ok', false, 'erro', 'decisao_invalida');
  end if;
  select * into v_termo from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;
  -- idempotência: clique duplo / dois ADMs
  if v_decisao = 'APROVAR' and v_termo.status = 'TERMO_RECEBIDO_LIBERADO' then
    if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_termo.status, 'proximo', v_prox);
  end if;
  if v_decisao = 'REJEITAR' and v_termo.status = 'TERMO_REJEITADO' then
    if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_termo.status, 'proximo', v_prox);
  end if;

  v_eh_gov := (v_termo.status = 'TERMO_LIBERADO_AUTOMATICO_GOV');

  -- gov.br só é validável enquanto pendente de auditoria (validado_por =
  -- 'AUTOMATICO_GOV_BR'). Gov legado (já liberado antes deste fluxo) não.
  if v_eh_gov and coalesce(v_termo.validado_por, '') <> 'AUTOMATICO_GOV_BR' then
    return jsonb_build_object('ok', false, 'erro', 'status_invalido', 'status', v_termo.status);
  end if;
  if v_termo.status not in ('TERMO_ENVIADO_ADM', 'TERMO_LIBERADO_AUTOMATICO_GOV') then
    return jsonb_build_object('ok', false, 'erro', 'status_invalido', 'status', v_termo.status);
  end if;

  if v_decisao = 'APROVAR' then
    v_novo_status := 'TERMO_RECEBIDO_LIBERADO';
    v_obs := coalesce(nullif(trim(p_observacao), ''),
                      case when v_eh_gov then 'Documento gov.br conferido e liberado pela ADM.'
                           else 'Assinatura validada pela ADM.' end);
  else
    if coalesce(nullif(trim(p_motivo), ''), '') = '' then
      return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio');
    end if;
    v_novo_status := 'TERMO_REJEITADO'; v_obs := trim(p_motivo);
  end if;
  update public.termos_acordo
     set status = v_novo_status, observacao_adm = v_obs, validado_por = v_ator,
         validado_em = now(), atualizado_em = now()
   where id = p_termo_id;
  begin v_aluno_uuid := nullif(v_termo.aluno_id, '')::uuid;
  exception when others then v_aluno_uuid := null; end;
  if v_aluno_uuid is not null then
    perform public.sistema_retorno_termo(v_aluno_uuid, v_novo_status, v_novo_status,
      v_termo.operador_email, coalesce(v_termo.operador_nome, v_termo.operador_email));
  end if;
  if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;
  return jsonb_build_object('ok', true, 'status', v_novo_status, 'validado_por', v_ator, 'proximo', v_prox);
end; $function$;

-- 4) Badge do cabeçalho: soma os gov pendentes de auditoria. -------------------
create or replace function public.contadores_cabecalho()
  returns jsonb
  language sql
  stable
  set search_path to 'public'
as $function$
  select jsonb_build_object(
    'links_aguardando', (
      select count(*) from public.links_pagamento
      where status in ('SOLICITADO_LINK','LINK_EM_ATENDIMENTO')),
    'baixas_aguardando', (
      select count(*) from public.links_pagamento
      where status = 'AGUARDANDO_BAIXA'),
    'termos_aguardando_adm', (
      select count(*) from public.termos_acordo
      where status = 'TERMO_ENVIADO_ADM'
         or (status = 'TERMO_LIBERADO_AUTOMATICO_GOV'
             and validado_por = 'AUTOMATICO_GOV_BR')),
    'elogios_pendentes', (
      select count(*) from public.elogios_atendimento
      where status = 'PENDENTE_ANALISE'),
    'termos_rejeitados', (
      -- mesmo criterio do front: por aluno, olha so o termo mais recente
      -- enviado pelo proprio operador logado; conta os que ficaram rejeitados
      select count(*) from (
        select distinct on (t.aluno_id) t.status
        from public.termos_acordo t
        where lower(t.operador_email) = lower(coalesce(auth.email(), ''))
        order by t.aluno_id, t.criado_em desc
      ) u where u.status = 'TERMO_REJEITADO'),
    'parcelas_vencendo', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from public.parcelas_vencendo_2_dias() x)
  );
$function$;
