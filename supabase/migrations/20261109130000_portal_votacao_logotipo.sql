-- ============================================================================
-- Migration: votação interna do novo logotipo institucional ReATIVA
--            (Portal Operacional)
-- Data.......: 2026-11-09
--
-- O QUE ENTRA
--   1. public.portal_votacoes: a votação (uma linha por slug). Status
--      'aberta' | 'encerrada'.
--   2. public.portal_votos: um voto por operador ativo, com opção 1..4.
--   3. RPCs SECURITY DEFINER, as ÚNICAS portas de entrada:
--        portal_logotipo_situacao()  -> status, meu voto, se sou gestão.
--                                       NÃO devolve contagem.
--        portal_logotipo_votar(p)    -> registra o voto (uma vez, só aberta).
--        portal_logotipo_apuracao()  -> contagem. Gestão: sempre.
--                                       Operador: só depois de encerrada.
--        portal_logotipo_encerrar()  -> encerra a votação (só gestão).
--
-- O QUE NAO MUDA
--   * Nenhuma tabela existente é alterada. Nenhuma policy existente é tocada.
--   * O logotipo atual (CRM, TV e demais módulos) não é referenciado aqui.
--
-- SEGURANÇA
--   * RLS ligada nas duas tabelas e SEM policy para `authenticated`: ninguém lê
--     nem escreve direto. Os grants de tabela são revogados explicitamente
--     (objeto novo em `public` herda privilégio por padrão, inclusive TRUNCATE).
--   * "Um voto por pessoa" é índice único no banco, não só na tela.
--   * Votar exige operador ATIVO em public.usuarios (app_usuario_ativo()).
--   * Contagem parcial nunca sai para operador enquanto a votação está aberta.
--   * Cada função tem search_path fixo; EXECUTE só para `authenticated`.
--
-- ROLLBACK (manual, se precisar desfazer antes de qualquer voto relevante):
--   drop function if exists public.portal_logotipo_encerrar();
--   drop function if exists public.portal_logotipo_apuracao();
--   drop function if exists public.portal_logotipo_votar(smallint);
--   drop function if exists public.portal_logotipo_situacao();
--   drop table if exists public.portal_votos;
--   drop table if exists public.portal_votacoes;
--
-- PRÉ-REQUISITO: public.app_usuario_ativo() e public.usuario_e_gestao() já
-- existem em produção (usadas por policies vigentes).
-- ============================================================================

-- 1) Votação ------------------------------------------------------------------
create table if not exists public.portal_votacoes (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique,
  titulo                text not null,
  status                text not null default 'aberta'
                          check (status in ('aberta', 'encerrada')),
  criada_em             timestamptz not null default now(),
  encerrada_em          timestamptz,
  encerrada_por_email   text
);

-- 2) Voto ---------------------------------------------------------------------
create table if not exists public.portal_votos (
  id             uuid primary key default gen_random_uuid(),
  votacao_id     uuid not null references public.portal_votacoes (id) on delete cascade,
  usuario_email  text not null check (length(trim(usuario_email)) between 3 and 320),
  opcao          smallint not null check (opcao between 1 and 4),
  criado_em      timestamptz not null default now()
);

-- "Uma pessoa, um voto". Índice único (não constraint) porque usa lower().
create unique index if not exists portal_votos_uma_por_pessoa_idx
  on public.portal_votos (votacao_id, lower(usuario_email));

alter table public.portal_votacoes enable row level security;
alter table public.portal_votos    enable row level security;

-- Sem policy para authenticated: o acesso é só pelas RPCs abaixo.
revoke all on public.portal_votacoes from public, anon, authenticated;
revoke all on public.portal_votos    from public, anon, authenticated;

-- Votação inicial do logotipo.
insert into public.portal_votacoes (slug, titulo)
values ('logotipo-reativa-2026', 'Novo logotipo institucional ReATIVA | Recuperação de Crédito')
on conflict (slug) do nothing;

-- 3) RPCs ---------------------------------------------------------------------

-- Situação para a tela. Não traz contagem em hipótese nenhuma.
create or replace function public.portal_logotipo_situacao()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_v     public.portal_votacoes;
  v_op    smallint;
begin
  if not public.app_usuario_ativo() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

  select * into v_v from public.portal_votacoes where slug = 'logotipo-reativa-2026';
  if not found then
    return jsonb_build_object('existe', false);
  end if;

  select v.opcao into v_op
    from public.portal_votos v
   where v.votacao_id = v_v.id
     and lower(v.usuario_email) = v_email;

  return jsonb_build_object(
    'existe',      true,
    'status',      v_v.status,
    'minha_opcao', v_op,
    'gestao',      public.usuario_e_gestao()
  );
end;
$$;

-- Registra o voto. Uma vez, e só com a votação aberta.
create or replace function public.portal_logotipo_votar(p_opcao smallint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_v     public.portal_votacoes;
begin
  if not public.app_usuario_ativo() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;
  if p_opcao is null or p_opcao not between 1 and 4 then
    raise exception 'opcao_invalida' using errcode = '22023';
  end if;

  -- FOR UPDATE: fecha a corrida entre "votar" e "encerrar".
  select * into v_v from public.portal_votacoes
   where slug = 'logotipo-reativa-2026' for update;
  if not found then
    raise exception 'votacao_inexistente' using errcode = 'P0002';
  end if;
  if v_v.status <> 'aberta' then
    raise exception 'votacao_encerrada' using errcode = 'P0001';
  end if;

  begin
    insert into public.portal_votos (votacao_id, usuario_email, opcao)
    values (v_v.id, v_email, p_opcao);
  exception when unique_violation then
    raise exception 'ja_votou' using errcode = '23505';
  end;

  return jsonb_build_object('ok', true, 'minha_opcao', p_opcao);
end;
$$;

-- Contagem. Gestão vê a qualquer momento; operador só após o encerramento.
create or replace function public.portal_logotipo_apuracao()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_v     public.portal_votacoes;
  v_gestao boolean := public.usuario_e_gestao();
begin
  if not public.app_usuario_ativo() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

  select * into v_v from public.portal_votacoes where slug = 'logotipo-reativa-2026';
  if not found then
    raise exception 'votacao_inexistente' using errcode = 'P0002';
  end if;

  if not v_gestao and v_v.status <> 'encerrada' then
    raise exception 'resultado_indisponivel' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'status', v_v.status,
    'total',  (select count(*) from public.portal_votos where votacao_id = v_v.id),
    'opcoes', (
      select coalesce(jsonb_agg(jsonb_build_object('opcao', o.n, 'votos', coalesce(c.votos, 0))
                                order by o.n), '[]'::jsonb)
        from generate_series(1, 4) as o(n)
        left join (
          select opcao, count(*)::int as votos
            from public.portal_votos
           where votacao_id = v_v.id
           group by opcao
        ) c on c.opcao = o.n
    )
  );
end;
$$;

-- Encerramento: só gestão, e só uma vez.
create or replace function public.portal_logotipo_encerrar()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_v     public.portal_votacoes;
begin
  if not public.app_usuario_ativo() or not public.usuario_e_gestao() then
    raise exception 'acesso_negado' using errcode = '42501';
  end if;

  select * into v_v from public.portal_votacoes
   where slug = 'logotipo-reativa-2026' for update;
  if not found then
    raise exception 'votacao_inexistente' using errcode = 'P0002';
  end if;
  if v_v.status <> 'aberta' then
    raise exception 'ja_encerrada' using errcode = 'P0001';
  end if;

  update public.portal_votacoes
     set status = 'encerrada',
         encerrada_em = now(),
         encerrada_por_email = v_email
   where id = v_v.id;

  return jsonb_build_object('ok', true, 'status', 'encerrada');
end;
$$;

-- 4) Grants: função nova em public é executável por PUBLIC e anon por padrão.
revoke all on function public.portal_logotipo_situacao()     from public, anon;
revoke all on function public.portal_logotipo_votar(smallint) from public, anon;
revoke all on function public.portal_logotipo_apuracao()     from public, anon;
revoke all on function public.portal_logotipo_encerrar()     from public, anon;

grant execute on function public.portal_logotipo_situacao()      to authenticated;
grant execute on function public.portal_logotipo_votar(smallint) to authenticated;
grant execute on function public.portal_logotipo_apuracao()      to authenticated;
grant execute on function public.portal_logotipo_encerrar()      to authenticated;
