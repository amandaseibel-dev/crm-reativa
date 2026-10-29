-- =============================================================================
-- TV ReATIVA — sinal realtime leve (atualiza o telão sem polling)
-- =============================================================================
-- Objetivo: quando Amanda/Fernanda geram um novo snapshot, o telão físico (em
-- outro dispositivo) recebe UM evento leve e faz UMA leitura (tv_snapshot_ler).
-- Sem polling, sem verificação periódica, sem escutar outras tabelas.
--
-- Como: tabela-sinal minúscula (só versao + gerado_em, sem payload), publicada
-- no Realtime. Um trigger AFTER UPDATE em tv_snapshot atualiza o sinal APENAS
-- quando a geração teve SUCESSO (status='ok' e a versão mudou) — nunca no
-- caminho de erro (que mantém a versão e marca status='erro').
-- =============================================================================

create table if not exists public.tv_sinal (
  id        boolean primary key default true,
  versao    bigint  not null default 0,
  gerado_em timestamptz,
  constraint tv_sinal_singleton check (id)
);
alter table public.tv_sinal enable row level security;
-- Leitura por qualquer autenticado (só expõe versao/gerado_em — nada sensível).
drop policy if exists tv_sinal_sel on public.tv_sinal;
create policy tv_sinal_sel on public.tv_sinal for select to authenticated using (true);

-- Publica só esta tabela no Realtime (o telão escuta apenas o sinal do snapshot).
do $do$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tv_sinal'
  ) then
    alter publication supabase_realtime add table public.tv_sinal;
  end if;
end
$do$;

-- Trigger de sinal: só emite quando o snapshot foi concluído com sucesso.
create or replace function public.tv_snapshot_sinalizar()
 returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
begin
  if NEW.status = 'ok' and NEW.versao is distinct from OLD.versao then
    insert into public.tv_sinal (id, versao, gerado_em)
    values (true, NEW.versao, NEW.gerado_em)
    on conflict (id) do update set versao = excluded.versao, gerado_em = excluded.gerado_em;
  end if;
  return NEW;
end;
$fn$;

drop trigger if exists trg_tv_snapshot_sinalizar on public.tv_snapshot;
create trigger trg_tv_snapshot_sinalizar
  after update on public.tv_snapshot
  for each row execute function public.tv_snapshot_sinalizar();

-- Remove COMPLETAMENTE o seed "BORA TIME" (mensagem de campanha) do banco.
delete from public.tv_mensagem_especial where atualizado_por = 'seed' and titulo ilike '%BORA TIME%';
