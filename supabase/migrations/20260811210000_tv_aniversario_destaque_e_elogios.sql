-- =============================================================================
-- TV ReATIVA — destaque de aniversário (foto + mensagem) + habilita elogios
-- -----------------------------------------------------------------------------
-- 1) tv_snapshot_atualizar passa a MESCLAR no payload a chave
--    'aniversario_destaque' lida de tv_config (chave='aniversario_destaque',
--    ativo=true). Sem tocar em tv_snapshot_calcular. A EXIBIÇÃO é decidida no
--    cliente pela data (só aparece no dia exato) — sem query/carga extra.
-- 2) Insere a config do aniversário do João (12/08/2026). A foto é servida como
--    arquivo estático do frontend (/tv/aniversario-joao.jpg) — nada de imagem no
--    banco/snapshot. Mensagem editável depois via update em tv_config.
-- Os elogios já vêm no snapshot ('elogios'); o slide foi adicionado no frontend.
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

-- Config do aniversário do João (só aparece 12/08/2026, gate no cliente).
insert into public.tv_config (chave, ativo, valor, atualizado_em)
values (
  'aniversario_destaque', true,
  jsonb_build_object(
    'nome', 'João',
    'mensagem', 'Feliz aniversário, João! 🎉 Que este novo ciclo venha cheio de conquistas. Obrigado por fazer parte do time ReATIVA — hoje o dia é seu!',
    'foto', '/tv/aniversario-joao.jpg',
    'data', '2026-08-12'
  ),
  now())
on conflict (chave) do update
  set ativo = excluded.ativo, valor = excluded.valor, atualizado_em = now();
