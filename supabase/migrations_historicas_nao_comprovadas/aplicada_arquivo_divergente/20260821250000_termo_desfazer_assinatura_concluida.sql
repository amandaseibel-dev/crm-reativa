-- Desfazer "Termo assinado" (etapa COMPLETO) marcado por engano
-- ---------------------------------------------------------------------------
-- Contexto (Amanda, 2026-08-21): a ADM entendeu o fluxo errado e anexou como
-- "via completa" termos que ainda estavam SEM as assinaturas de testemunhas/
-- Ulbra. Dez termos gov.br viraram COMPLETO no mesmo dia, todos sem nome de
-- testemunha, e a via só-aluno de cada um já tinha sido descartada do Storage.
--
-- Decisão da Amanda: o arquivo sem assinaturas NÃO precisa ser guardado — só
-- o termo assinado interessa e ele será anexado depois. Então o desfazer:
--   * volta COMPLETO -> PENDENTE_ENVIO (fila "A enviar"; nunca NAO_VERIFICADO,
--     porque a ADM já passou por ele);
--   * descarta o arquivo anexado como "final" pela trilha de auditoria
--     (termo_arquivos_descartados, campo 'final') e devolve os itens para a
--     Edge apagar do Storage — mesmo padrão do concluir;
--   * zera testemunhas/datas da conclusão e registra quem desfez e por quê.
-- A via do aluno já descartada não volta (fica na pasta de backup fora do CRM).
--
-- Chamada pela Edge documento-financeiro-url (service_role), que já faz o gate
-- de gestão; por isso p_ator/p_gestao vêm por parâmetro, como no concluir.

alter table public.termos_acordo
  add column if not exists assinatura_desfeita_em timestamptz,
  add column if not exists assinatura_desfeita_por text,
  add column if not exists assinatura_desfeita_motivo text;

alter table public.termo_arquivos_descartados drop constraint if exists termo_arquivos_descartados_campo_check;
alter table public.termo_arquivos_descartados
  add constraint termo_arquivos_descartados_campo_check
  check (campo in ('arquivo','rg','verso','final'));

drop function if exists public.termo_desfazer_assinatura_concluida(uuid, text);

create or replace function public.termo_desfazer_assinatura_concluida(
  p_termo_id uuid,
  p_ator text,
  p_gestao boolean,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_termo public.termos_acordo%rowtype;
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_itens jsonb := '[]'::jsonb;
  v_desc_id uuid;
begin
  if coalesce(p_gestao, false) is not true then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;

  select * into v_termo from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;
  if v_termo.etapa_assinatura <> 'COMPLETO' then
    return jsonb_build_object('ok', false, 'erro', 'etapa_invalida', 'etapa', v_termo.etapa_assinatura);
  end if;

  if coalesce(trim(v_termo.arquivo_final_url), '') <> '' then
    insert into public.termo_arquivos_descartados
      (termo_id, campo, arquivo_nome, caminho, substituido_por, motivo, descartado_por)
    values
      (p_termo_id, 'final', v_termo.arquivo_final_nome, v_termo.arquivo_final_url,
       null, 'ASSINATURA_DESFEITA' || coalesce(' — ' || v_motivo, ''), p_ator)
    returning id into v_desc_id;
    v_itens := v_itens || jsonb_build_object('id', v_desc_id, 'caminho', v_termo.arquivo_final_url);
  end if;

  update public.termos_acordo
     set etapa_assinatura = 'PENDENTE_ENVIO',
         arquivo_final_url = null,
         arquivo_final_nome = null,
         assinatura_completa_em = null,
         assinatura_completa_por = null,
         testemunha_1_nome = null,
         testemunha_2_nome = null,
         assinatura_enviada_em = null,
         assinatura_enviada_por = null,
         assinatura_desfeita_em = now(),
         assinatura_desfeita_por = p_ator,
         assinatura_desfeita_motivo = v_motivo,
         atualizado_em = now()
   where id = p_termo_id;

  return jsonb_build_object('ok', true, 'etapa', 'PENDENTE_ENVIO', 'itens', v_itens);
end;
$$;

revoke all on function public.termo_desfazer_assinatura_concluida(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.termo_desfazer_assinatura_concluida(uuid, text, boolean, text) to service_role;
