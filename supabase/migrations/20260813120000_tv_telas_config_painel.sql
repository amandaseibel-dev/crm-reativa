-- =============================================================================
-- TV ReATIVA — Painel editável dos slides (visibilidade, ordem e textos extras)
-- -----------------------------------------------------------------------------
-- A gestão passa a controlar pela tela "Mensagem da TV" QUAIS slides aparecem,
-- em QUE ORDEM e com QUE textos extras (subtítulo/observação), sem editar código.
--
-- A config vive em public.tv_config (chave='telas_config', valor jsonb):
--   { "<id_slide>": { "visivel": bool, "ordem": int, "subtitulo": text, "observacao": text }, ... }
-- A escrita já é restrita a Amanda/Fernanda pela RLS existente de tv_config; a
-- leitura é liberada ao usuário do telão (painel.tv) — sem policy nova aqui.
--
-- Como no aniversário-destaque, o payload NÃO recalcula nada: apenas MESCLA a
-- config por cima do resultado de tv_snapshot_calcular(). Por isso só
-- redeclaramos tv_snapshot_atualizar() (função pequena) — a função gigante
-- tv_snapshot_calcular() NÃO é tocada (zero risco de regressão nos slides).
--
-- Esta é cópia FIEL da versão vigente (20260811210000), com UMA linha nova de
-- merge da chave 'telas_config'. Frontend faz upsert da linha; sem seed aqui
-- (slides sem entrada usam o padrão do catálogo no frontend).
-- =============================================================================

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
    -- Mescla o destaque de aniversário (config editável, foto estática no front).
    v_payload := v_payload || jsonb_build_object(
      'aniversario_destaque',
      (select valor from public.tv_config where chave = 'aniversario_destaque' and ativo = true limit 1));
    -- Mescla a config de slides do painel (visibilidade, ordem e textos extras).
    -- Ausente => '{}' e o frontend cai no padrão do catálogo.
    v_payload := v_payload || jsonb_build_object(
      'telas_config',
      coalesce((select valor from public.tv_config where chave = 'telas_config' limit 1), '{}'::jsonb));
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
