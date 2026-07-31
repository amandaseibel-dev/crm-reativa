-- ============================================================================
-- SNAPSHOT GERENCIAL — DRE e Visão Executiva por GATILHO (não ao vivo)
-- ----------------------------------------------------------------------------
-- A pedido: DRE e Dashboard Executivo deixam de calcular AO VIVO e passam a
-- ler um SNAPSHOT, atualizado só quando a gestão clica em "Atualizar projeção".
-- Alinha com o kill switch (não roda analítica pesada a cada abertura).
--
--   * snapshot_gerencial: guarda o payload (json) de cada relatório
--   * dashboard_executivo_snapshot() / dre_snapshot(ano): LEEM o snapshot
--     (lazy init na 1ª vez, pra nunca ficar vazio)
--   * atualizar_snapshots_gerenciais(ano): recomputa e grava (chamado junto
--     do "Atualizar projeção")
-- As funções de cálculo (dashboard_executivo / dre_dados) permanecem intactas
-- — passam a ser usadas só no refresh. Reversível.
-- ============================================================================

begin;

create table if not exists public.snapshot_gerencial (
  chave      text not null,
  ano        int  not null default 0,
  payload    jsonb,
  gerado_em  timestamptz not null default now(),
  gerado_por text,
  primary key (chave, ano)
);
alter table public.snapshot_gerencial enable row level security;
-- Sem policy de select p/ authenticated: leitura só via funções SECURITY DEFINER.

-- helper de permissão (gestão ou server-side)
create or replace function public.snapshot_gerencial_e_gestao()
returns boolean language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email','')) in
    ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br')
    or auth.jwt() is null;
$$;

-- LEITURA: Dashboard Executivo (snapshot; lazy init na 1ª vez) ---------------
create or replace function public.dashboard_executivo_snapshot()
returns json language plpgsql security definer set search_path = public as $$
declare v_payload jsonb;
begin
  if not public.snapshot_gerencial_e_gestao() then raise exception 'Sem permissão.'; end if;
  select payload into v_payload from public.snapshot_gerencial where chave='executivo' and ano=0;
  if v_payload is null then
    v_payload := public.dashboard_executivo()::jsonb; -- bootstrap 1x
    insert into public.snapshot_gerencial(chave, ano, payload, gerado_por)
      values ('executivo', 0, v_payload, 'bootstrap')
      on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
  end if;
  return v_payload::json;
end; $$;
revoke all on function public.dashboard_executivo_snapshot() from public;
grant execute on function public.dashboard_executivo_snapshot() to authenticated;

-- LEITURA: DRE por ano (snapshot; lazy init na 1ª vez) -----------------------
create or replace function public.dre_snapshot(p_ano int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_payload jsonb;
begin
  if not public.snapshot_gerencial_e_gestao() then raise exception 'Sem permissão.'; end if;
  select payload into v_payload from public.snapshot_gerencial where chave='dre' and ano=p_ano;
  if v_payload is null then
    v_payload := public.dre_dados(p_ano); -- bootstrap 1x
    insert into public.snapshot_gerencial(chave, ano, payload, gerado_por)
      values ('dre', p_ano, v_payload, 'bootstrap')
      on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
  end if;
  return v_payload;
end; $$;
revoke all on function public.dre_snapshot(int) from public;
grant execute on function public.dre_snapshot(int) to authenticated;

-- REFRESH: recomputa e grava (chamado junto do "Atualizar projeção") ---------
create or replace function public.atualizar_snapshots_gerenciais(p_ano int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ano int := coalesce(p_ano, extract(year from now())::int); v_email text := coalesce(auth.jwt() ->> 'email','server');
begin
  if not public.snapshot_gerencial_e_gestao() then raise exception 'Sem permissão para atualizar os snapshots gerenciais.'; end if;

  insert into public.snapshot_gerencial(chave, ano, payload, gerado_por, gerado_em)
    values ('executivo', 0, public.dashboard_executivo()::jsonb, v_email, now())
    on conflict (chave, ano) do update set payload=excluded.payload, gerado_por=excluded.gerado_por, gerado_em=now();

  insert into public.snapshot_gerencial(chave, ano, payload, gerado_por, gerado_em)
    values ('dre', v_ano, public.dre_dados(v_ano), v_email, now())
    on conflict (chave, ano) do update set payload=excluded.payload, gerado_por=excluded.gerado_por, gerado_em=now();

  return jsonb_build_object('ok', true, 'ano', v_ano, 'gerado_em', now());
end; $$;
revoke all on function public.atualizar_snapshots_gerenciais(int) from public;
grant execute on function public.atualizar_snapshots_gerenciais(int) to authenticated;

commit;
