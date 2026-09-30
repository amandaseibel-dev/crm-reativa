-- C2 — Ideias da equipe.
--
-- NAO cria tabela de ideias. A fonte e public.sugestoes, que ja existe com 48
-- registros e com a coluna `visivel_equipe` -- criada em 20260806130000
-- justamente para marcar o que a equipe pode ver.
--
-- O PROBLEMA A RESOLVER: `sugestoes_select` restringe a leitura a
-- usuario_e_gestao_fila(). A equipe nao le sugestao nenhuma, nem a propria.
-- Afrouxar aquela policy exporia tratativa interna, anexo, prioridade e retorno
-- ao operador. Entao a policy fica INTOCADA e o mural sai por uma funcao
-- SECURITY DEFINER que devolve 6 campos e mais nada.
--
-- O QUE O MURAL DEVOLVE          O QUE NUNCA SAI DAQUI
--   id (para poder curtir)         autor_email
--   descricao                      observacao_tratativa
--   autor (a coluna `nome`)        motivo_impacto, retorno_operador
--   criado_em                      anexo_path, anexo_nome
--   status                         prioridade, tela, area, tipo
--   curtidas                       status_por, status_em, validado_em
--
-- A GESTAO SEGUE MANDANDO: so entra no mural o que tem visivel_equipe = true, e
-- quem liga essa marca continua sendo a gestao pelo Painel de Sugestoes. Esta
-- migration nao altera esse fluxo, nao muda status de nada e nao escreve em
-- sugestoes -- so le.
--
-- STATUS: o dominio real hoje e NOVA, REABERTO, FEITA e DESCARTADA, sem CHECK,
-- definido pelo fluxo existente. Esta migration NAO mexe nisso; a traducao para
-- rotulo legivel ("Implementada", "Nao seguira") e feita na interface.

-- 1. Curtidas passam a aceitar ideia.
alter table public.portal_curtidas
  drop constraint if exists portal_curtidas_alvo_tipo_check;
alter table public.portal_curtidas
  add constraint portal_curtidas_alvo_tipo_check
  check (alvo_tipo in ('playlist', 'elogio', 'ideia'));

-- 2. O mural de ideias.
--
--    A ordenacao vem do banco porque "mais curtidas" depende da contagem, que
--    esta aqui. Os dois criterios terminam em desempate deterministico para que
--    a lista nao troque de ordem sozinha entre dois carregamentos.
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
