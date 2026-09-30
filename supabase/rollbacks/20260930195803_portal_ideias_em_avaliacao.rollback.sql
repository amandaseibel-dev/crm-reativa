-- Rollback de 20260930200000_portal_ideias_em_avaliacao.
--
-- Nao apaga nada e nao toca tabela nenhuma: a migration so substituiu uma funcao
-- de leitura. Este rollback devolve portal_ideias_equipe() a versao de
-- 20260930165209 -- sem a coluna `minha`, mostrando qualquer status e apenas o
-- que a gestao marcou como visivel_equipe.
--
-- O DROP e necessario antes do CREATE porque a assinatura de retorno muda (a
-- versao atual tem uma coluna a mais), e CREATE OR REPLACE nao aceita trocar o
-- tipo de retorno.

drop function if exists public.portal_ideias_equipe(text, integer);

create or replace function public.portal_ideias_equipe(
  p_ordem text default 'recentes',
  p_limite integer default 12
)
returns table (
  id uuid,
  descricao text,
  autor text,
  criado_em timestamptz,
  status text,
  curtidas integer,
  eu_curti boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with permitido as (
    select public.app_usuario_ativo() as ok
  ),
  base as (
    select s.id, btrim(s.descricao) as descricao,
           nullif(btrim(coalesce(s.nome, '')), '') as autor,
           s.criado_em, s.status
      from public.sugestoes s, permitido
     where permitido.ok
       and s.visivel_equipe is true
       and nullif(btrim(coalesce(s.descricao, '')), '') is not null
  ),
  com_curtidas as (
    select b.*,
           coalesce(k.n, 0)::int as curtidas,
           coalesce(k.minha, false) as eu_curti
      from base b
      left join (
        select c.alvo_id,
               count(*) as n,
               bool_or(lower(c.usuario_email) = lower(coalesce(auth.jwt() ->> 'email', ''))) as minha
          from public.portal_curtidas c
         where c.alvo_tipo = 'ideia'
         group by c.alvo_id
      ) k on k.alvo_id = b.id
  )
  select id, descricao, autor, criado_em, status, curtidas, eu_curti
    from com_curtidas
   order by
     case when lower(coalesce(p_ordem, 'recentes')) = 'curtidas' then curtidas end desc nulls last,
     criado_em desc,
     id
   limit greatest(1, least(coalesce(p_limite, 12), 50));
$$;

comment on function public.portal_ideias_equipe(text, integer) is
  'Mural de ideias: sugestoes com visivel_equipe = true, apenas descricao/autor/data/status/curtidas. SECURITY DEFINER para nao afrouxar sugestoes_select -- tratativa interna, anexo, prioridade, e-mail e retorno ao operador NUNCA saem por aqui. p_ordem aceita "curtidas" ou "recentes" (padrao).';

revoke execute on function public.portal_ideias_equipe(text, integer) from anon, public;
grant execute on function public.portal_ideias_equipe(text, integer) to authenticated;
