-- USO DE TELAS (18/11/2026).
--
-- POR QUE EXISTE. O CRM acumulou rotas que ninguém sabe se ainda são usadas.
-- Antes de cortar qualquer tela, a gestão precisa ver número de acessos e de
-- usuários distintos nos últimos 30 dias — sem pesquisa manual, sem chutar.
--
-- O QUE FAZ. Registra 1 acesso por usuário/rota/dia (nunca por sessão, nunca
-- por segundo): a granularidade certa para "esta tela tem movimento?" — sem
-- gerar uma linha por clique.
--
-- SEGURANÇA.
--   • `revoke all from anon, authenticated` antes de ligar RLS: o schema
--     `public` concede `arwdDxtm` para `authenticated` por padrão, inclusive
--     TRUNCATE que RLS não cobre. O revoke é explícito e vem antes.
--   • Nenhum SELECT direto para `authenticated`: toda leitura passa pela RPC
--     `uso_telas_por_rota()`, que verifica `usuario_e_gestao()` internamente e
--     retorna vazio (sem erro) para quem não é gestão.
--   • Todo INSERT passa pela RPC `registrar_acesso_tela(p_rota)`, que lê o
--     e-mail do JWT (nunca do parâmetro) e rejeita silenciosamente sessão sem
--     identidade. O tamanho da rota é limitado a 300 chars.
--   • Funções com `security definer` têm `search_path` fixo em `'public'`.
--
-- NÃO altera fila, carteira, pagamentos nem nenhuma regra operacional.

-- ── TABELA ──────────────────────────────────────────────────────────────────

create table if not exists public.uso_telas (
  id            bigint generated always as identity primary key,
  usuario_email text   not null,
  rota          text   not null,
  dia           date   not null default current_date,
  acessos       int    not null default 1,
  unique (usuario_email, rota, dia)
);

comment on table public.uso_telas is
  'Um registro por (usuário, rota, dia): acessos é incrementado a cada troca de rota. Leitura restrita à gestão por RPC.';

create index if not exists uso_telas_dia_idx    on public.uso_telas (dia desc);
create index if not exists uso_telas_rota_idx   on public.uso_telas (rota, dia desc);
create index if not exists uso_telas_email_idx  on public.uso_telas (usuario_email, dia desc);

-- ── SEGURANÇA ────────────────────────────────────────────────────────────────

revoke all on public.uso_telas from anon, authenticated;
alter  table public.uso_telas enable row level security;
-- Sem policy de RLS: acesso exclusivo via RPC security definer.

-- ── RPC: registrar acesso (write) ────────────────────────────────────────────
-- Chamada pelo front a cada troca de rota. Silenciosa: retorna void em qualquer
-- caminho de saída antecipada (sem identidade, rota inválida).
-- `security definer` para escrever sem grant direto na tabela.

create or replace function public.registrar_acesso_tela(p_rota text)
  returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_email text;
begin
  -- Identidade do JWT; nunca vem do parâmetro.
  v_email := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  if v_email is null then return; end if;

  -- Rota obrigatória: deve começar com '/' e conter apenas chars de URL seguros.
  -- Rejeita silenciosamente rotas nulas, vazias, longas demais ou malformadas.
  if p_rota is null or btrim(p_rota) = '' then return; end if;
  if length(p_rota) > 300 then return; end if;
  if btrim(p_rota) !~ '^/[a-zA-Z0-9/_\-\.]*$' then return; end if;

  insert into public.uso_telas (usuario_email, rota, dia, acessos)
  values (v_email, btrim(p_rota), current_date, 1)
  on conflict (usuario_email, rota, dia) do update
    set acessos = public.uso_telas.acessos + 1;
end;
$function$;

-- `returns trigger` não é exposta pelo PostgREST, mas esta é `returns void` —
-- o revoke de PUBLIC é o que fecha a chamada não autenticada.
revoke all on function public.registrar_acesso_tela(text) from public;
grant  execute on function public.registrar_acesso_tela(text) to authenticated;

-- ── RPC: leitura agregada (read — só gestão) ─────────────────────────────────
-- Retorna rotas com total de acessos e usuários distintos nos últimos 30 dias,
-- ordenadas por total_acessos desc. Retorna vazio silenciosamente para quem
-- não é gestão (não levanta exceção para não vazar que a tabela existe).

create or replace function public.uso_telas_por_rota()
  returns table (
    rota           text,
    total_acessos  bigint,
    usuarios       bigint,
    ultimo_acesso  date
  )
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
begin
  if not public.usuario_e_gestao() then
    return;
  end if;

  return query
    select
      t.rota,
      sum(t.acessos)::bigint  as total_acessos,
      count(distinct t.usuario_email)::bigint as usuarios,
      max(t.dia)              as ultimo_acesso
    from public.uso_telas t
    where t.dia >= current_date - 30
    group by t.rota
    order by total_acessos desc;
end;
$function$;

revoke all on function public.uso_telas_por_rota() from public;
grant  execute on function public.uso_telas_por_rota() to authenticated;
