-- Rollback de 20261006190651_portal_curtida_unica_por_semana.
--
-- NAO APAGA NENHUMA CURTIDA. Volta a playlist para a regra anterior ("1 curtida
-- por pessoa em cada musica, para sempre"), desfaz o gatilho, a coluna `semana`
-- e os dois indices novos, e restaura o corpo de portal_curtidas_da_semana com
-- `eu_curti` global.
--
-- POR QUE PODE RODAR AS CEGAS: a unicidade antiga (alvo_tipo, alvo_id, e-mail)
-- e MAIS FROUXA que a de agora para a playlist -- a regra semanal so permitia
-- menos, nunca mais. Logo o indice global volta a ser criado sem conflito. Se
-- ainda assim o CREATE INDEX falhar, o motivo esta nos dados anteriores ao A2c
-- (duas curtidas da mesma pessoa na mesma musica em semanas diferentes), e o
-- erro aponta o par exato: resolva antes de insistir.
--
-- O que NAO volta: nada. A coluna `semana` e derivada de `criado_em`, entao
-- apagar a coluna nao perde informacao -- a semana de qualquer curtida continua
-- deduzivel com public.portal_semana_sp(criado_em).

drop trigger if exists portal_curtidas_semana_trg on public.portal_curtidas;
drop function if exists public.portal_curtidas_semana();

drop index if exists public.portal_curtidas_playlist_uma_por_semana_idx;
drop index if exists public.portal_curtidas_playlist_musica_semana_idx;

alter table public.portal_curtidas drop column if exists semana;

-- O indice volta a valer para todos os alvos (sem o predicado parcial).
drop index if exists public.portal_curtidas_uma_por_pessoa_idx;
create unique index if not exists portal_curtidas_uma_por_pessoa_idx
  on public.portal_curtidas (alvo_tipo, alvo_id, lower(usuario_email));

-- Corpo do A2: `eu_curti` olha todas as semanas, porque a unicidade e global.
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
      from public.portal_curtidas k
     where k.alvo_tipo = p_alvo_tipo
       and lower(k.usuario_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  select coalesce(d.alvo_id, m.alvo_id),
         coalesce(d.n, 0),
         (m.alvo_id is not null)
    from da_semana d
    full outer join minhas m on m.alvo_id = d.alvo_id;
$$;

comment on function public.portal_curtidas_da_semana(text, date) is
  'Por alvo: quantas curtidas recebeu na semana (America/Sao_Paulo) e se a pessoa logada ja curtiu (em qualquer semana -- a unicidade e global).';

revoke execute on function public.portal_curtidas_da_semana(text, date) from anon;
grant execute on function public.portal_curtidas_da_semana(text, date) to authenticated;
