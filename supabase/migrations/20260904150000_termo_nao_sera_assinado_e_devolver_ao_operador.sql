-- Fila ADM de Termos: "não será assinado" e "devolver ao operador"
-- ---------------------------------------------------------------------------
-- Pedido da Amanda (2026-09-04): dois botões para termo JÁ LIBERADO.
--
--   1) "Não será assinado": o acordo não foi cumprido (aluno não pagou, acordo
--      cancelado, termo substituído/duplicado) e o termo nunca vai voltar com
--      testemunhas + Ulbra. Hoje ele fica para sempre em "A enviar" /
--      "Aguardando assinaturas" e o contador da aba Assinaturas mente para cima.
--      Vira etapa DISPENSADO: sai da trilha, fica listado num filtro próprio e
--      é REVERSÍVEL ("Voltar para a fila").
--
--   2) "Devolver ao operador": o termo foi liberado mas tem algo errado (valor,
--      parcelas, dados do aluno, termo trocado). Volta para TERMO_REJEITADO com
--      o motivo, o caso retorna ao operador pelo mesmo caminho da rejeição na
--      validação (sistema_retorno_termo: status do aluno, movimentação e
--      notificação) e o operador reenvia um termo novo pela ficha.
--
-- Decisões:
--   * NENHUM arquivo é apagado por estas duas ações. A via assinada de quem
--     não pagou é a confissão de dívida; e o termo devolvido continua como
--     histórico com o documento que foi conferido. Descartar arquivo segue
--     sendo o gesto separado que já existe na tela ("Descartar via do aluno"),
--     com confirmação de backup.
--   * A migration 20260821200000 (termos_dispensar_assinatura, em lote, via
--     service_role e COM descarte) foi desenhada e nunca aplicada em nenhum
--     ambiente; esta a substitui. Aqui a RPC é unitária, chamada direto pelo
--     cliente e protegida por usuario_e_gestao(), como as demais da fila.
--   * COMPLETO não é dispensável nem devolvível: já foi assinado. Primeiro
--     "Desfazer assinatura", depois decidir.

alter table public.termos_acordo
  add column if not exists dispensa_motivo text,
  add column if not exists dispensa_detalhe text,
  add column if not exists dispensado_em timestamptz,
  add column if not exists dispensado_por text;

comment on column public.termos_acordo.dispensa_motivo is
  'Por que o termo saiu da trilha de assinatura (etapa DISPENSADO): '
  'ACORDO_CANCELADO | NAO_PAGOU | TERMO_SUBSTITUIDO | DUPLICADO | OUTRO.';

alter table public.termos_acordo drop constraint if exists termos_acordo_etapa_assinatura_check;
alter table public.termos_acordo
  add constraint termos_acordo_etapa_assinatura_check
  check (etapa_assinatura in (
    'NAO_APLICAVEL','NAO_VERIFICADO','PENDENTE_ENVIO','ENVIADO_ASSINATURA','COMPLETO','DISPENSADO'));

-- Motivos fechados: lista curta o bastante para virar relatório depois.
create or replace function public._termo_motivo_dispensa_valido(p text)
returns boolean
language sql
immutable
as $$
  select upper(coalesce(p,'')) in
    ('ACORDO_CANCELADO','NAO_PAGOU','TERMO_SUBSTITUIDO','DUPLICADO','OUTRO');
$$;

-- 1) Não será assinado -------------------------------------------------------
--    Só sai da trilha quem ainda está nela. Idempotente: já dispensado devolve
--    ok sem sobrescrever quem/quando dispensou.
create or replace function public.termo_dispensar_assinatura(
  p_termo_id uuid,
  p_motivo text,
  p_detalhe text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_etapa text;
  v_motivo text := upper(trim(coalesce(p_motivo,'')));
  v_detalhe text := nullif(trim(coalesce(p_detalhe,'')), '');
  v_ator text;
begin
  if not public.usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  if not public._termo_motivo_dispensa_valido(v_motivo) then
    return jsonb_build_object('ok', false, 'erro', 'motivo_invalido');
  end if;
  if v_motivo = 'OUTRO' and v_detalhe is null then
    return jsonb_build_object('ok', false, 'erro', 'detalhe_obrigatorio');
  end if;
  v_ator := coalesce(nullif(public.app_email(), ''), 'ADM');

  select etapa_assinatura into v_etapa
    from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;
  if v_etapa = 'DISPENSADO' then
    return jsonb_build_object('ok', true, 'ja_processado', true, 'etapa', v_etapa);
  end if;
  if v_etapa not in ('NAO_VERIFICADO','PENDENTE_ENVIO','ENVIADO_ASSINATURA') then
    return jsonb_build_object('ok', false, 'erro', 'etapa_invalida', 'etapa', v_etapa);
  end if;

  update public.termos_acordo
     set etapa_assinatura = 'DISPENSADO',
         dispensa_motivo = v_motivo,
         dispensa_detalhe = v_detalhe,
         dispensado_em = now(),
         dispensado_por = v_ator,
         atualizado_em = now()
   where id = p_termo_id;

  return jsonb_build_object('ok', true, 'etapa', 'DISPENSADO', 'motivo', v_motivo);
end;
$$;

-- 2) Voltar para a fila -------------------------------------------------------
--    Dispensa por engano, ou aluno que retomou o pagamento. Volta para
--    PENDENTE_ENVIO (nunca para NAO_VERIFICADO: a ADM já passou por ele).
create or replace function public.termo_reativar_assinatura(p_termo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_etapa text;
begin
  if not public.usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;

  select etapa_assinatura into v_etapa
    from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;
  if v_etapa <> 'DISPENSADO' then
    return jsonb_build_object('ok', false, 'erro', 'etapa_invalida', 'etapa', v_etapa);
  end if;

  update public.termos_acordo
     set etapa_assinatura = 'PENDENTE_ENVIO',
         dispensa_motivo = null,
         dispensa_detalhe = null,
         dispensado_em = null,
         dispensado_por = null,
         atualizado_em = now()
   where id = p_termo_id;

  return jsonb_build_object('ok', true, 'etapa', 'PENDENTE_ENVIO');
end;
$$;

-- 3) Devolver ao operador ----------------------------------------------------
--    Termo liberado (manual ou gov.br) com algo errado. Vira TERMO_REJEITADO
--    com o motivo em observacao_adm, sai da trilha de assinatura e o caso volta
--    ao operador pelo mesmo caminho da rejeição na validação. O arquivo fica.
--    A troca de status dispara trg_recalc_termo_upd (recálculo do caso), como
--    em validar_assinatura_termo.
create or replace function public.termo_devolver_ao_operador(
  p_termo_id uuid,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
as $$
declare
  v_termo public.termos_acordo%rowtype;
  v_motivo text := nullif(trim(coalesce(p_motivo,'')), '');
  v_ator text;
  v_aluno_uuid uuid;
begin
  if not public.usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  if v_motivo is null then
    return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio');
  end if;
  v_ator := coalesce(nullif(public.app_email(), ''), 'ADM');

  select * into v_termo from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;
  if v_termo.status = 'TERMO_REJEITADO' then
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_termo.status);
  end if;
  if v_termo.status not in ('TERMO_RECEBIDO_LIBERADO','TERMO_LIBERADO_AUTOMATICO_GOV') then
    return jsonb_build_object('ok', false, 'erro', 'status_invalido', 'status', v_termo.status);
  end if;
  if v_termo.etapa_assinatura = 'COMPLETO' then
    return jsonb_build_object('ok', false, 'erro', 'assinatura_concluida');
  end if;

  update public.termos_acordo
     set status = 'TERMO_REJEITADO',
         observacao_adm = v_motivo,
         validado_por = v_ator,
         validado_em = now(),
         etapa_assinatura = 'NAO_APLICAVEL',
         assinatura_enviada_em = null,
         assinatura_enviada_por = null,
         dispensa_motivo = null,
         dispensa_detalhe = null,
         dispensado_em = null,
         dispensado_por = null,
         atualizado_em = now()
   where id = p_termo_id;

  begin
    v_aluno_uuid := nullif(v_termo.aluno_id, '')::uuid;
  exception when others then
    v_aluno_uuid := null;
  end;
  if v_aluno_uuid is not null then
    perform public.sistema_retorno_termo(v_aluno_uuid, 'TERMO_REJEITADO', 'TERMO_REJEITADO',
      v_termo.operador_email, coalesce(v_termo.operador_nome, v_termo.operador_email));
  end if;

  return jsonb_build_object('ok', true, 'status', 'TERMO_REJEITADO', 'validado_por', v_ator);
end;
$$;

-- 4) Permissões ---------------------------------------------------------------
--    A ADM chama direto; o gate usuario_e_gestao() está dentro de cada uma.
revoke all on function public._termo_motivo_dispensa_valido(text) from public, anon;
grant execute on function public._termo_motivo_dispensa_valido(text) to authenticated;
revoke all on function public.termo_dispensar_assinatura(uuid, text, text) from public, anon;
grant execute on function public.termo_dispensar_assinatura(uuid, text, text) to authenticated;
revoke all on function public.termo_reativar_assinatura(uuid) from public, anon;
grant execute on function public.termo_reativar_assinatura(uuid) to authenticated;
revoke all on function public.termo_devolver_ao_operador(uuid, text) from public, anon;
grant execute on function public.termo_devolver_ao_operador(uuid, text) to authenticated;
