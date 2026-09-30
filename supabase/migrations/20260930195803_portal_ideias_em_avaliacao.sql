-- Ideias da equipe: mural de ideias VIVAS, nao de chamado fechado.
--
-- O QUE ESTAVA ERRADO
--   O mural mostrava 17 sugestoes: 16 FEITA e 1 DESCARTADA, a mais recente de
--   26/08. Nenhuma em aberto. Virou museu de chamado resolvido do CRM em vez de
--   espaco de ideia em avaliacao.
--
--   A causa e estrutural: toda sugestao nasce com visivel_equipe = false e so a
--   gestao marca. Como as novas nao sao marcadas, o mural so acumulava as antigas
--   ja resolvidas -- e quem enviava uma ideia nao via nada acontecer.
--
-- O QUE MUDA AQUI (so a funcao de leitura; nenhuma tabela e tocada)
--   1. Ideia JA RESOLVIDA sai do mural. O filtro e negativo de proposito --
--      `not in ('FEITA','DESCARTADA')` em vez de `in ('NOVA','REABERTO')` --
--      para que um status novo no Painel de Sugestoes apareca como ideia viva em
--      vez de sumir em silencio.
--   2. Quem enviou passa a ver a PROPRIA ideia mesmo antes de a gestao liberar,
--      com a coluna `minha` para a tela poder marcar "Em avaliacao". A equipe
--      inteira continua vendo so o que a gestao marcou com visivel_equipe.
--
-- O QUE NAO MUDA
--   * Nenhuma tabela criada, alterada ou apagada. A migration so substitui uma
--     funcao de leitura.
--   * A RLS de sugestoes segue INTOCADA, e nenhum campo novo e exposto: saem os
--     mesmos campos de antes, mais o booleano `minha`, que e sobre quem consulta.
--   * A gestao segue decidindo o que vira publico por visivel_equipe, e segue
--     mudando status pelo Painel de Sugestoes. Nada aqui escreve em sugestoes.
--
-- CONSEQUENCIA ESPERADA: o mural comeca VAZIO, porque as 17 atuais estao todas
-- resolvidas. Ele enche conforme a equipe enviar -- que e o ponto.
--
-- O ENVIO nao precisa de migration: a policy sugestoes_insert ja permite inserir
-- com autor_email proprio (app_usuario_ativo() and lower(autor_email) =
-- app_email()). O Portal passa a usar esse mesmo caminho, com tipo "Nova ideia" e
-- tela "Portal — Ideias da equipe" para a gestao distinguir a origem.

-- O DROP e necessario: a assinatura ganha a coluna `minha`, e CREATE OR REPLACE
-- nao aceita trocar o tipo de retorno ("cannot change return type of existing
-- function"). Dentro da migration isto e uma transacao so, entao nao existe
-- janela em que a funcao esteja ausente para quem consulta.
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
  eu_curti boolean,
  minha boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with eu as (
    select lower(coalesce(auth.jwt() ->> 'email', '')) as email,
           public.app_usuario_ativo() as ok
  ),
  base as (
    select s.id,
           btrim(s.descricao) as descricao,
           nullif(btrim(coalesce(s.nome, '')), '') as autor,
           s.criado_em,
           coalesce(nullif(btrim(coalesce(s.status, '')), ''), 'NOVA') as status,
           (lower(coalesce(s.autor_email, '')) = eu.email and eu.email <> '') as minha
      from public.sugestoes s, eu
     where eu.ok
       -- Ideia viva. Filtro negativo: status novo no Painel entra como viva.
       and coalesce(nullif(btrim(coalesce(s.status, '')), ''), 'NOVA')
             not in ('FEITA', 'DESCARTADA')
       -- Publica pela gestao, ou minha (para eu acompanhar a avaliacao).
       and (s.visivel_equipe is true
            or (lower(coalesce(s.autor_email, '')) = eu.email and eu.email <> ''))
       and nullif(btrim(coalesce(s.descricao, '')), '') is not null
  ),
  com_curtidas as (
    select b.*,
           coalesce(k.n, 0)::int as curtidas,
           coalesce(k.minha_curtida, false) as eu_curti
      from base b
      left join (
        select c.alvo_id,
               count(*) as n,
               bool_or(lower(c.usuario_email) = lower(coalesce(auth.jwt() ->> 'email', ''))) as minha_curtida
          from public.portal_curtidas c
         where c.alvo_tipo = 'ideia'
         group by c.alvo_id
      ) k on k.alvo_id = b.id
  )
  select id, descricao, autor, criado_em, status, curtidas, eu_curti, minha
    from com_curtidas
   order by
     case when lower(coalesce(p_ordem, 'recentes')) = 'curtidas' then curtidas end desc nulls last,
     criado_em desc,
     id
   limit greatest(1, least(coalesce(p_limite, 12), 50));
$$;

comment on function public.portal_ideias_equipe(text, integer) is
  'Mural de ideias VIVAS (status fora de FEITA/DESCARTADA): as que a gestao liberou por visivel_equipe, mais as da propria pessoa, para ela acompanhar a avaliacao. Devolve so descricao/autor/data/status/curtidas/minha -- tratativa interna, anexo, prioridade, e-mail e retorno ao operador NUNCA saem por aqui. SECURITY DEFINER para nao afrouxar sugestoes_select.';

revoke execute on function public.portal_ideias_equipe(text, integer) from anon, public;
grant execute on function public.portal_ideias_equipe(text, integer) to authenticated;
