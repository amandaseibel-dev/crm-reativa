-- EFETIVIDADE — ETAPA 1: a cadeia auditável do caixa até o semestre de origem.
--
-- POR QUE ESTA VIEW EXISTE. Medido em produção em 23/10/2026: o valor que a
-- Efetividade chama de "recuperado" NUNCA é lido de `pagamentos`. Ele é
-- `valor_original * (parcelas PAGO / total de parcelas)` -- um rateio do status
-- da parcela. Em toda a pilha (`carteira_safra_situacoes`,
-- `carteira_2026_1_classificar`, `carteira_2026_2_classificar`) a tabela
-- `pagamentos` aparece uma única vez, na CTE `caixa_fora`, e só como
-- data/booleano para classificar origem -- nunca como valor. Esta view é a
-- segunda camada, de CAIXA, que faltava: ela não substitui as réguas, fica ao
-- lado delas para que a diferença entre rateio e dinheiro seja mensurável.
--
-- O QUE ELA NÃO FAZ, POR DESENHO:
--   * não escreve nada -- é view, sem gatilho, sem cron, sem tabela;
--   * não presume vínculo por proximidade de data, valor ou nome. Proximidade
--     não entra: quando a chave exata não resolve, a linha sai como
--     INDETERMINADA com o motivo nomeado, e não some;
--   * não escolhe acordo nem título por desempate. Se a chave devolve mais de
--     um, o campo fica NULL e o motivo diz qual é a ambiguidade. Ordenar não é
--     comprovar, e `uuid` como critério de desempate é sorteio.
--
-- UMA LINHA POR PAGAMENTO, SEMPRE. Esta é a invariante que o teste de aceitação
-- verifica: `sum(valor_pago)` e `count(*)` da view são idênticos aos de
-- `pagamentos`. Classificar todos -- inclusive os 6.293 que não resolvem -- é o
-- que impede a view de esconder dinheiro. Por isso ela NÃO abre por título: um
-- acordo cobre N mensalidades, e abrir multiplicaria o valor pago.
--
-- AS TRÊS PORTAS, EM ORDEM DE PRECEDÊNCIA (medido em 23/10/2026):
--   1. `origem_baixa_ref`  a parcela aponta para o pagamento. É a única PROVADA.
--   2. `boleto_parcela`    `numero_parcela_completo` = `parcelas.boleto`, 11
--                          dígitos, casamento 1:1 em 14.488/14.488 parcelas e
--                          ZERO boletos casando mais de uma parcela.
--   3. `numero_ulbra`      `pagamentos.titulo_numero` = `acordos.numero_ulbra`.
--                          ATENÇÃO: `titulo_numero` é o número do ACORDO (5
--                          dígitos), NÃO o do título. A rota direta
--                          pagamento -> mensalidade não existe: testada, 0 de
--                          10.715.
--
-- SEGURANÇA. A view nasce FECHADA: `security_invoker = true` (as permissões e a
-- RLS de quem chama valem, em vez das do dono) e os privilégios do schema
-- `public` -- que fazem tabela e view novas nascerem acessíveis a
-- `authenticated` -- são revogados explicitamente. A leitura pela gestão vem na
-- Etapa 2, por função com o portão `carteira_2026_1_pode_ler()`, como as outras
-- telas de carteira. Abrir a view direto para `authenticated` exporia o caixa
-- aluno por aluno a qualquer pessoa logada.

create or replace view public.efetividade_caixa_origem
with (security_invoker = true) as
with pg as (
  select p.id, p.aluno_id, p.data_pagamento, p.valor_pago,
         coalesce(p.valor_honorario, 0) as valor_honorario,
         p.tipo_pagamento, p.status_conciliacao,
         regexp_replace(coalesce(p.numero_parcela_completo, ''), '[^0-9]', '', 'g') as boleto_parcela,
         regexp_replace(coalesce(p.titulo_numero, ''),           '[^0-9]', '', 'g') as acordo_numero
    from public.pagamentos p
),
-- Porta 1 -- PROVADA. `origem_baixa_ref` é texto e guarda o `pagamentos.id`.
porta1 as (
  select pg.id as pagamento_id, pa.acordo_id
    from pg
    join public.parcelas pa on pa.origem_baixa_ref = pg.id::text
   where pa.acordo_id is not null
),
-- Porta 2 -- chave exata pelo boleto completo da parcela.
porta2 as (
  select pg.id as pagamento_id, pa.acordo_id
    from pg
    join public.parcelas pa
      on regexp_replace(coalesce(pa.boleto, ''), '[^0-9]', '', 'g') = pg.boleto_parcela
   where pg.boleto_parcela <> '' and pa.acordo_id is not null
),
-- Porta 3 -- chave exata pelo número do acordo na ULBRA.
porta3 as (
  select pg.id as pagamento_id, a.id as acordo_id
    from pg
    join public.acordos a
      on regexp_replace(coalesce(a.numero_ulbra, ''), '[^0-9]', '', 'g') = pg.acordo_numero
   where pg.acordo_numero <> ''
),
portas as (
  select pagamento_id, acordo_id, 1 as prioridade, 'origem_baixa_ref'::text as porta from porta1
  union all
  select pagamento_id, acordo_id, 2, 'boleto_parcela' from porta2
  union all
  select pagamento_id, acordo_id, 3, 'numero_ulbra'   from porta3
),
-- Precedência: vale a porta de MENOR número que resolveu o pagamento. Sem isto
-- um pagamento alcançado por duas portas apareceria com dois acordos e viraria
-- "ambíguo" sem ser -- a porta provada já tinha respondido.
escolhida as (
  select pagamento_id, min(prioridade) as prioridade from portas group by 1
),
resolvido as (
  select e.pagamento_id,
         e.prioridade,
         -- `porta` é função de `prioridade`, então o agregado é determinístico.
         max(p.porta)                     as porta,
         count(distinct p.acordo_id)      as acordos,
         -- `min(uuid)` não existe em Postgres. O elemento [1] só é usado adiante
         -- quando `acordos = 1`, e aí o array tem um elemento só.
         (array_agg(distinct p.acordo_id))[1] as acordo_unico
    from escolhida e
    join portas p
      on p.pagamento_id = e.pagamento_id and p.prioridade = e.prioridade
   group by 1, 2
),
-- As DUAS portas de título do acordo: a direta e a do mutirão. `union` (não
-- `all`) porque o mesmo par pode vir pelos dois caminhos.
tit as (
  select t.acordo_id, t.id as titulo_id, t.documento
    from public.acordos_titulos t
   where t.acordo_id is not null
  union
  select v.acordo_id, t.id, t.documento
    from public.acordo_titulo_vinculo v
    join public.acordos_titulos t on t.id = v.titulo_id
   where coalesce(v.ativo, true)
),
-- Semestre de origem: fonte oficial é a série do Prime, pelo boleto da
-- mensalidade (`docs/integracoes/prime-mapa-fontes-verdade.md`). Sem série, não
-- há semestre -- e NÃO se infere por vencimento aqui.
serie as (
  select regexp_replace(coalesce(boleto, ''), '[^0-9]', '', 'g') as boleto,
         max(semestre) as semestre
    from public.prime_titulo_semestre
   where coalesce(semestre, '') <> ''
   group by 1
),
alcance as (
  select r.pagamento_id,
         count(distinct t.titulo_id) as titulos,
         count(distinct s.semestre)  as semestres,
         (array_agg(distinct s.semestre) filter (where s.semestre is not null))[1] as semestre_unico,
         (array_agg(distinct t.titulo_id))[1] as titulo_unico,
         (array_agg(distinct t.documento))[1] as documento_unico
    from resolvido r
    join tit t on t.acordo_id = r.acordo_unico
    left join serie s
      on s.boleto = regexp_replace(coalesce(t.documento, ''), '[^0-9]', '', 'g')
   where r.acordos = 1
   group by 1
)
select
  pg.id                                   as pagamento_id,
  pg.data_pagamento,
  to_char(pg.data_pagamento, 'YYYY-MM')   as mes_recebimento,
  pg.valor_pago,
  pg.valor_honorario,
  pg.tipo_pagamento,
  pg.status_conciliacao,
  pg.aluno_id,
  case when r.acordos = 1 then r.acordo_unico end        as acordo_id,
  nullif(pg.acordo_numero, '')                           as acordo_numero_informado,
  case when al.titulos = 1 then al.titulo_unico end      as titulo_id,
  case when al.titulos = 1 then al.documento_unico end   as titulo_documento,
  case when al.semestres = 1 then al.semestre_unico end  as semestre_origem,
  r.porta                                                as porta_vinculo,
  coalesce(al.titulos, 0)                                as titulos_alcancados,
  coalesce(al.semestres, 0)                              as semestres_distintos,
  case when al.semestres = 1 and r.prioridade = 1 then 'PROVADA'
       when al.semestres = 1                      then 'CHAVE_EXATA'
       else                                            'INDETERMINADA'
  end                                                    as confianca,
  -- A ordem destes testes é a classificação. `ACORDO_AMBIGUO` tem de vir antes
  -- de `ACORDO_SEM_TITULO`: quando a chave devolve 2 acordos, `alcance` não
  -- roda (ela exige `acordos = 1`) e `titulos` fica 0 -- o que faria um
  -- pagamento ambíguo ser rotulado como acordo sem título.
  case when al.semestres = 1              then null
       when r.pagamento_id is null        then 'ACORDO_FORA_DO_CRM'
       when r.acordos > 1                 then 'ACORDO_AMBIGUO'
       when coalesce(al.titulos, 0)   = 0 then 'ACORDO_SEM_TITULO'
       when coalesce(al.semestres, 0) = 0 then 'TITULO_SEM_SERIE_PRIME'
       else                                    'SEMESTRE_MULTIPLO'
  end                                                    as motivo_indeterminado
from pg
left join resolvido r on r.pagamento_id = pg.id
left join alcance   al on al.pagamento_id = pg.id;

comment on view public.efetividade_caixa_origem is
  'Etapa 1 da Efetividade Financeira: uma linha por pagamento, com o semestre de '
  'origem quando as chaves exatas o resolvem e o motivo nomeado quando nao. Nao '
  'escreve, nao infere por proximidade e nao desempata acordo nem titulo. '
  'sum(valor_pago) e count(*) sao identicos aos de public.pagamentos -- nenhum '
  'pagamento fica fora. Ler pela funcao da Etapa 2, com portao de gestao.';

-- Fecha a view. No schema `public` deste projeto os privilégios padrão fazem
-- objeto novo nascer acessível a `authenticated` -- medido em 30/09/2026, quando
-- uma tabela nova herdou até TRUNCATE. Revogar é obrigatório, não zelo.
do $$
declare r text;
begin
  revoke all on public.efetividade_caixa_origem from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.efetividade_caixa_origem from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.efetividade_caixa_origem to service_role;
  end if;
end $$;
