-- Termos que não serão assinados: dispensa da trilha de assinatura
-- ---------------------------------------------------------------------------
-- Contexto (Amanda, 2026-08-21): nem todo termo liberado vai rodar por
-- testemunhas. Acordo cancelado, aluno que nunca pagou, termo substituído ou
-- duplicado nunca vão voltar assinados. Sem uma saída, esses termos ficam para
-- sempre em NAO_VERIFICADO e o contador de "faltam assinar" mente para cima.
--
-- MEDIÇÃO QUE MOTIVOU A DECISÃO DE MARCAR À MÃO: tentamos derivar os não pagos
-- do banco e não dá. Dos 748 em NAO_VERIFICADO, 589 aparecem sem nenhuma
-- parcela com pago_em preenchido — mas 425 desses estão com o aluno em
-- AGUARDANDO_BAIXA, ou seja, pagaram e esperam o financeiro registrar. E só 2
-- têm acordo exclusivamente CANCELADO. O sinal não é confiável; quem sabe quais
-- acordos morreram é a operação.
--
-- Decisão da Amanda: ao dispensar, o arquivo é DESCARTADO como nos demais
-- (fica só na pasta de backup fora do CRM). Ressalva registrada: a via assinada
-- de quem não pagou é a confissão de dívida.
--
-- A dispensa é REVERSÍVEL: se o aluno voltar a pagar, o termo volta para
-- PENDENTE_ENVIO. O que não volta é o arquivo já descartado.

alter table public.termos_acordo
  add column if not exists dispensa_motivo text,
  add column if not exists dispensado_em timestamptz,
  add column if not exists dispensado_por text;

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

-- Dispensar em lote: marca a etapa, guarda o motivo e devolve os arquivos a
-- apagar. A remoção física fica com a Edge Function, única com permissão no
-- Storage. COMPLETO não pode ser dispensado: já foi assinado.
create or replace function public.termos_dispensar_assinatura(
  p_ids uuid[],
  p_motivo text,
  p_ator text,
  p_gestao boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_desc jsonb;
  v_itens jsonb := '[]'::jsonb;
  v_marcados int := 0;
  v_motivo text := upper(coalesce(p_motivo,''));
begin
  if coalesce(p_gestao, false) is not true then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  if not public._termo_motivo_dispensa_valido(v_motivo) then
    return jsonb_build_object('ok', false, 'erro', 'motivo_invalido');
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return jsonb_build_object('ok', false, 'erro', 'sem_termos');
  end if;

  foreach v_id in array p_ids loop
    update public.termos_acordo
       set etapa_assinatura = 'DISPENSADO',
           dispensa_motivo = v_motivo,
           dispensado_em = now(),
           dispensado_por = p_ator,
           atualizado_em = now()
     where id = v_id
       and etapa_assinatura in ('NAO_VERIFICADO','PENDENTE_ENVIO','ENVIADO_ASSINATURA');

    if found then
      v_marcados := v_marcados + 1;
      v_desc := public._termo_descartar_vias(v_id, p_ator, 'DISPENSADO_' || v_motivo);
      if coalesce((v_desc->>'ok')::boolean, false) then
        v_itens := v_itens || coalesce(v_desc->'itens', '[]'::jsonb);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'marcados', v_marcados,
    'ignorados', array_length(p_ids, 1) - v_marcados,
    'itens', v_itens);
end;
$$;

-- Voltar atrás: o termo dispensado por engano (ou o aluno que retomou o
-- pagamento) volta para a fila. O arquivo já descartado NÃO volta.
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
         dispensado_em = null,
         dispensado_por = null,
         atualizado_em = now()
   where id = p_termo_id;

  return jsonb_build_object('ok', true, 'etapa', 'PENDENTE_ENVIO');
end;
$$;

revoke all on function public.termos_dispensar_assinatura(uuid[], text, text, boolean) from public, anon, authenticated;
grant execute on function public.termos_dispensar_assinatura(uuid[], text, text, boolean) to service_role;
revoke all on function public.termo_reativar_assinatura(uuid) from public, anon;
grant execute on function public.termo_reativar_assinatura(uuid) to authenticated;
