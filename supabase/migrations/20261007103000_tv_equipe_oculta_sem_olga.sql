-- =============================================================================
-- TV ReATIVA — quem saiu da equipe some do telão
-- -----------------------------------------------------------------------------
-- Olga (cobranca03@aelbra.com.br) não faz mais parte da equipe e continuava
-- aparecendo no telão. O levantamento de 07/10/2026 encontrou quatro caminhos
-- vivos até a tela:
--
--   1) `v_ops` em tv_snapshot_calcular() — a allowlist de operadores do telão.
--      Ela governa TODOS os rankings e destaques: ranking da semana e do mês,
--      maior pagamento (do dia e do mês), melhor recuperador do dia e do mês,
--      top 3 do mês, mais pagamentos confirmados, top de honorários do dia, o
--      ranking semanal por valor e o Destaque da Semana. cobranca03 era o
--      PRIMEIRO item da lista.
--   2) `elogios` — lê aluno_movimentacoes sem nenhum filtro de equipe.
--   3) `playlist_reativa` — mostra `adicionado_por` de portal_playlist.
--   4) listas curadas à mão — tv_aniversariantes e o card
--      tv_config.aniversario_destaque.
--
-- O QUE ESTA MIGRATION **NÃO** FAZ: não apaga uma linha sequer de pagamentos,
-- acordos, títulos ou qualquer histórico financeiro. `v_ops` nunca entrou em
-- cálculo de dinheiro — recuperado, honorários, meta, projeção e premiação
-- somam `public.pagamentos` inteiro, sem filtro de operador. Sair da allowlist
-- tira a pessoa da VITRINE, não do caixa. Conferido campo a campo: v_rec,
-- v_hon, v_hon_ant, v_hon_total e v_taxa_dia não citam v_ops.
--
-- Nas listas curadas nada é apagado: as linhas só vão para `ativo = false`,
-- e voltam com um update se a gestão quiser.
--
-- POR QUE UMA TABELA e não o e-mail espalhado em cada consulta: a próxima
-- saída da equipe tem de ser um INSERT, não outra migration. `tv_equipe_oculta`
-- é a lista única de quem não aparece no telão.
--
-- POR QUE PATCH ANCORADO e não CREATE OR REPLACE das funções: tv_snapshot_calcular()
-- tem ~230 linhas e concentra o cálculo do snapshot; produção já recebeu patches
-- ancorados de outras frentes (20261006110000, 20261006200000) e reescrever a
-- função a partir do texto do repositório apagaria esses ajustes. Aqui o corpo
-- VIVO é lido com pg_get_functiondef, só os trechos são trocados, e cada bloco
-- ABORTA se a âncora não aparecer exatamente uma vez.
--
-- DESFAZER: supabase/rollbacks/20261007103000_tv_equipe_oculta_sem_olga.rollback.sql
-- =============================================================================

-- 1) A lista única de quem não aparece no telão ------------------------------
create table if not exists public.tv_equipe_oculta (
  email        text primary key check (email = lower(btrim(email)) and email <> ''),
  nome         text not null,
  oculto_desde date not null default current_date,
  motivo       text
);

comment on table public.tv_equipe_oculta is
  'Pessoas que não devem aparecer em nenhuma tela da TV (rankings, destaques, elogios, playlist). NÃO afeta cálculo financeiro: pagamentos e honorários continuam somando normalmente.';

alter table public.tv_equipe_oculta enable row level security;

drop policy if exists tv_equipe_oculta_leitura on public.tv_equipe_oculta;
create policy tv_equipe_oculta_leitura on public.tv_equipe_oculta
for select to authenticated using (true);

drop policy if exists tv_equipe_oculta_gravar on public.tv_equipe_oculta;
create policy tv_equipe_oculta_gravar on public.tv_equipe_oculta
for all to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) in
  ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br'))
with check (lower(coalesce(auth.jwt() ->> 'email', '')) in
  ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br'));

-- TRUNCATE não é coberto por RLS e tabela nova no schema public herda o
-- privilégio por default: sem isto, qualquer usuário logado esvaziaria a lista
-- e devolveria todo mundo ao telão passando por cima das políticas acima.
revoke truncate on public.tv_equipe_oculta from authenticated;
revoke all on public.tv_equipe_oculta from anon;

insert into public.tv_equipe_oculta (email, nome, oculto_desde, motivo)
values ('cobranca03@aelbra.com.br', 'OLGA', date '2026-10-07', 'Não faz mais parte da equipe.')
on conflict (email) do nothing;

-- 2) v_ops perde cobranca03 --------------------------------------------------
--    Uma troca fecha de uma vez todos os rankings e destaques.
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$'cobranca03@aelbra.com.br',$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco.';
  end if;

  v_n := (length(v_src) - length(replace(v_src, v_de, ''))) / length(v_de);
  if v_n = 0 then
    raise notice 'cobranca03 ja estava fora de v_ops; nada a fazer.';
    return;
  end if;
  if v_n <> 1 then
    raise exception 'cobranca03 aparece % vezes em tv_snapshot_calcular (esperado 1). Nada foi alterado.', v_n;
  end if;

  v_novo := replace(v_src, v_de, '');

  -- Rede: a allowlist tem de continuar existindo e com gente dentro. Se a
  -- troca deixasse `array[]`, todo ranking do telão sumiria de uma vez.
  if position('v_ops text[] := array[''cobranca' in v_novo) = 0 then
    raise exception 'v_ops ficou vazia ou irreconhecivel depois da troca. Nada foi aplicado.';
  end if;

  execute v_novo;
end
$patch$;

-- 3) Elogios passam a respeitar a lista --------------------------------------
--    Elogio é aprovado à mão; sem este filtro, aprovar um elogio antigo dela
--    devolveria o nome ao telão.
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$where status_novo = 'ELOGIO_ATENDIMENTO' and elogio_aprovado_tv = true$a$;
  v_para text := $a$where status_novo = 'ELOGIO_ATENDIMENTO' and elogio_aprovado_tv = true and lower(coalesce(registrado_por_email,'')) not in (select email from public.tv_equipe_oculta)$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;

  if position(v_para in v_src) > 0 then
    raise notice 'filtro de elogios ja aplicado; nada a fazer.';
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, v_de, ''))) / length(v_de);
  if v_n <> 1 then
    raise exception 'ancora de elogios encontrada % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;

  v_novo := replace(v_src, v_de, v_para);
  execute v_novo;
end
$patch$;

-- 4) Playlist passa a respeitar a lista --------------------------------------
--    Âncora por EXPRESSÃO REGULAR, não por texto literal: a consulta da
--    playlist ocupa duas linhas e a indentação dela já mudou entre versões da
--    função. `\s+` casa qualquer espaçamento; a contagem continua exigindo
--    ocorrência única, então o bloco segue falhando fechado.
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_re   text := 'from public\.portal_playlist\s+where ativo = true';
  v_para text := 'from public.portal_playlist where ativo = true and lower(coalesce(adicionado_por_email,'''')) not in (select email from public.tv_equipe_oculta)';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_atualizar' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_atualizar() nao existe neste banco.';
  end if;

  if position('tv_equipe_oculta' in v_src) > 0 then
    raise notice 'filtro de playlist ja aplicado; nada a fazer.';
    return;
  end if;

  select count(*) into v_n from regexp_matches(v_src, v_re, 'g');
  if v_n <> 1 then
    raise exception 'ancora da playlist encontrada % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;

  v_novo := regexp_replace(v_src, v_re, v_para);
  execute v_novo;
end
$patch$;

-- 5) Listas curadas à mão ----------------------------------------------------
--    Nada é apagado: só sai do ar. Casamento por NOME porque
--    tv_aniversariantes não guarda e-mail. A comparação é por CONTÉM e sem
--    caixa, para pegar "Olga", "OLGA PATRICIA" e "Olga P. de Oliveira" com o
--    mesmo registro. O nome guardado em tv_equipe_oculta é curto de propósito.
update public.tv_aniversariantes a
   set ativo = false
  from public.tv_equipe_oculta o
 where a.ativo = true
   and upper(a.nome) like '%' || upper(o.nome) || '%';

-- Card de aniversário em destaque: sai do ar se for de alguém da lista.
update public.tv_config c
   set ativo = false
 where c.chave = 'aniversario_destaque'
   and coalesce(c.ativo, true)
   and exists (
     select 1 from public.tv_equipe_oculta o
      where upper(coalesce(c.valor ->> 'nome', '')) like '%' || upper(o.nome) || '%');
