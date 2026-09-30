-- A2 — Curtidas do Portal + Musica mais curtida da semana.
--
-- O QUE ENTRA
--   1. public.portal_curtidas: uma linha por (alvo, pessoa), com data/hora.
--   2. public.portal_semana_sp(): a segunda-feira da semana em America/Sao_Paulo.
--   3. public.portal_curtidas_da_semana(): contagem da semana + se eu ja curti.
--   4. public.portal_musica_da_semana(): a vencedora, com desempate deterministico.
--
-- O QUE NAO MUDA
--   * Nada em portal_playlist, portal_eventos, portal_aniversarios.
--   * Nenhuma policy existente e criada, alterada ou removida.
--   * Nada fora do Portal e tocado.
--
-- UNICIDADE NO BANCO, NAO NA TELA: "uma pessoa curte uma vez" e um UNIQUE de
-- verdade, nao um gatilho. Diferente do limite de 3 do A1 (que o PostgreSQL nao
-- sabe expressar de forma declarativa), "no maximo 1" e exatamente o que um
-- indice unico faz -- e indice unico e imune a concorrencia por construcao, sem
-- advisory lock e sem contar linhas antes de gravar.
--
-- SEM CONTADOR: nao existe coluna de total. Toda contagem e derivada de
-- `criado_em` linha a linha, entao nao ha numero para zerar na virada da semana
-- e o historico das semanas anteriores continua deduzivel dos proprios registros.
--
-- DESCURTIR E DELETE: apagar a propria linha e o unico jeito de recurtir depois
-- com data NOVA. Se a retirada fosse logica (ativo = false), recurtir reusaria a
-- linha antiga e o `criado_em` ficaria na semana errada -- a contagem semanal
-- sairia furada.

create table if not exists public.portal_curtidas (
  id uuid primary key default gen_random_uuid(),
  -- `alvo_tipo` ja entra na chave de unicidade aceitando so 'playlist'. Quando
  -- os elogios e as ideias chegarem, e um ALTER do CHECK: nenhuma migracao de
  -- dado e nenhum indice recriado.
  alvo_tipo text not null check (alvo_tipo in ('playlist')),
  -- Sem FK: em outros alvos o `alvo_id` aponta para outra tabela, e o PostgreSQL
  -- nao tem FK polimorfica. Curtida orfa e inofensiva -- as consultas fazem join
  -- com o alvo, entao ela simplesmente nao conta.
  alvo_id uuid not null,
  usuario_email text not null check (length(trim(usuario_email)) between 3 and 320),
  criado_em timestamptz not null default now()
);

-- A regra "uma pessoa curte uma vez". Indice (e nao constraint) porque a chave
-- usa lower(): e-mail com caixa diferente e a mesma pessoa.
create unique index if not exists portal_curtidas_uma_por_pessoa_idx
  on public.portal_curtidas (alvo_tipo, alvo_id, lower(usuario_email));

-- Apoio a contagem por janela de semana.
create index if not exists portal_curtidas_tipo_data_idx
  on public.portal_curtidas (alvo_tipo, criado_em);

alter table public.portal_curtidas enable row level security;

-- Leitura aberta a quem esta logado: a tela precisa do total e de saber se a
-- propria pessoa ja curtiu. Nao ha dado sensivel aqui -- alvo, e-mail e horario.
drop policy if exists portal_curtidas_leitura on public.portal_curtidas;
create policy portal_curtidas_leitura on public.portal_curtidas
for select to authenticated using (true);

drop policy if exists portal_curtidas_inserir_propria on public.portal_curtidas;
create policy portal_curtidas_inserir_propria on public.portal_curtidas
for insert to authenticated
with check (lower(usuario_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Descurtir: so a propria curtida. Ninguem retira a curtida de outra pessoa.
drop policy if exists portal_curtidas_remover_propria on public.portal_curtidas;
create policy portal_curtidas_remover_propria on public.portal_curtidas
for delete to authenticated
using (lower(usuario_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- A semana da equipe: segunda 00:00 ate domingo 23:59:59 em America/Sao_Paulo.
-- Fica numa funcao so para que a janela nao seja reescrita em cada consulta.
create or replace function public.portal_semana_sp(p_quando timestamptz default now())
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (date_trunc('week', (p_quando at time zone 'America/Sao_Paulo')))::date;
$$;

comment on function public.portal_semana_sp(timestamptz) is
  'Segunda-feira da semana de p_quando em America/Sao_Paulo. A janela da semana e [segunda 00:00, proxima segunda 00:00), ou seja, ate domingo 23:59:59.';

-- Contagem da semana por alvo + se a pessoa logada ja curtiu aquele alvo.
--
-- `curtidas_semana` conta apenas as curtidas DA SEMANA; `eu_curti` olha todas as
-- semanas, porque a unicidade e global: quem curtiu numa semana anterior nao
-- pode curtir de novo sem antes retirar a propria curtida. Por isso o FULL JOIN:
-- um alvo pode ter a minha curtida antiga e nenhuma curtida nesta semana.
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

-- A musica mais curtida da semana.
--
-- DESEMPATE, nesta ordem, ate sobrar uma:
--   1. mais curtidas recebidas DENTRO da semana;
--   2. curtida mais antiga da semana (quem chegou primeiro a contagem);
--   3. musica cadastrada primeiro (portal_playlist.criado_em);
--   4. menor id.
-- Os passos 3 e 4 garantem resultado unico mesmo com curtidas no mesmo instante.
--
-- So concorre musica ATIVA: se a pessoa removeu a musica da playlist, as curtidas
-- dela continuam gravadas (nada e apagado), mas ela sai da disputa do destaque.
create or replace function public.portal_musica_da_semana(p_semana date default null)
returns table (
  id uuid,
  titulo text,
  artista text,
  youtube_id text,
  adicionado_por text,
  curtidas integer,
  semana date
)
language sql
stable
set search_path = public, pg_temp
as $$
  with sem as (select coalesce(p_semana, public.portal_semana_sp()) as s),
  c as (
    select k.alvo_id, count(*)::int as n, min(k.criado_em) as primeira
      from public.portal_curtidas k cross join sem
     where k.alvo_tipo = 'playlist'
       and (k.criado_em at time zone 'America/Sao_Paulo') >= sem.s::timestamp
       and (k.criado_em at time zone 'America/Sao_Paulo') <  (sem.s + 7)::timestamp
     group by k.alvo_id
  )
  select p.id, p.titulo, p.artista, p.youtube_id, p.adicionado_por, c.n, sem.s
    from c
    join public.portal_playlist p on p.id = c.alvo_id
   cross join sem
   where p.ativo
   order by c.n desc, c.primeira asc, p.criado_em asc, p.id::text asc
   limit 1;
$$;

comment on function public.portal_musica_da_semana(date) is
  'Musica mais curtida da semana (America/Sao_Paulo), so entre as ativas. Desempate: curtidas, curtida mais antiga da semana, musica mais antiga, menor id.';

-- As tres funcoes sao SECURITY INVOKER (padrao): elas leem portal_curtidas e
-- portal_playlist, cujas policies de leitura ja sao `to authenticated using
-- (true)`. Nao ha motivo para elevar privilegio -- e enforcement nenhum depende
-- delas.
revoke execute on function public.portal_semana_sp(timestamptz) from anon;
revoke execute on function public.portal_curtidas_da_semana(text, date) from anon;
revoke execute on function public.portal_musica_da_semana(date) from anon;
grant execute on function public.portal_semana_sp(timestamptz) to authenticated;
grant execute on function public.portal_curtidas_da_semana(text, date) to authenticated;
grant execute on function public.portal_musica_da_semana(date) to authenticated;
