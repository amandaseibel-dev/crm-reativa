-- Fluxo de assinatura de testemunhas + Ulbra nos termos de acordo
-- ---------------------------------------------------------------------------
-- Contexto e decisões (Amanda, 2026-08-21):
-- Hoje o termo guardado no CRM é sempre a via assinada SÓ pelo aluno (mais RG e
-- verso, quando manual). Depois que o acordo é efetivamente pago, esse termo
-- precisa rodar para DUAS TESTEMUNHAS e para a ULBRA (assinatura eletrônica
-- gov.br) e voltar completo. O CRM deve ficar apenas com a via completa; a via
-- só-aluno é descartada para não ocupar espaço, e existe uma pasta de backup
-- FORA do CRM (Drive/rede da Aelbra) guardando as duas vias.
--
-- Decisões que este migration materializa:
--   * A entrada na fila é MANUAL (a ADM marca quais termos vão para assinatura);
--     não há gatilho automático por pagamento.
--   * A via completa é anexada pela ADM e, no mesmo ato, a via só-aluno (+ RG +
--     verso) é descartada do Storage.
--   * O descarte é do ARQUIVO, nunca da LINHA: a linha sustenta a auditoria de
--     quem validou a assinatura do aluno e quando. A tabela inteira tem ~648 kB;
--     o espaço está nos 386 MB de arquivos do bucket `termos-acordo`.
--   * Os 748 termos que já existem NÃO viram "pendentes": ninguém sabe quais já
--     rodaram por testemunha no papel. Eles nascem em NAO_VERIFICADO, mesmo
--     tratamento dado ao gov legado em 20260812180000. O contador da ADM fica
--     honesto e a fila legada é zerada conforme a ADM confere.
--
-- NÃO altera `status`, que move a fila de validação, o gatilho de notificação ao
-- operador (trg_notif_termo_gov) e o badge do menu. A trilha de assinatura é uma
-- coluna própria, para as duas coisas não se contaminarem.

-- 1) Trilha de assinatura em termos_acordo ------------------------------------
alter table public.termos_acordo
  add column if not exists etapa_assinatura text not null default 'NAO_APLICAVEL',
  add column if not exists assinatura_enviada_em timestamptz,
  add column if not exists assinatura_enviada_por text,
  add column if not exists arquivo_final_nome text,
  add column if not exists arquivo_final_url text,
  add column if not exists assinatura_completa_em timestamptz,
  add column if not exists assinatura_completa_por text,
  add column if not exists testemunha_1_nome text,
  add column if not exists testemunha_2_nome text,
  add column if not exists backup_confirmado_em timestamptz,
  add column if not exists backup_confirmado_por text;

comment on column public.termos_acordo.etapa_assinatura is
  'Trilha de assinatura de testemunhas/Ulbra, independente de status: '
  'NAO_APLICAVEL (termo ainda não liberado pela ADM) | '
  'NAO_VERIFICADO (liberado antes deste fluxo existir; ninguém sabe se já rodou) | '
  'PENDENTE_ENVIO (liberado dentro do fluxo, ainda não enviado) | '
  'ENVIADO_ASSINATURA (saiu para gov.br, aguardando volta) | '
  'COMPLETO (via completa anexada; via só-aluno descartada)';

comment on column public.termos_acordo.arquivo_final_url is
  'Caminho interno da VIA COMPLETA (aluno + 2 testemunhas + Ulbra) no bucket '
  'termos-acordo. Depois do descarte é o único documento do termo no CRM.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'termos_acordo_etapa_assinatura_check'
  ) then
    alter table public.termos_acordo
      add constraint termos_acordo_etapa_assinatura_check
      check (etapa_assinatura in (
        'NAO_APLICAVEL','NAO_VERIFICADO','PENDENTE_ENVIO','ENVIADO_ASSINATURA','COMPLETO'));
  end if;
end$$;

-- Índice do painel da ADM: conta e lista por etapa.
create index if not exists ix_termos_acordo_etapa_assinatura
  on public.termos_acordo (etapa_assinatura, validado_em desc);

-- 2) Backfill do legado -------------------------------------------------------
--    Só o que JÁ está liberado entra como NAO_VERIFICADO. Termo pendente de
--    validação ou rejeitado continua NAO_APLICAVEL: não há o que assinar ainda.
update public.termos_acordo
   set etapa_assinatura = 'NAO_VERIFICADO'
 where status in ('TERMO_RECEBIDO_LIBERADO','TERMO_LIBERADO_AUTOMATICO_GOV')
   and etapa_assinatura = 'NAO_APLICAVEL';

-- 3) Termo novo que for liberado nasce PENDENTE_ENVIO -------------------------
--    BEFORE (não AFTER): grava na própria linha sem UPDATE extra. Só promove a
--    partir de NAO_APLICAVEL, então nunca rebaixa um termo já enviado/completo
--    nem mexe no legado NAO_VERIFICADO.
create or replace function public._trg_termo_etapa_assinatura()
  returns trigger
  language plpgsql
as $function$
begin
  if new.status in ('TERMO_RECEBIDO_LIBERADO','TERMO_LIBERADO_AUTOMATICO_GOV')
     and coalesce(new.etapa_assinatura,'NAO_APLICAVEL') = 'NAO_APLICAVEL'
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
  then
    new.etapa_assinatura := 'PENDENTE_ENVIO';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_termo_etapa_assinatura on public.termos_acordo;
create trigger trg_termo_etapa_assinatura
  before insert or update on public.termos_acordo
  for each row execute function public._trg_termo_etapa_assinatura();

-- 4) Auditoria de descarte ----------------------------------------------------
--    Uma linha por ARQUIVO apagado. `removido_do_storage_em` só é carimbado
--    depois que o Storage confirma a remoção: linha com NULL = objeto órfão que
--    ainda precisa sair do bucket (permite reprocessar sem perder rastro).
create table if not exists public.termo_arquivos_descartados (
  id uuid primary key default gen_random_uuid(),
  termo_id uuid not null references public.termos_acordo(id) on delete cascade,
  campo text not null check (campo in ('arquivo','rg','verso')),
  arquivo_nome text,
  caminho text not null,
  substituido_por text,
  motivo text not null default 'VIA_COMPLETA_ANEXADA',
  descartado_por text not null,
  descartado_em timestamptz not null default now(),
  removido_do_storage_em timestamptz
);

create index if not exists ix_termo_descartes_termo on public.termo_arquivos_descartados (termo_id);
create index if not exists ix_termo_descartes_orfaos
  on public.termo_arquivos_descartados (descartado_em)
  where removido_do_storage_em is null;

alter table public.termo_arquivos_descartados enable row level security;
-- Deny-all: só service_role (Edge Function) escreve; leitura pela gestão via RPC.

-- 5) Marcar envio para assinatura (gov.br) ------------------------------------
--    Aceita lote: a ADM seleciona vários e marca de uma vez (os 748 legados não
--    podem exigir 748 cliques). Idempotente: quem já está ENVIADO é ignorado, e
--    o carimbo original de quem enviou é preservado.
create or replace function public.termos_marcar_envio_assinatura(
  p_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ator text;
  v_marcados int := 0;
  v_ignorados int := 0;
begin
  if not public.usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return jsonb_build_object('ok', false, 'erro', 'sem_termos');
  end if;
  v_ator := coalesce(public.app_email(), 'ADM');

  with alvo as (
    select id from public.termos_acordo
     where id = any(p_ids)
       and etapa_assinatura in ('PENDENTE_ENVIO','NAO_VERIFICADO')
     for update
  ), mexidos as (
    update public.termos_acordo t
       set etapa_assinatura = 'ENVIADO_ASSINATURA',
           assinatura_enviada_em = now(),
           assinatura_enviada_por = v_ator,
           atualizado_em = now()
      from alvo
     where t.id = alvo.id
     returning t.id
  )
  select count(*) into v_marcados from mexidos;

  v_ignorados := array_length(p_ids, 1) - v_marcados;
  return jsonb_build_object('ok', true, 'marcados', v_marcados, 'ignorados', v_ignorados);
end;
$$;

-- 6) Desfazer envio (erro de clique) ------------------------------------------
--    Volta para PENDENTE_ENVIO, nunca para NAO_VERIFICADO: depois que a ADM
--    passou por ele, o termo deixou de ser "ninguém sabe". Não desfaz COMPLETO —
--    a via já foi anexada e a antiga, descartada.
create or replace function public.termo_desfazer_envio_assinatura(p_termo_id uuid)
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
  if v_etapa = 'PENDENTE_ENVIO' then
    return jsonb_build_object('ok', true, 'ja_processado', true, 'etapa', v_etapa);
  end if;
  if v_etapa <> 'ENVIADO_ASSINATURA' then
    return jsonb_build_object('ok', false, 'erro', 'etapa_invalida', 'etapa', v_etapa);
  end if;

  update public.termos_acordo
     set etapa_assinatura = 'PENDENTE_ENVIO',
         assinatura_enviada_em = null,
         assinatura_enviada_por = null,
         atualizado_em = now()
   where id = p_termo_id;

  return jsonb_build_object('ok', true, 'etapa', 'PENDENTE_ENVIO');
end;
$$;

-- 7) Descarte das vias antigas (interno) --------------------------------------
--    Registra a auditoria e LIMPA as colunas, devolvendo os caminhos para a Edge
--    Function apagar do Storage. Não apaga a linha do termo. Ordem proposital:
--    o registro do descarte nasce ANTES da remoção física; se o Storage falhar,
--    a linha fica com removido_do_storage_em NULL e o objeto é rastreável em vez
--    de virar órfão silencioso.
create or replace function public._termo_descartar_vias(
  p_termo_id uuid,
  p_ator text,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_termo public.termos_acordo%rowtype;
  v_itens jsonb := '[]'::jsonb;
  v_id uuid;
begin
  select * into v_termo from public.termos_acordo where id = p_termo_id;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;

  -- arquivo principal (via assinada só pelo aluno)
  if coalesce(trim(v_termo.arquivo_url), '') <> '' then
    insert into public.termo_arquivos_descartados
      (termo_id, campo, arquivo_nome, caminho, substituido_por, motivo, descartado_por)
    values
      (p_termo_id, 'arquivo', v_termo.arquivo_nome, v_termo.arquivo_url,
       v_termo.arquivo_final_url, p_motivo, p_ator)
    returning id into v_id;
    v_itens := v_itens || jsonb_build_object('id', v_id, 'caminho', v_termo.arquivo_url);
  end if;

  if coalesce(trim(v_termo.arquivo_rg_url), '') <> '' then
    insert into public.termo_arquivos_descartados
      (termo_id, campo, arquivo_nome, caminho, substituido_por, motivo, descartado_por)
    values
      (p_termo_id, 'rg', v_termo.arquivo_rg_nome, v_termo.arquivo_rg_url,
       v_termo.arquivo_final_url, p_motivo, p_ator)
    returning id into v_id;
    v_itens := v_itens || jsonb_build_object('id', v_id, 'caminho', v_termo.arquivo_rg_url);
  end if;

  if coalesce(trim(v_termo.arquivo_verso_url), '') <> '' then
    insert into public.termo_arquivos_descartados
      (termo_id, campo, arquivo_nome, caminho, substituido_por, motivo, descartado_por)
    values
      (p_termo_id, 'verso', v_termo.arquivo_verso_nome, v_termo.arquivo_verso_url,
       v_termo.arquivo_final_url, p_motivo, p_ator)
    returning id into v_id;
    v_itens := v_itens || jsonb_build_object('id', v_id, 'caminho', v_termo.arquivo_verso_url);
  end if;

  -- Zera as colunas: a tela não pode oferecer link para objeto que não existe
  -- mais ("documento indisponível"). O nome fica no registro de descarte.
  update public.termos_acordo
     set arquivo_url = null, arquivo_nome = null,
         arquivo_rg_url = null, arquivo_rg_nome = null,
         arquivo_verso_url = null, arquivo_verso_nome = null,
         atualizado_em = now()
   where id = p_termo_id;

  return jsonb_build_object('ok', true, 'itens', v_itens);
end;
$$;

-- 8) Concluir: via completa anexada -> COMPLETO + descarte das vias antigas ----
--    Chamada pela Edge Function (service_role) DEPOIS de o arquivo final estar
--    vinculado e conferido no bucket. p_gestao vem da mesma checagem de perfil
--    que a Edge já faz para ler/subir documento (padrão do docfin_vincular).
--    Sem confirmação de backup o termo fica COMPLETO mas NÃO descarta: a pasta
--    de backup fora do CRM guarda as duas vias, e não dá para apagar a via do
--    aluno antes de ela estar lá.
create or replace function public.termo_concluir_assinatura(
  p_termo_id uuid,
  p_ator text,
  p_gestao boolean,
  p_testemunha_1 text default null,
  p_testemunha_2 text default null,
  p_backup_confirmado boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_termo public.termos_acordo%rowtype;
  v_desc jsonb;
  v_pendentes jsonb;
begin
  if coalesce(p_gestao, false) is not true then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;

  select * into v_termo from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;

  -- A via completa TEM de existir. Sem ela não há o que concluir nem o que
  -- substituir; é a trava que impede o descarte de virar perda de documento.
  if coalesce(trim(v_termo.arquivo_final_url), '') = '' then
    return jsonb_build_object('ok', false, 'erro', 'sem_via_completa');
  end if;

  -- Idempotência: já concluído -> devolve os descartes que ainda não saíram do
  -- Storage, para a Edge reprocessar sem duplicar auditoria.
  if v_termo.etapa_assinatura = 'COMPLETO' then
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'caminho', caminho)), '[]'::jsonb)
      into v_pendentes
      from public.termo_arquivos_descartados
     where termo_id = p_termo_id and removido_do_storage_em is null;
    return jsonb_build_object('ok', true, 'ja_processado', true, 'itens', v_pendentes);
  end if;

  update public.termos_acordo
     set etapa_assinatura = 'COMPLETO',
         assinatura_completa_em = now(),
         assinatura_completa_por = p_ator,
         testemunha_1_nome = nullif(trim(coalesce(p_testemunha_1, '')), ''),
         testemunha_2_nome = nullif(trim(coalesce(p_testemunha_2, '')), ''),
         backup_confirmado_em = case when p_backup_confirmado then now() else backup_confirmado_em end,
         backup_confirmado_por = case when p_backup_confirmado then p_ator else backup_confirmado_por end,
         atualizado_em = now()
   where id = p_termo_id;

  if not coalesce(p_backup_confirmado, false) then
    return jsonb_build_object('ok', true, 'etapa', 'COMPLETO', 'descarte', 'adiado_sem_backup', 'itens', '[]'::jsonb);
  end if;

  v_desc := public._termo_descartar_vias(p_termo_id, p_ator, 'VIA_COMPLETA_ANEXADA');
  return jsonb_build_object('ok', true, 'etapa', 'COMPLETO', 'itens', coalesce(v_desc->'itens', '[]'::jsonb));
end;
$$;

-- 9) Descarte avulso (sem via completa) ---------------------------------------
--    Para o termo cuja via completa ainda não voltou mas que já está salvo na
--    pasta de backup. Exige a confirmação explícita do backup — sem ela não
--    apaga nada.
create or replace function public.termo_descartar_via_aluno(
  p_termo_id uuid,
  p_ator text,
  p_gestao boolean,
  p_backup_confirmado boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_desc jsonb;
begin
  if coalesce(p_gestao, false) is not true then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  if coalesce(p_backup_confirmado, false) is not true then
    return jsonb_build_object('ok', false, 'erro', 'backup_nao_confirmado');
  end if;
  if not exists (select 1 from public.termos_acordo where id = p_termo_id for update) then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;

  update public.termos_acordo
     set backup_confirmado_em = now(), backup_confirmado_por = p_ator, atualizado_em = now()
   where id = p_termo_id;

  v_desc := public._termo_descartar_vias(p_termo_id, p_ator, 'BACKUP_SALVO_SEM_VIA_COMPLETA');
  return jsonb_build_object('ok', true, 'itens', coalesce(v_desc->'itens', '[]'::jsonb));
end;
$$;

-- 10) Confirmação da remoção física no Storage --------------------------------
create or replace function public.termo_confirmar_descarte_storage(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_n int := 0;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return jsonb_build_object('ok', true, 'confirmados', 0);
  end if;
  with x as (
    update public.termo_arquivos_descartados
       set removido_do_storage_em = now()
     where id = any(p_ids) and removido_do_storage_em is null
     returning id
  )
  select count(*) into v_n from x;
  return jsonb_build_object('ok', true, 'confirmados', v_n);
end;
$$;

-- 11) Permissões --------------------------------------------------------------
--     Marcar envio e desfazer: a ADM chama direto (gate usuario_e_gestao dentro).
revoke all on function public.termos_marcar_envio_assinatura(uuid[]) from public, anon;
grant execute on function public.termos_marcar_envio_assinatura(uuid[]) to authenticated;
revoke all on function public.termo_desfazer_envio_assinatura(uuid) from public, anon;
grant execute on function public.termo_desfazer_envio_assinatura(uuid) to authenticated;

--     Concluir/descartar: SÓ a Edge Function, que apaga o objeto no Storage.
--     O cliente nunca chama direto (mesmo padrão do docfin_vincular).
revoke all on function public.termo_concluir_assinatura(uuid, text, boolean, text, text, boolean) from public, anon, authenticated;
grant execute on function public.termo_concluir_assinatura(uuid, text, boolean, text, text, boolean) to service_role;
revoke all on function public.termo_descartar_via_aluno(uuid, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.termo_descartar_via_aluno(uuid, text, boolean, boolean) to service_role;
revoke all on function public._termo_descartar_vias(uuid, text, text) from public, anon, authenticated;
grant execute on function public._termo_descartar_vias(uuid, text, text) to service_role;
revoke all on function public.termo_confirmar_descarte_storage(uuid[]) from public, anon, authenticated;
grant execute on function public.termo_confirmar_descarte_storage(uuid[]) to service_role;
