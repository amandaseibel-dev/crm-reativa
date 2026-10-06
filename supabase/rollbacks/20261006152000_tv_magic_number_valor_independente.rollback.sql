-- ============================================================================
-- ROLLBACK de 20261006152000 -- devolve tv_snapshot_atualizar à versão
-- 20261001142500 (sem a chave 'magic') e descarta a tabela do Magic Number.
-- ============================================================================
-- ORDEM IMPORTA: primeiro a função para de ler a tabela, só depois a tabela cai.
-- Invertido, uma atualização da TV disparada no meio do caminho encontraria a
-- função viva apontando para uma tabela que já não existe.
--
-- O QUE ISTO APAGA: o valor do Magic Number de cada competência cadastrada,
-- incluindo os R$ 142.800,00 de outubro/2026. Não há outra cópia — o valor é
-- independente por definição e não se recalcula a partir da meta. Guarde o
-- conteúdo antes de rodar:
--   select * from public.magic_number_mensal order by mes_referencia;
--
-- O QUE ISTO NÃO MEXE: metas_projecao (a meta piso), tv_snapshot_calcular e
-- qualquer cálculo financeiro. O snapshot seguinte simplesmente volta a sair
-- sem a chave 'magic', e o slide some do rodízio sozinho.
-- ============================================================================

begin;

-- 1) Função de volta ao corpo de 20261001142500, sem a mescla de 'magic'.
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
  v_t0 := clock_timestamp();
  v_now := now();

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

    v_payload := v_payload || jsonb_build_object(
      'imagens',
      coalesce((select valor from public.tv_config where chave = 'imagens' and ativo = true limit 1),
               '{"itens":[]}'::jsonb));

    v_payload := v_payload || jsonb_build_object(
      'playlist_reativa',
      coalesce((
        select jsonb_agg(to_jsonb(x) order by x.criado_em desc)
        from (
          select id, titulo, artista, adicionado_por, criado_em
          from public.portal_playlist
          where ativo = true
          order by criado_em desc
          limit 6
        ) x
      ), '[]'::jsonb));

    v_payload := v_payload || jsonb_build_object(
      'eventos_portal',
      coalesce((
        select jsonb_agg(to_jsonb(x) order by x.inicio_em asc)
        from (
          select id, titulo, inicio_em, categoria
          from public.portal_eventos
          where ativo = true
            and inicio_em >= now()
          order by inicio_em asc
          limit 6
        ) x
      ), '[]'::jsonb));

    v_ms := round(extract(milliseconds from clock_timestamp() - v_t0));

    update public.tv_snapshot
       set versao = versao + 1,
           payload = v_payload,
           status = 'ok',
           gerado_em = v_now,
           gerado_por = coalesce(v_email,'service_role'),
           duracao_ms = v_ms,
           erro_resumo = null
     where id = true
     returning versao into v_versao;

  exception when others then
    update public.tv_snapshot
       set status = 'erro',
           erro_resumo = left(sqlerrm, 300),
           gerado_em = v_now,
           gerado_por = coalesce(v_email,'service_role')
     where id = true;

    return jsonb_build_object('status','erro','erro_resumo',left(sqlerrm,300));
  end;

  return jsonb_build_object(
    'status','ok',
    'versao',v_versao,
    'duracao_ms',v_ms,
    'gerado_em',v_now,
    'gerado_por',coalesce(v_email,'service_role')
  );
end;
$function$;

-- 2) Só agora a tabela.
drop table if exists public.magic_number_mensal;

commit;
