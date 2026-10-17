-- ACOES MASSIVAS: ninguem com divida viva fica sem explicacao.
--
-- O PROBLEMA. `acoes_massivas_universo` monta a base com titulo
-- `situacao in ('ABERTO','NEGOCIADO')`, `tipo_boleto <> 'Acordo'` e valor > 0
-- (ou parcela VENCIDA de acordo ATIVO). Quem tem divida viva FORA desses
-- criterios nao aparece como indisponivel: some. Nao ha motivo, nao ha
-- drill-down, nao ha linha nenhuma -- e e exatamente a pergunta "por que esse
-- aluno nao aparece?" que ninguem conseguia responder.
--
-- MEDIDO EM PRODUCAO, 15/10 (titulo nao quitado, valor > 0, dono fora do
-- universo):
--   CANCELADA        mensalidade  94 alunos  R$ 2.804.154
--   EM_CONFIRMACAO   mensalidade 227 alunos  R$   359.244
--   DEVOLVIDO        mensalidade   7 alunos  R$    42.490
--   NEGOCIADO        tipo 'Acordo' 22 alunos R$    15.825
--   DUPLICADA        mens./acordo   5 alunos R$     3.399
--   ABERTO           tipo 'Acordo'  1 aluno  R$       304
-- Pelo lado operacional: 27 casos ativos com `total_em_aberto > 0`.
-- Nenhum caso de vencimento nulo -- a base acerta onde importa (0 alunos fora
-- em ABERTO/NEGOCIADO de mensalidade).
--
-- O QUE ESTA FUNCAO FAZ: so conta e explica. E ADITIVA -- nao toca na
-- `acoes_massivas_universo`, nao muda motivo, precedencia, elegibilidade nem
-- disponibilidade de ninguem. Quem esta na fila hoje continua igual.
--
-- POR QUE NAO ENFIAR ESSES ALUNOS NA BASE. Trazer EM_CONFIRMACAO para dentro
-- do universo seria **restricao nova**, nao paridade: a regra atual nao bloqueia
-- por titulo em confirmacao, e a gestao deixou isso em aberto em 01/10 (J2.2.5,
-- os 92 alunos / R$ 203.389,82). Alem disso, os anos desses titulos entrariam
-- no array `anos` de quem JA esta no universo e mexeriam no painel por ano sem
-- ninguem ter pedido. Primeiro se enxerga; depois a gestao decide o que entra.
--
-- ACESSO: SECURITY DEFINER com portao interno de gestao -- funcao nova herda
-- EXECUTE para `authenticated`, entao o portao e obrigatorio, nao opcional.

create or replace function public.acoes_massivas_fora_do_universo()
returns table (
  motivo_fora text,
  alunos      integer,
  titulos     integer,
  valor       numeric
)
language plpgsql stable security definer
set search_path to 'public'
set statement_timeout to '60s'
as $fn$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: auditoria do universo das acoes massivas restrita a gestao.' using errcode = '42501';
  end if;

  return query
  with u as materialized (
    select x.aluno_id from public.acoes_massivas_universo('{"operador":"todos"}'::jsonb) x
  ),
  cand as (
    select t.aluno_id,
           case when coalesce(t.tipo_boleto, '') = 'Acordo'
                then 'BOLETO_DE_ACORDO'
                else 'SITUACAO_' || upper(coalesce(nullif(btrim(t.situacao), ''), 'NULA')) end as motivo,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v
      from public.acordos_titulos t
     where t.aluno_id is not null
       and coalesce(lower(t.status), '') <> 'quitada'
  )
  select c.motivo,
         count(distinct c.aluno_id)::int,
         count(*)::int,
         round(sum(c.v), 2)
    from cand c
   where c.v > 0
     and not exists (select 1 from u where u.aluno_id = c.aluno_id)
   group by c.motivo
   order by 4 desc;
end;
$fn$;

comment on function public.acoes_massivas_fora_do_universo() is
  'Auditoria das Acoes Massivas: quem tem titulo nao quitado com valor > 0 e MESMO ASSIM nao entra em acoes_massivas_universo, agrupado pelo motivo (situacao do titulo ou boleto de acordo). Leitura pura e aditiva: nao altera a fila nem os motivos de indisponibilidade. Serve para responder "por que esse aluno nao aparece?" sem precisar reconstruir a base na mao.';

revoke all on function public.acoes_massivas_fora_do_universo() from public, anon;
grant execute on function public.acoes_massivas_fora_do_universo() to authenticated, service_role;
