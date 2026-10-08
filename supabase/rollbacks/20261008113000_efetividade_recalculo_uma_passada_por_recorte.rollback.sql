-- ROLLBACK de 20261008113000_efetividade_recalculo_uma_passada_por_recorte.sql
--
-- SO DDL, SO duas funcoes substituidas. Nenhuma tabela criada ou derrubada,
-- nenhum dado escrito, nenhum gatilho tocado -- nao ha dado a restaurar.
--
-- ATENCAO: este rollback REINTRODUZ o defeito medido em 08/10/2026. As duas
-- definicoes abaixo sao as que estavam em producao antes da correcao, e com elas
-- a reconstrucao volta a estourar o teto de 2 min (o `insert` do snapshot de
-- itens re-deriva o agregado de 400.693 linhas de `prime_titulo_semestre` uma
-- vez por motivo). Se este rollback for aplicado, DESAGENDE os crons
-- `carteira_efetividade_dreno` e `carteira_efetividade_hora` junto, senao o
-- dreno volta a falhar a cada 5 minutos queimando ~2 min de consulta pesada.
--
-- NAO TOCADO por esta migration e portanto sem reversao:
--   carteira_safra_situacoes, carteira_2026_1_classificar,
--   carteira_em_aberto_por_status_academico (inclusive a REGUA HISTORICA de
--   2024/2025), carteira_pendencias_por_motivo, carteira_pendencias_itens,
--   carteira_efetividade_ler, carteira_efetividade_invalidar,
--   carteira_efetividade_solicitar_atualizacao,
--   carteira_efetividade_recalcular_pendentes, os 4 gatilhos de invalidacao,
--   as tabelas de fotografia e de invalidacao.

-- ---------------------------------------------------------------------------
-- 1. o recalculo volta a fotografar a lista individual (e a estourar o teto)
-- ---------------------------------------------------------------------------
create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  r         record;
  v_t0      timestamptz;
  v_payload jsonb;
  v_ms      integer;
  v_feitos  jsonb := '[]'::jsonb;
  v_itens   integer;
  v_tecnico boolean := (current_setting('request.jwt.claims', true) is null)
                        or coalesce(auth.role(),'') = 'service_role';
begin
  if not v_tecnico and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  for r in
    select * from (values ('2024','2024',null::text),
                          ('2025','2025',null::text),
                          ('2026/1','2026','1')) v(recorte, ano, semestre)
     where p_recorte is null or v.recorte = p_recorte
  loop
    v_t0 := clock_timestamp();
    v_payload := public.carteira_safra_situacoes(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false)
       and coalesce((v_payload->'situacoes'->'entrou'->>'valor')::numeric, 0) > 0 then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('seis_linhas', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','seis_linhas','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','seis_linhas','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    v_t0 := clock_timestamp();
    v_payload := public.carteira_em_aberto_por_status_academico(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false)
       and coalesce((v_payload->'total'->>'valor')::numeric, 0) > 0 then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('composicao_academica', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','composicao_academica','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','composicao_academica','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    v_t0 := clock_timestamp();
    v_payload := public.carteira_pendencias_por_motivo(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false) then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('pendencias_por_motivo', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','pendencias_por_motivo','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','pendencias_por_motivo','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    v_t0 := clock_timestamp();
    delete from public.carteira_pendencias_item_snapshot s where s.recorte = r.recorte;
    insert into public.carteira_pendencias_item_snapshot
      (recorte, motivo, titulo_id, aluno_id, aluno_nome, cpf, documento, vencimento, safra,
       valor, motivo_rotulo, situacao_titulo, evidencia, responsavel_email, desde, acao, gerado_em)
    select r.recorte, i.motivo, i.titulo_id, i.aluno_id, i.aluno_nome, i.cpf, i.documento,
           i.vencimento, i.safra, i.valor, i.motivo_rotulo, i.situacao_titulo, i.evidencia,
           i.responsavel_email, i.desde, i.acao, now()
      from (select m->>'chave' as chave
              from jsonb_array_elements(
                     coalesce(public.carteira_pendencias_por_motivo(r.ano, r.semestre)->'motivos',
                              '[]'::jsonb)) m) mm
      cross join lateral public.carteira_pendencias_itens(mm.chave, r.ano, r.semestre, 500, 0) i;
    v_itens := (select count(*) from public.carteira_pendencias_item_snapshot s where s.recorte = r.recorte);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    v_feitos := v_feitos || jsonb_build_object('bloco','pendencias_itens','recorte',r.recorte,
                                               'linhas',v_itens,'ms',v_ms);
  end loop;

  return jsonb_build_object('gerado_em', now(), 'blocos', v_feitos);
end;
$function$;

revoke all on function public.carteira_efetividade_recalcular(text) from public, anon;
grant execute on function public.carteira_efetividade_recalcular(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. a lista individual volta a ler a tabela de fotografia (que estara VAZIA
--    ate um recalculo bem-sucedido repovoa-la)
-- ---------------------------------------------------------------------------
create or replace function public.carteira_pendencias_itens_ler(
  p_motivo   text,
  p_ano      text,
  p_semestre text default null,
  p_limite   integer default 50,
  p_offset   integer default 0
)
returns table (
  aluno_id          uuid,
  aluno_nome        text,
  cpf               text,
  titulo_id         uuid,
  documento         text,
  vencimento        date,
  safra             text,
  valor             numeric,
  motivo            text,
  motivo_rotulo     text,
  situacao_titulo   text,
  evidencia         text,
  responsavel_email text,
  desde             timestamptz,
  acao              text,
  gerado_em         timestamptz,
  total_no_motivo   bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_recorte text;
  v_lim integer := least(greatest(coalesce(p_limite, 50), 1), 500);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  v_recorte := case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end;

  return query
  select s.aluno_id, s.aluno_nome, s.cpf, s.titulo_id, s.documento, s.vencimento, s.safra,
         s.valor, s.motivo, s.motivo_rotulo, s.situacao_titulo, s.evidencia,
         s.responsavel_email, s.desde, s.acao, s.gerado_em,
         count(*) over () as total_no_motivo
    from public.carteira_pendencias_item_snapshot s
   where s.recorte = v_recorte and s.motivo = p_motivo
   order by s.valor desc, s.documento
   limit v_lim offset v_off;
end;
$function$;

revoke all on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) from public, anon;
grant execute on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) to authenticated, service_role;
