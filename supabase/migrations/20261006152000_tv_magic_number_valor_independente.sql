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

-- 3) tv_snapshot_atualizar ganha a chave 'magic' -- por PATCH ANCORADO.
--
--    A primeira versão desta migration reescrevia a função inteira, a partir da
--    cópia de 20261001142500. Isso virou um defeito quando 20261007093518
--    (tv_equipe_oculta / saída da Olga) entrou em produção ANTES daqui: a
--    reescrita apagaria o filtro que tira quem saiu da equipe da Playlist
--    ReATIVA, e o nome voltaria ao telão sem ninguém perceber.
--
--    Patch ancorado não tem esse problema: lê o corpo VIVO, insere só a mescla
--    nova antes do cálculo da duração, e preserva tudo o que já estiver lá --
--    venha de onde vier. Exige ocorrência única da âncora e ABORTA sem alterar
--    nada se ela não bater. tv_snapshot_calcular continua intocada.
do $patch$
declare
  v_src text; v_n int;
  v_ancora text := $a$    v_ms := round(extract(milliseconds from clock_timestamp() - v_t0));$a$;
  v_bloco  text := $a$    -- MAGIC NUMBER da competência corrente. Ausente => chave nula e o slide
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

$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_atualizar' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_atualizar() nao existe neste banco.';
  end if;

  if position('magic_number_mensal' in v_src) > 0 then
    raise notice 'chave magic ja mesclada; nada a fazer.';
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then
    raise exception 'ancora do v_ms encontrada % vez(es) em tv_snapshot_atualizar (esperado 1). Nada foi alterado.', v_n;
  end if;

  execute replace(v_src, v_ancora, v_bloco || v_ancora);
end
$patch$;
