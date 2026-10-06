-- =============================================================================
-- TV ReATIVA — Magic Number vira VALOR PRÓPRIO por competência
-- -----------------------------------------------------------------------------
-- O Magic Number nunca teve número próprio. Ele era DERIVADO, e de dois jeitos
-- diferentes ao mesmo tempo:
--
--   • a tela do telão (TelaMagicNumber) calculava meta_empresa * 1,5;
--   • o card 'magic' de snap.metas usava os honorários do MÊS ANTERIOR
--     (20260811220000_tv_magic_number_comparativo_mes_anterior.sql).
--
-- Nenhuma das duas bate com o que a gestão combina. Decisão de 06/10/2026: o
-- Magic Number é um valor INDEPENDENTE, definido por competência, que não se
-- calcula a partir da meta piso. Para outubro/2026: R$ 142.800,00, contra uma
-- meta piso de R$ 122.400,00 — uma relação que nenhum fator fixo reproduz.
--
-- A meta piso continua onde sempre esteve: metas_projecao.meta_honorario. Esta
-- migration NÃO toca nela.
--
-- POR QUE TABELA PRÓPRIA, e não coluna em metas_projecao: gravar lá exigiria
-- mexer em projecao_definir_meta, que é anterior ao versionamento e cujo corpo
-- não existe neste repositório. Tabela nova é aditiva e não arrisca a função
-- que a Projeção Hora a Hora usa para salvar as metas.
--
-- POR QUE O PAYLOAD É MESCLADO em tv_snapshot_atualizar, e não calculado em
-- tv_snapshot_calcular: mesmo caminho das imagens (20260821120000) e do portal
-- (20261001142500). tv_snapshot_calcular NÃO é tocada — nenhum cálculo
-- financeiro existente é reescrito.
--
-- O realizado do Magic Number é o MESMO da meta piso: snap.mes.honorarios, que
-- já vem de tv_snapshot_calcular. Só o alvo muda.
--
-- DESFAZER: supabase/rollbacks/20261006152000_tv_magic_number_valor_independente.rollback.sql
-- =============================================================================

-- 1) A tabela. Uma linha por competência; sem competência cadastrada, a TV
--    esconde o slide em vez de inventar número.
create table if not exists public.magic_number_mensal (
  mes_referencia text primary key check (mes_referencia ~ '^\d{4}-\d{2}$'),
  valor numeric not null check (valor > 0),
  observacao text,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);

comment on table public.magic_number_mensal is
  'Magic Number por competência (YYYY-MM). Valor INDEPENDENTE: não se deriva de metas_projecao.meta_honorario nem dos honorários do mês anterior.';

alter table public.magic_number_mensal enable row level security;

-- Leitura para quem está logado: a tela da Projeção precisa mostrar o valor
-- vigente. O telão NÃO lê daqui — ele lê só o snapshot.
drop policy if exists magic_number_mensal_leitura on public.magic_number_mensal;
create policy magic_number_mensal_leitura on public.magic_number_mensal
for select to authenticated using (true);

-- Escrita só da gestão da TV, a mesma dupla que já governa tv_config e o
-- snapshot. Sem política para anon: o telão roda com usuário de menor permissão.
drop policy if exists magic_number_mensal_gravar on public.magic_number_mensal;
create policy magic_number_mensal_gravar on public.magic_number_mensal
for insert to authenticated
with check (lower(coalesce(auth.jwt() ->> 'email', '')) in
  ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br'));

drop policy if exists magic_number_mensal_atualizar on public.magic_number_mensal;
create policy magic_number_mensal_atualizar on public.magic_number_mensal
for update to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) in
  ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br'))
with check (lower(coalesce(auth.jwt() ->> 'email', '')) in
  ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br'));

-- TRUNCATE não é coberto por RLS e tabela nova no schema public herda o
-- privilégio por default. Sem este revoke, qualquer usuário logado esvaziaria a
-- tabela inteira passando por cima das políticas acima.
revoke truncate on public.magic_number_mensal from authenticated;
revoke truncate on public.magic_number_mensal from anon;
revoke all on public.magic_number_mensal from anon;

-- 2) Outubro/2026, o valor combinado pela gestão. `on conflict do nothing`:
--    se alguém já tiver cadastrado a competência, o cadastro dela manda.
insert into public.magic_number_mensal (mes_referencia, valor, observacao, atualizado_por)
values ('2026-10', 142800, 'Valor definido pela gestão em 06/10/2026. Meta piso da mesma competência: R$ 122.400,00.', 'migration 20261006152000')
on conflict (mes_referencia) do nothing;

-- 3) tv_snapshot_atualizar: cópia FIEL da versão vigente (20261001142500), com
--    UMA mescla nova — a chave 'magic'. tv_snapshot_calcular não é tocada.
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

    -- MAGIC NUMBER da competência corrente. Ausente => chave nula e o slide
    -- some do rodízio; nunca um valor derivado da meta.
    v_payload := v_payload || jsonb_build_object(
      'magic',
      (select jsonb_build_object(
                'mes_referencia', mn.mes_referencia,
                'valor', round(mn.valor)::bigint,
                'observacao', mn.observacao)
         from public.magic_number_mensal mn
        where mn.mes_referencia = to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM')
        limit 1));

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
