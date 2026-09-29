-- Visão Geral participativa do Portal Operacional
-- Playlist ReATIVA, próximos eventos e aniversários.

create table if not exists public.portal_playlist (
  id uuid primary key default gen_random_uuid(),
  titulo text not null check (length(trim(titulo)) between 1 and 160),
  artista text not null check (length(trim(artista)) between 1 and 160),
  youtube_id text not null check (length(youtube_id) between 6 and 32),
  adicionado_por text not null,
  adicionado_por_email text not null,
  semana_chave date not null default date_trunc('week', current_date)::date,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (adicionado_por_email, semana_chave)
);

create table if not exists public.portal_eventos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null check (length(trim(titulo)) between 1 and 180),
  inicio_em timestamptz not null,
  categoria text not null default 'Operação',
  criado_por_email text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create table if not exists public.portal_aniversarios (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 1 and 120),
  dia smallint not null check (dia between 1 and 31),
  mes smallint not null check (mes between 1 and 12),
  criado_por_email text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (lower(nome), dia, mes)
);

alter table public.portal_playlist enable row level security;
alter table public.portal_eventos enable row level security;
alter table public.portal_aniversarios enable row level security;

drop policy if exists portal_playlist_leitura on public.portal_playlist;
create policy portal_playlist_leitura on public.portal_playlist
for select to authenticated using (true);

drop policy if exists portal_playlist_inserir_propria on public.portal_playlist;
create policy portal_playlist_inserir_propria on public.portal_playlist
for insert to authenticated
with check (
  lower(adicionado_por_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

drop policy if exists portal_playlist_remover on public.portal_playlist;
create policy portal_playlist_remover on public.portal_playlist
for update to authenticated
using (
  lower(adicionado_por_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  or lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  )
)
with check (
  lower(adicionado_por_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  or lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  )
);

drop policy if exists portal_eventos_leitura on public.portal_eventos;
create policy portal_eventos_leitura on public.portal_eventos
for select to authenticated using (true);

drop policy if exists portal_eventos_gestao on public.portal_eventos;
create policy portal_eventos_gestao on public.portal_eventos
for all to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  )
)
with check (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  )
);

drop policy if exists portal_aniversarios_leitura on public.portal_aniversarios;
create policy portal_aniversarios_leitura on public.portal_aniversarios
for select to authenticated using (true);

drop policy if exists portal_aniversarios_gestao on public.portal_aniversarios;
create policy portal_aniversarios_gestao on public.portal_aniversarios
for all to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  )
)
with check (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  )
);

create index if not exists portal_playlist_criado_em_idx on public.portal_playlist (criado_em desc) where ativo;
create index if not exists portal_eventos_inicio_idx on public.portal_eventos (inicio_em) where ativo;
create index if not exists portal_aniversarios_mes_dia_idx on public.portal_aniversarios (mes, dia) where ativo;
