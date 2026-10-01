-- Rollback de 20260930153000_portal_playlist_limite_tres_musicas.
--
-- Desfaz o A1 e devolve a Playlist ao limite de 1 musica por pessoa/semana.
--
-- FALHA FECHADO, DE PROPOSITO: enquanto o A1 esteve no ar as pessoas puderam
-- cadastrar mais de uma musica na MESMA semana. Se isso aconteceu, o unique
-- (adicionado_por_email, semana_chave) nao pode voltar -- e o ALTER TABLE
-- falharia no meio do rollback, com o gatilho ja removido e a tabela sem
-- nenhum limite. Por isso a checagem vem ANTES de qualquer DROP: ou o rollback
-- roda inteiro, ou nao roda nada e a base fica exatamente como estava.
--
-- Se a checagem barrar, a decisao e da gestao: desativar (ativo = false) as
-- musicas excedentes de cada semana e rodar o rollback de novo. O SELECT do
-- erro lista exatamente quem e qual semana precisa de ajuste.
--
-- Nao apaga nenhuma linha. Nao toca policies.

do $$
declare
  v_conflitos text;
begin
  select string_agg(format('%s na semana de %s: %s musicas', adicionado_por_email, semana_chave, n), E'\n')
    into v_conflitos
    from (
      select adicionado_por_email, semana_chave, count(*) as n
        from public.portal_playlist
       where ativo
       group by adicionado_por_email, semana_chave
      having count(*) > 1
    ) x;

  if v_conflitos is not null then
    raise exception E'Rollback abortado: existem musicas ativas demais na mesma semana para restaurar o unique semanal.\n%\nDesative as excedentes (ativo = false) e rode o rollback novamente.', v_conflitos
      using errcode = 'PL004';
  end if;
end
$$;

-- 1. Retira a regra do limite de 3.
drop trigger if exists portal_playlist_limite_tres_trg on public.portal_playlist;
drop function if exists public.portal_playlist_limite_tres();

-- 2. Retira o indice de apoio.
drop index if exists public.portal_playlist_ativas_por_email_idx;

-- 3. Volta o default de semana_chave ao original (UTC, como em 20260929152500).
--    Texto identico ao que producao guarda hoje em information_schema:
--    (date_trunc('week'::text, (CURRENT_DATE)::timestamp with time zone))::date
alter table public.portal_playlist
  alter column semana_chave
  set default (date_trunc('week'::text, (CURRENT_DATE)::timestamp with time zone))::date;

-- 4. Restaura o limite de 1 musica por pessoa/semana. Seguro: a checagem do
--    inicio garantiu que nao ha duplicidade ativa.
alter table public.portal_playlist
  add constraint portal_playlist_adicionado_por_email_semana_chave_key
  unique (adicionado_por_email, semana_chave);
