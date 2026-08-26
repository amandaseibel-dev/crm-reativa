-- "Desfazer assinatura" nunca pode deixar o termo sem arquivo nenhum
-- ---------------------------------------------------------------------------
-- INCIDENTE MEDIDO EM PRODUÇÃO (2026-08-26, relato da Amanda: "documento
-- indisponível, o envio não foi marcado", em vários casos gov).
--
-- Causa raiz: `termo_desfazer_assinatura_concluida` descartava
-- `arquivo_final_url` INCONDICIONALMENTE. Só que a conclusão da assinatura já
-- tinha descartado a via do aluno (`arquivo_url`) — esse é o desenho: o CRM
-- fica só com a via completa. Resultado: desfazer apagava o ÚNICO arquivo que
-- restava e o termo voltava para PENDENTE_ENVIO sem documento algum. A tela
-- pede a URL assinada, a Edge Function responde `sem_documento` (a coluna está
-- vazia) e não há como abrir nem como marcar o envio. O termo fica preso.
--
-- MEDIÇÃO: 10 termos gov nesse estado, todos desfeitos em 2026-08-25 pela mesma
-- pessoa, motivo "refazer"/"reafzer", backup confirmado em 21/08. Os 10
-- arquivos foram REMOVIDOS do Storage (0 sobreviventes) — dentro do CRM não há
-- recuperação, só a pasta de backup fora do sistema. Esta migration impede o
-- próximo caso; não repara os 10, que dependem de reanexar a via do backup.
-- (Há ainda 4 termos gov que nunca tiveram arquivo desde a criação — origem
-- diferente, liberação automática sem documento, fora do escopo daqui.)
--
-- DECISÃO: desfazer continua permitido — "marquei assinado por engano" é uma
-- necessidade real. O que muda é que, quando a via completa é o único arquivo
-- do termo, ela é MANTIDA em vez de descartada. O termo volta para
-- PENDENTE_ENVIO com documento, que é o estado útil. Mesma escolha já feita em
-- `concluir` quando o backup não está confirmado (`adiado_sem_backup`): na
-- dúvida, o arquivo fica.
--
-- A resposta ganha a chave `descarte`, para a tela poder dizer a verdade ao
-- invés de fingir que apagou:
--   'feito'                 -> a via do aluno existe; a completa foi descartada
--   'mantido_unico_arquivo' -> era o único arquivo; foi mantido
--   'sem_arquivo'           -> não havia via completa para descartar

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
  v_tem_final boolean;
  v_tem_via_aluno boolean;
  v_descarte text;
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

  v_tem_final := coalesce(trim(v_termo.arquivo_final_url), '') <> '';
  -- A via do aluno é o que sustenta o termo depois que a completa sai. RG e
  -- verso NÃO contam: são documento de identidade, não são o termo.
  v_tem_via_aluno := coalesce(trim(v_termo.arquivo_url), '') <> '';

  if not v_tem_final then
    v_descarte := 'sem_arquivo';
  elsif v_tem_via_aluno then
    v_descarte := 'feito';
  else
    v_descarte := 'mantido_unico_arquivo';
  end if;

  if v_descarte = 'feito' then
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
         -- Só zera a referência quando o arquivo foi de fato descartado. Zerar
         -- junto com 'mantido_unico_arquivo' recriaria exatamente o furo: linha
         -- sem referência e arquivo órfão no bucket.
         arquivo_final_url = case when v_descarte = 'feito' then null else arquivo_final_url end,
         arquivo_final_nome = case when v_descarte = 'feito' then null else arquivo_final_nome end,
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

  return jsonb_build_object(
    'ok', true,
    'etapa', 'PENDENTE_ENVIO',
    'descarte', v_descarte,
    'itens', v_itens
  );
end;
$$;
