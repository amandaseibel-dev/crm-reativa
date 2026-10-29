-- =============================================================================
-- Desfazer termo gov.br ATÉ as assinaturas concluírem
--
-- Regra da Amanda (2026-08-21): o termo via gov.br anexado pelo operador pode
-- ser desfeito — inclusive depois de o ADM validar o documento — ATÉ o fluxo
-- de assinaturas concluir (etapa_assinatura = COMPLETO / via completa anexada).
-- A partir daí, nunca: o documento definitivo existe e desfazer seria
-- reescrever contrato.
--
-- O termo MANUAL continua como estava: operador só desfaz enquanto o termo está
-- na fila do ADM (TERMO_ENVIADO_ADM); depois, o caminho é a rejeição do ADM.
--
-- Motivo prático: gov.br é a maioria (319 de 436 termos nos últimos 30 dias) e
-- não passa por fila nenhuma antes de liberar — sem esta regra, o erro de
-- anexo no gov.br não tinha desfazer nenhum.
--
-- Muda três funções da 20260821180000:
--   _trg_desfazer_cartao_termo  -> cartão nasce também no envio gov.br
--   _desfazer_bloqueio          -> trava nova 'assinaturas_concluidas'
--   desfazer_acao               -> UPDATE aceita os estados gov.br e zera a
--                                  etapa (termo desfeito não pode sobrar na
--                                  fila de assinaturas)
-- =============================================================================

create or replace function public._trg_desfazer_cartao_termo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_aluno public.alunos%rowtype;
begin
  if new.status not in ('TERMO_ENVIADO_ADM','TERMO_LIBERADO_AUTOMATICO_GOV') then
    return null;
  end if;

  begin
    select * into v_aluno from public.alunos where id = new.aluno_id::uuid;
  exception when others then
    return null;
  end;
  if not found then
    return null;
  end if;

  insert into public.acoes_desfazer
    (tipo, aluno_id, aluno_nome, referencia_id, operador_email, operador_nome,
     rotulo, estado_anterior)
  values
    ('TERMO_ENVIADO', v_aluno.id, new.aluno_nome, new.id,
     lower(coalesce(new.operador_email, public.app_email())), new.operador_nome,
     case when new.status = 'TERMO_LIBERADO_AUTOMATICO_GOV'
          then 'Termo (gov.br) anexado'
          else 'Termo enviado para a fila do ADM' end,
     public._aluno_estado_json(v_aluno));

  return null;
exception when others then
  return null;
end;
$$;

create or replace function public._desfazer_bloqueio(
  p_acao public.acoes_desfazer,
  p_gestao boolean
)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_termo public.termos_acordo%rowtype;
  v_status text;
  v_ultima bigint;
begin
  if p_acao.desfeito_em is not null then
    return 'ja_desfeito';
  end if;

  if p_acao.tipo = 'TERMO_ENVIADO' then
    select * into v_termo from public.termos_acordo where id = p_acao.referencia_id;
    if not found then return 'termo_nao_encontrado'; end if;

    -- Assinaturas concluídas (via completa anexada) travam SEMPRE: a partir
    -- daqui o documento definitivo existe e desfazer é reescrever contrato.
    if coalesce(v_termo.etapa_assinatura,'') = 'COMPLETO'
       or v_termo.assinatura_completa_em is not null
       or coalesce(trim(v_termo.arquivo_final_url), '') <> '' then
      return 'assinaturas_concluidas';
    end if;

    -- Manual: só enquanto está na fila do ADM.
    if v_termo.status = 'TERMO_ENVIADO_ADM' then return null; end if;

    -- gov.br: desfazível até as assinaturas concluírem, mesmo depois de o ADM
    -- validar o documento (o erro de anexo pode ser notado tarde).
    if v_termo.tipo_assinatura = 'GOV_BR'
       and v_termo.status in ('TERMO_LIBERADO_AUTOMATICO_GOV','TERMO_RECEBIDO_LIBERADO') then
      return null;
    end if;

    return 'termo_ja_tratado';
  end if;

  if p_acao.tipo = 'LINK_SOLICITADO' then
    select status into v_status from public.links_pagamento where id = p_acao.referencia_id;
    if not found then return 'link_nao_encontrado'; end if;
    if v_status <> 'SOLICITADO_LINK' then return 'link_ja_em_atendimento'; end if;
    return null;
  end if;

  if not coalesce(p_gestao, false) and p_acao.criado_em < now() - interval '24 hours' then
    return 'prazo_expirado';
  end if;

  select max(m.id) into v_ultima
    from public.aluno_movimentacoes m
   where m.aluno_id = p_acao.aluno_id::text
     and public.eh_tipo_acionamento(m.tipo);
  if v_ultima is distinct from p_acao.movimentacao_id then
    return 'houve_acao_depois';
  end if;

  if exists (
    select 1 from public.termos_acordo t
     where t.aluno_id = p_acao.aluno_id::text and t.criado_em > p_acao.criado_em
  ) then
    return 'houve_acao_depois';
  end if;

  if exists (
    select 1 from public.solicitacoes_confirmacao_pagamento s
     where s.aluno_id = p_acao.aluno_id::text
       and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
       and s.criado_em >= p_acao.criado_em
  ) then
    return 'confirmacao_aberta';
  end if;

  return null;
end;
$$;

create or replace function public.desfazer_acao(
  p_id uuid, p_motivo text default null, p_ator text default null, p_gestao boolean default null
) returns jsonb language plpgsql security definer set search_path to 'public', 'internal'
as $$
declare
  v_acao public.acoes_desfazer%rowtype;
  v_sem_jwt boolean := (auth.jwt() is null);
  v_ator text; v_gestao boolean; v_bloqueio text; v_motivo text;
  v_descarte jsonb := '{}'::jsonb; v_resp text; v_status_novo text;
begin
  if v_sem_jwt then
    v_ator := lower(coalesce(p_ator, '')); v_gestao := coalesce(p_gestao, false);
  else
    v_ator := public.app_email(); v_gestao := public.usuario_e_gestao();
  end if;
  if v_ator = '' then return jsonb_build_object('ok', false, 'erro', 'sem_sessao'); end if;

  select * into v_acao from public.acoes_desfazer where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'acao_nao_encontrada'); end if;

  select status_atual into v_status_novo from public.alunos where id = v_acao.aluno_id;

  if not v_gestao and v_acao.operador_email <> v_ator then
    return jsonb_build_object('ok', false, 'erro', 'nao_e_sua');
  end if;

  v_motivo := nullif(btrim(coalesce(p_motivo, '')), '');
  if v_gestao and v_acao.operador_email <> v_ator and v_motivo is null then
    return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio');
  end if;

  v_bloqueio := public._desfazer_bloqueio(v_acao, v_gestao);
  if v_bloqueio is not null then return jsonb_build_object('ok', false, 'erro', v_bloqueio); end if;

  if v_acao.tipo = 'TERMO_ENVIADO' then
    -- Mesmo conjunto de estados que o bloqueio libera: manual pendente OU
    -- gov.br antes de as assinaturas concluírem. A checagem de COMPLETO se
    -- repete aqui de propósito -- entre o bloqueio e este UPDATE alguém pode
    -- ter anexado a via completa.
    update public.termos_acordo
       set status = 'TERMO_DESFEITO_OPERADOR',
           etapa_assinatura = 'NAO_APLICAVEL',
           observacao_adm = 'Desfeito por ' || v_ator || coalesce(' — ' || v_motivo, '') || '.',
           atualizado_em = now()
     where id = v_acao.referencia_id
       and (status = 'TERMO_ENVIADO_ADM'
            or (tipo_assinatura = 'GOV_BR'
                and status in ('TERMO_LIBERADO_AUTOMATICO_GOV','TERMO_RECEBIDO_LIBERADO')))
       and coalesce(etapa_assinatura,'') <> 'COMPLETO'
       and assinatura_completa_em is null
       and coalesce(trim(arquivo_final_url), '') = '';
    if not found then return jsonb_build_object('ok', false, 'erro', 'termo_ja_tratado'); end if;

    v_descarte := public._termo_descartar_vias(
      v_acao.referencia_id, v_ator, 'Envio desfeito' || coalesce(' — ' || v_motivo, '') || '.');

  elsif v_acao.tipo = 'LINK_SOLICITADO' then
    update public.links_pagamento
       set status = 'CANCELADO', cancelado_em = now(),
           observacao_adm = 'Solicitação desfeita por ' || v_ator || coalesce(' — ' || v_motivo, '') || '.',
           atualizado_em = now()
     where id = v_acao.referencia_id and status = 'SOLICITADO_LINK';
    if not found then return jsonb_build_object('ok', false, 'erro', 'link_ja_em_atendimento'); end if;

    insert into public.historico_links_pagamento
      (link_id, aluno_id, aluno_nome, status_anterior, status_novo, descricao, usuario_email)
    values (v_acao.referencia_id, v_acao.aluno_id::text, v_acao.aluno_nome, 'SOLICITADO_LINK', 'CANCELADO',
       'Solicitação desfeita pelo operador antes de o ADM assumir' || coalesce(' — ' || v_motivo, '') || '.', v_ator);
  end if;

  if v_acao.movimentacao_id is not null then
    update public.aluno_movimentacoes
       set tipo = 'FINALIZACAO_ATENDIMENTO_DESFEITA',
           descricao = coalesce(descricao, '') || ' [DESFEITO por ' || v_ator || ']'
     where id = v_acao.movimentacao_id and tipo = 'FINALIZACAO_ATENDIMENTO';
  end if;

  if v_acao.atribuiu_responsavel then
    select responsavel_atual_email into v_resp from public.alunos where id = v_acao.aluno_id;
    if lower(coalesce(v_resp,'')) = v_acao.operador_email then
      perform internal.set_resp_aluno(v_acao.aluno_id, null, null, 'ALTERACAO_OPERADOR',
        'Caso devolvido para a fila: a ação que o vinculou foi desfeita.', v_ator, v_ator);
    end if;
  end if;

  perform public._desfazer_restaurar_aluno(v_acao.aluno_id, v_acao.estado_anterior);

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em)
  values (v_acao.aluno_id::text, 'ACAO_DESFEITA',
     'Desfeito: ' || v_acao.rotulo || coalesce(' — ' || v_motivo, '') || '.',
     v_status_novo, v_acao.estado_anterior->>'status_atual',
     coalesce(v_acao.operador_nome, v_ator), v_ator, now());

  update public.acoes_desfazer
     set desfeito_em = now(), desfeito_por = v_ator, motivo = v_motivo,
         resultado = jsonb_build_object('descarte', v_descarte)
   where id = p_id;

  return jsonb_build_object('ok', true, 'tipo', v_acao.tipo, 'aluno_id', v_acao.aluno_id,
    'status_restaurado', v_acao.estado_anterior->>'status_atual',
    'itens', coalesce(v_descarte->'itens', '[]'::jsonb));
end; $$;
