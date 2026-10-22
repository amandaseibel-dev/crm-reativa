-- A2c — Playlist ReATIVA: UMA curtida por operador por semana.
--
-- O QUE MUDA
--   1. Nasce `portal_curtidas.semana`: a segunda-feira (America/Sao_Paulo) da
--      curtida, gravada por gatilho a partir de `criado_em`.
--   2. A regra passa a ser "1 curtida por operador por semana em TODA a
--      playlist" -- e nao mais "1 curtida por operador em cada musica". Para
--      curtir outra musica na mesma semana, o operador retira a propria
--      curtida primeiro.
--   3. `portal_curtidas_da_semana()` passa a responder `eu_curti` DA SEMANA
--      consultada quando o alvo e playlist. Antes olhava todas as semanas,
--      porque a unicidade era global; agora a unicidade e semanal e a tela
--      precisa saber em que musica a curtida DESTA semana esta.
--
-- O QUE NAO MUDA
--   * Elogios e ideias: continuam com 1 curtida por pessoa POR ALVO, para
--     sempre -- reconhecimento acumula, nao e disputa semanal. O indice antigo
--     segue valendo para eles (virou parcial `alvo_tipo <> 'playlist'`).
--   * Nenhuma curtida e apagada. Nenhuma linha de portal_playlist e tocada.
--   * `portal_musica_da_semana()` nao muda uma linha: ela sempre contou por
--      `criado_em` dentro da janela da semana.
--
-- O HISTORICO FICA COMO ESTA. Em 06/10/2026 a semana de 28/09 tinha cinco
-- operadores com mais de uma curtida (15, 7, 6, 2 e 2) -- a regra de entao
-- permitia. Impor a regra nova para tras exigiria APAGAR 28 curtidas reais da
-- equipe e trocaria a vencedora daquela semana. Por isso o indice semanal e
-- parcial a partir de `date '2026-10-05'`, a semana em que a regra entra em
-- vigor: o passado continua consultavel exatamente como aconteceu e a partir
-- desta semana ninguem curte duas vezes.
--
-- POR QUE COLUNA E GATILHO, E NAO INDICE EM EXPRESSAO: a semana vem de
-- `criado_em at time zone 'America/Sao_Paulo'`, que o PostgreSQL classifica
-- como STABLE (depende do catalogo de fusos) -- e indice e coluna gerada
-- exigem IMMUTABLE. Entao a semana e materializada numa coluna comum,
-- preenchida por gatilho a cada INSERT/UPDATE. Ninguem pode forjar o valor: o
-- gatilho sobrescreve o que vier do cliente.
--
-- A UNICIDADE CONTINUA SENDO INDICE, NAO CONTAGEM EM GATILHO: "no maximo 1" e
-- exatamente o que um indice unico faz, e indice unico e imune a concorrencia
-- por construcao -- duas abas clicando no mesmo segundo nao viram duas
-- curtidas.

-- 1. A coluna. Nullable primeiro, para poder preencher o que ja existe.
alter table public.portal_curtidas
  add column if not exists semana date;

comment on column public.portal_curtidas.semana is
  'Segunda-feira da semana de criado_em em America/Sao_Paulo. Preenchida pelo gatilho portal_curtidas_semana_trg -- valor enviado pelo cliente e ignorado.';

-- 2. O gatilho que calcula a semana. Roda tambem no UPDATE: se algum dia
-- `criado_em` for corrigido a mao, a semana acompanha em vez de ficar mentindo.
create or replace function public.portal_curtidas_semana()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.criado_em := coalesce(new.criado_em, now());
  new.semana := public.portal_semana_sp(new.criado_em);
  return new;
end
$$;

comment on function public.portal_curtidas_semana() is
  'Mantem portal_curtidas.semana coerente com criado_em (America/Sao_Paulo). O cliente nao escolhe a semana.';

drop trigger if exists portal_curtidas_semana_trg on public.portal_curtidas;
create trigger portal_curtidas_semana_trg
  before insert or update on public.portal_curtidas
  for each row execute function public.portal_curtidas_semana();

-- 3. Preenche o que ja estava gravado. Nada e apagado nem reescrito fora desta
-- coluna; `where semana is null` torna a migration reaplicavel sem custo.
update public.portal_curtidas
   set semana = public.portal_semana_sp(criado_em)
 where semana is null;

alter table public.portal_curtidas
  alter column semana set not null;

-- Default so para o caso de alguem desabilitar o gatilho; o gatilho e quem
-- manda enquanto estiver ativo.
alter table public.portal_curtidas
  alter column semana set default public.portal_semana_sp();

-- 4. O indice antigo (unicidade global por alvo) passa a valer somente para os
-- alvos que acumulam: elogio e ideia. Playlist sai dele porque nela a unicidade
-- agora e semanal -- quem curtiu numa semana precisa poder curtir na seguinte.
drop index if exists public.portal_curtidas_uma_por_pessoa_idx;
create unique index if not exists portal_curtidas_uma_por_pessoa_idx
  on public.portal_curtidas (alvo_tipo, alvo_id, lower(usuario_email))
  where alvo_tipo <> 'playlist';

-- 5. Playlist, trava de fundo: a mesma pessoa nao curte a mesma musica duas
-- vezes na mesma semana. Vale para TODA semana, inclusive as passadas -- o
-- historico nunca teve essa duplicidade, entao criar o indice nao apaga nada.
create unique index if not exists portal_curtidas_playlist_musica_semana_idx
  on public.portal_curtidas (alvo_id, lower(usuario_email), semana)
  where alvo_tipo = 'playlist';

-- 6. Playlist, a regra pedida: UMA curtida por operador por semana em toda a
-- playlist. Parcial a partir da semana de 05/10/2026 para nao reescrever o
-- historico (ver cabecalho).
create unique index if not exists portal_curtidas_playlist_uma_por_semana_idx
  on public.portal_curtidas (lower(usuario_email), semana)
  where alvo_tipo = 'playlist' and semana >= date '2026-10-05';

-- 7. `eu_curti` agora e da semana consultada quando o alvo e playlist.
--
-- Antes: FULL JOIN com todas as minhas curtidas, porque a unicidade era global
-- e quem curtiu na semana passada nao podia curtir de novo. Agora a unicidade e
-- semanal, e a tela precisa saber qual musica recebeu a MINHA curtida DESTA
-- semana -- e com isso desabilitar o coracao das outras.
--
-- Elogio e ideia continuam com unicidade global: para eles `minhas` segue
-- olhando todas as semanas (eles usam portal_curtidas_totais no dia a dia, mas
-- esta funcao aceita qualquer alvo e nao deve mentir para nenhum).
create or replace function public.portal_curtidas_da_semana(
  p_alvo_tipo text default 'playlist',
  p_semana date default null
)
returns table (alvo_id uuid, curtidas_semana integer, eu_curti boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  with sem as (select coalesce(p_semana, public.portal_semana_sp()) as s),
  da_semana as (
    select k.alvo_id, count(*)::int as n
      from public.portal_curtidas k cross join sem
     where k.alvo_tipo = p_alvo_tipo
       and (k.criado_em at time zone 'America/Sao_Paulo') >= sem.s::timestamp
       and (k.criado_em at time zone 'America/Sao_Paulo') <  (sem.s + 7)::timestamp
     group by k.alvo_id
  ),
  minhas as (
    select k.alvo_id
      from public.portal_curtidas k cross join sem
     where k.alvo_tipo = p_alvo_tipo
       and lower(k.usuario_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       and (p_alvo_tipo <> 'playlist' or k.semana = sem.s)
  )
  select coalesce(d.alvo_id, m.alvo_id),
         coalesce(d.n, 0),
         (m.alvo_id is not null)
    from da_semana d
    full outer join minhas m on m.alvo_id = d.alvo_id;
$$;

comment on function public.portal_curtidas_da_semana(text, date) is
  'Por alvo: quantas curtidas recebeu na semana (America/Sao_Paulo) e se a pessoa logada ja curtiu. Para playlist, eu_curti e DA SEMANA consultada (a unicidade e semanal); para os outros alvos, de qualquer semana (a unicidade e global).';

-- A funcao continua SECURITY INVOKER e com a mesma assinatura: nenhum grant
-- muda. O revoke/grant abaixo e repetido so para que a migration seja
-- autossuficiente se rodar num banco onde o A2 foi aplicado a mao.
revoke execute on function public.portal_curtidas_da_semana(text, date) from anon;
grant execute on function public.portal_curtidas_da_semana(text, date) to authenticated;
