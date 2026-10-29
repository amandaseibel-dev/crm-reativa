-- A1 — Playlist ReATIVA: ate 3 musicas ATIVAS por pessoa.
--
-- O QUE MUDA
--   1. Cai o limite de 1 musica por pessoa/semana (unique adicionado_por_email
--      + semana_chave). O limite passa a ser 3 musicas ativas por pessoa, sem
--      recorte de semana.
--   2. `semana_chave` passa a ser calculada em America/Sao_Paulo. O default
--      antigo usava `current_date` do servidor (UTC): domingo 21:00 em Sao Paulo
--      ja e segunda 00:00 UTC, e a semana virava 3h antes do previsto. A coluna
--      deixa de ser chave de limite, mas continua sendo gravada em todo insert,
--      entao um default errado seguiria produzindo dado errado.
--   3. Gatilho `portal_playlist_limite_tres_trg` passa a impor o limite no
--      banco, inclusive sob concorrencia.
--
-- O QUE NAO MUDA
--   * Nenhuma linha existente e apagada ou alterada: so ha DROP CONSTRAINT,
--     ALTER COLUMN SET DEFAULT (vale para linhas futuras) e CREATE.
--   * Nenhuma policy e criada, alterada ou removida. O soft delete e a edicao
--     usam a policy `portal_playlist_remover` (UPDATE), que ja existe desde
--     20260929152500 e nunca foi usada pela interface.
--   * Nada fora de public.portal_playlist e tocado.
--
-- POR QUE GATILHO E NAO CONSTRAINT: "no maximo 3 linhas por grupo" nao e
-- expressavel como CHECK nem como UNIQUE no PostgreSQL -- CHECK ve uma linha
-- por vez e UNIQUE proibiria a 2a. Entao a regra vive num gatilho, e a corrida
-- e fechada com advisory lock (ver abaixo).

-- 1. Remove o limite semanal. Idempotente: `if exists`.
alter table public.portal_playlist
  drop constraint if exists portal_playlist_adicionado_por_email_semana_chave_key;

-- 2. semana_chave em America/Sao_Paulo. Afeta apenas linhas futuras.
alter table public.portal_playlist
  alter column semana_chave
  set default (date_trunc('week', (now() at time zone 'America/Sao_Paulo'))::date);

-- 3. Indice de apoio a contagem do gatilho (mesmo predicado da contagem).
create index if not exists portal_playlist_ativas_por_email_idx
  on public.portal_playlist (lower(adicionado_por_email))
  where ativo;

-- 4. Regra do limite.
--
-- SECURITY DEFINER de proposito: a contagem NAO pode depender do que o usuario
-- consegue ler. Hoje `portal_playlist_leitura` e `using (true)` e um SECURITY
-- INVOKER contaria certo, mas se essa policy for restringida um dia a contagem
-- passaria a ver menos linhas do que existem e o limite vazaria sem ninguem
-- perceber. Enforcement le a tabela inteira, sempre.
create or replace function public.portal_playlist_limite_tres()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text;
  v_ativas integer;
begin
  -- Linha que nao ocupa vaga nao precisa de validacao. E tambem o caminho do
  -- soft delete (ativo = false), que por definicao LIBERA vaga.
  if new.ativo is not true then
    return new;
  end if;

  -- EDICAO nao consome vaga: a linha ja estava ativa e continua da mesma
  -- pessoa, entao a vaga que ela ocupa e a mesma de antes.
  if tg_op = 'UPDATE'
     and old.ativo is true
     and lower(old.adicionado_por_email) = lower(new.adicionado_por_email) then
    return new;
  end if;

  v_email := lower(coalesce(new.adicionado_por_email, ''));

  -- CONCORRENCIA: sem este lock, dois inserts simultaneos da mesma pessoa leem
  -- a contagem antes de qualquer um dos dois gravar, os dois veem 2 e os dois
  -- passam -- a pessoa termina com 4 musicas. O advisory lock e por pessoa
  -- (hash do e-mail), entao serializa apenas as inclusoes de quem esta no
  -- limite e nao cria fila global. Ele e `xact` e cai sozinho no commit ou no
  -- rollback, sem necessidade de unlock explicito.
  perform pg_advisory_xact_lock(hashtextextended('portal_playlist:' || v_email, 0));

  select count(*)
    into v_ativas
    from public.portal_playlist p
   where lower(p.adicionado_por_email) = v_email
     and p.ativo
     and p.id <> new.id;   -- no INSERT o id novo nao esta na tabela; no UPDATE
                           -- de reativacao a propria linha nao deve se contar.

  if v_ativas >= 3 then
    raise exception 'Limite de 3 musicas ativas por pessoa atingido (%).', v_email
      using errcode = 'PL003',
            hint = 'Remova uma das suas musicas para liberar uma vaga.';
  end if;

  return new;
end
$$;

comment on function public.portal_playlist_limite_tres() is
  'A1 Playlist ReATIVA: impede a 4a musica ativa da mesma pessoa. Soft delete (ativo=false) libera vaga; edicao de musica ativa nao consome vaga. Serializa por pessoa com advisory lock.';

drop trigger if exists portal_playlist_limite_tres_trg on public.portal_playlist;
create trigger portal_playlist_limite_tres_trg
  before insert or update on public.portal_playlist
  for each row execute function public.portal_playlist_limite_tres();
