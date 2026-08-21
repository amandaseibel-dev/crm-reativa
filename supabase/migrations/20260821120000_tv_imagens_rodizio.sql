-- =============================================================================
-- TV ReATIVA — Imagens prontas no rodízio de slides
-- -----------------------------------------------------------------------------
-- A gestão sobe imagens (arte pronta, cartaz, comunicado) pela tela
-- "Mensagem da TV" e elas entram no rodízio como slides, misturadas aos demais
-- (ligar/ocultar, ordem e legenda controlados no mesmo painel).
--
-- Armazenamento:
--   • arquivo  -> bucket storage 'tv-imagens' (PÚBLICO para leitura: o telão roda
--                 sem login; conteúdo é institucional, sem PII). Escrita só
--                 Amanda/Fernanda (mesma allowlist de tv_config).
--   • lista    -> public.tv_config (chave='imagens', valor jsonb):
--                 { "itens": [ { "id", "path", "url", "nome", "legenda" }, ... ] }
--                 visibilidade/ordem de cada imagem ficam em telas_config sob a
--                 chave 'img:<id>' (igual aos outros slides).
--
-- Como nas mudanças anteriores, o payload NÃO recalcula nada: só MESCLA a
-- lista por cima de tv_snapshot_calcular(). tv_snapshot_calcular NÃO é tocada.
-- =============================================================================

-- 1) Bucket público de leitura, 5 MB por arquivo, só imagens.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tv-imagens', 'tv-imagens', true, 5242880,
        array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2) Policies: leitura para todos (bucket público); escrita só gestão da TV.
drop policy if exists tv_imagens_select on storage.objects;
create policy tv_imagens_select on storage.objects for select
  to anon, authenticated using (bucket_id = 'tv-imagens');

drop policy if exists tv_imagens_insert on storage.objects;
create policy tv_imagens_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tv-imagens'
    and lower((select auth.email())) = any (array['amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br']));

drop policy if exists tv_imagens_update on storage.objects;
create policy tv_imagens_update on storage.objects for update to authenticated
  using (bucket_id = 'tv-imagens'
    and lower((select auth.email())) = any (array['amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br']));

drop policy if exists tv_imagens_delete on storage.objects;
create policy tv_imagens_delete on storage.objects for delete to authenticated
  using (bucket_id = 'tv-imagens'
    and lower((select auth.email())) = any (array['amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br']));

-- 3) tv_snapshot_atualizar: cópia FIEL da versão vigente (20260813120000) com
--    UMA mescla nova: a chave 'imagens'.
CREATE OR REPLACE FUNCTION public.tv_snapshot_atualizar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
declare
  v_email text := lower(auth.email());
  v_got boolean; v_t0 timestamptz; v_now timestamptz; v_ms int; v_payload jsonb; v_versao bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and coalesce(v_email,'') not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    raise exception 'Acesso negado: apenas Amanda e Fernanda podem atualizar a TV (usuario=%).',
      coalesce(v_email,'(anonimo)') using errcode = '42501';
  end if;
  v_got := pg_try_advisory_xact_lock(hashtext('tv_snapshot_atualizar')::int, 0);
  if not v_got then
    raise exception 'Ja existe uma atualizacao da TV em andamento.' using errcode = '55P03';
  end if;
  insert into public.tv_snapshot (id) values (true) on conflict (id) do nothing;
  v_t0 := clock_timestamp(); v_now := now();
  begin
    if coalesce(current_setting('tv.forcar_erro', true),'') = '1' then
      raise exception 'FALHA_SIMULADA_TESTE';
    end if;
    v_payload := public.tv_snapshot_calcular();
    v_payload := v_payload || jsonb_build_object(
      'aniversario_destaque',
      (select valor from public.tv_config where chave = 'aniversario_destaque' and ativo = true limit 1));
    v_payload := v_payload || jsonb_build_object(
      'telas_config',
      coalesce((select valor from public.tv_config where chave = 'telas_config' limit 1), '{}'::jsonb));
    -- Imagens prontas do rodízio (lista editada no painel). Ausente => sem slides de imagem.
    v_payload := v_payload || jsonb_build_object(
      'imagens',
      coalesce((select valor from public.tv_config where chave = 'imagens' and ativo = true limit 1),
               '{"itens":[]}'::jsonb));
    v_ms := round(extract(milliseconds from clock_timestamp() - v_t0));
    update public.tv_snapshot
       set versao = versao + 1, payload = v_payload, status = 'ok',
           gerado_em = v_now, gerado_por = coalesce(v_email,'service_role'), duracao_ms = v_ms, erro_resumo = null
     where id = true returning versao into v_versao;
  exception when others then
    update public.tv_snapshot set status = 'erro', erro_resumo = left(sqlerrm, 300),
           gerado_em = v_now, gerado_por = coalesce(v_email,'service_role') where id = true;
    return jsonb_build_object('status','erro','erro_resumo',left(sqlerrm,300));
  end;
  return jsonb_build_object('status','ok','versao',v_versao,'duracao_ms',v_ms,
    'gerado_em', v_now, 'gerado_por', coalesce(v_email,'service_role'));
end;
$function$;
