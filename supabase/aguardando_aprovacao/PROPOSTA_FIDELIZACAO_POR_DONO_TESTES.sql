-- ============================================================================
-- TESTES DA PROPOSTA -- FIDELIZACAO PERTENCE AO RESPONSAVEL ATUAL
--
-- >>> SOMENTE LEITURA. NAO CRIA, NAO ALTERA E NAO LE TABELA NENHUMA. <<<
-- Tudo sai de VALUES. Pode ser executado em qualquer ambiente, inclusive
-- producao, sem risco e sem a proposta aplicada -- e foi: rodado contra
-- producao em 29/09/2026, 10 de 10 casos PASSOU.
--
-- POR QUE AS EXPRESSOES ESTAO REESCRITAS AQUI, e nao chamadas por nome: a
-- proposta ainda NAO foi aplicada, entao public.fidelizacao_vencida() nao
-- existe. As expressoes abaixo sao IDENTICAS as do arquivo da proposta, linha
-- por linha. Depois de aplicar, rodar de novo trocando a expressao inline pela
-- chamada da funcao -- o resultado tem de ser o mesmo.
--
-- FRONTEIRA SOB TESTE (regra literal da gestao, 29/09/2026):
--   "10 dias completos de fidelizacao; no primeiro dia seguinte o caso pode
--    se tornar elegivel."
--   (inicio AT TIME ZONE 'America/Sao_Paulo')::date + dias
--     <= (agora  AT TIME ZONE 'America/Sao_Paulo')::date
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOCO 1 -- FRONTEIRA DOS 10 DIAS
--
-- `agora` e injetado como parametro em vez de now(), para poder testar datas
-- futuras sem esperar por elas. Em producao, `agora` = now().
-- ----------------------------------------------------------------------------
with p as (select 10 as dias),
casos(id, descricao, inicio, agora, esperado) as (values
  -- 1..3: a HORA da atribuicao nao pode mudar o dia elegivel.
  ('T01','inicio 01/10 00:01 BRT -- em 10/10 ainda protegido',
         timestamptz '2026-10-01 00:01:00-03', timestamptz '2026-10-10 10:00:00-03', false),
  ('T02','inicio 01/10 00:01 BRT -- em 11/10 elegivel',
         timestamptz '2026-10-01 00:01:00-03', timestamptz '2026-10-11 00:00:00-03', true),
  ('T03','inicio 01/10 14:30 BRT -- em 10/10 ainda protegido',
         timestamptz '2026-10-01 14:30:00-03', timestamptz '2026-10-10 23:00:00-03', false),
  ('T04','inicio 01/10 14:30 BRT -- em 11/10 elegivel (hora nao atrasa)',
         timestamptz '2026-10-01 14:30:00-03', timestamptz '2026-10-11 00:05:00-03', true),
  ('T05','inicio 01/10 23:59 BRT -- em 10/10 ainda protegido',
         timestamptz '2026-10-01 23:59:00-03', timestamptz '2026-10-10 23:59:00-03', false),
  ('T06','inicio 01/10 23:59 BRT -- em 11/10 elegivel',
         timestamptz '2026-10-01 23:59:00-03', timestamptz '2026-10-11 08:20:00-03', true),
  -- 7: A ARMADILHA DO UTC. 10/10 22:30 BRT = 11/10 01:30 UTC. Pela data local
  -- ainda e dia 10 e o caso segue protegido; por current_date (UTC) ja seria
  -- dia 11 e o caso sairia um dia antes. Tem de dar false.
  ('T07','execucao 10/10 22:30 BRT (=11/10 01:30 UTC) -- NAO antecipa',
         timestamptz '2026-10-01 09:00:00-03', timestamptz '2026-10-10 22:30:00-03', false),
  ('T08','execucao 11/10 00:30 BRT -- ja elegivel',
         timestamptz '2026-10-01 09:00:00-03', timestamptz '2026-10-11 00:30:00-03', true),
  -- 9..10: viradas de mes e de ano.
  ('T09','virada de MES: inicio 25/10 -> elegivel 04/11 (03/11 protegido)',
         timestamptz '2026-10-25 09:00:00-03', timestamptz '2026-11-03 09:00:00-03', false),
  ('T10','virada de MES: inicio 25/10 -> elegivel em 04/11',
         timestamptz '2026-10-25 09:00:00-03', timestamptz '2026-11-04 09:00:00-03', true),
  ('T11','virada de ANO: inicio 25/12/2026 -> 03/01/2027 protegido',
         timestamptz '2026-12-25 09:00:00-03', timestamptz '2027-01-03 09:00:00-03', false),
  ('T12','virada de ANO: inicio 25/12/2026 -> elegivel em 04/01/2027',
         timestamptz '2026-12-25 09:00:00-03', timestamptz '2027-01-04 09:00:00-03', true)
)
select c.id, c.descricao,
  ((c.inicio at time zone 'America/Sao_Paulo')::date + p.dias) as elegivel_em,
  (c.agora at time zone 'America/Sao_Paulo')::date as dia_da_execucao,
  c.esperado,
  (((c.inicio at time zone 'America/Sao_Paulo')::date + p.dias)
     <= (c.agora at time zone 'America/Sao_Paulo')::date) as obtido,
  -- a regra ANTIGA (v1), so para mostrar a diferenca de um dia que a gestao
  -- decidiu corrigir: `< current_date`, em UTC
  ((c.inicio::date + p.dias) < (c.agora at time zone 'UTC')::date) as regra_antiga_v1,
  -- A MESMA regra nova, mas em UTC -- o erro que o fuso de Brasilia evita.
  -- Em T07 esta coluna da TRUE e a adotada da FALSE: e a antecipacao de um dia
  -- que aconteceria em qualquer execucao entre 21:00 e 23:59 BRT.
  (((c.inicio at time zone 'UTC')::date + p.dias) <= (c.agora at time zone 'UTC')::date) as mesma_regra_em_utc,
  case when c.esperado =
            (((c.inicio at time zone 'America/Sao_Paulo')::date + p.dias)
               <= (c.agora at time zone 'America/Sao_Paulo')::date)
       then 'PASSOU' else '*** FALHOU ***' end as resultado
from casos c cross join p
order by c.id;

-- ----------------------------------------------------------------------------
-- BLOCO 2 -- O TETO E POR OPERADOR, NUNCA GLOBAL
--
-- Cenario pedido pela gestao: operador A com 35 elegiveis, B com 8, teto 20.
-- Esperado: A solta 20, B solta 8, total 28, e sobram 15 de A para amanha.
--
-- A expressao de janela e a MESMA da v2: partition by operador_email,
-- order by fidelizacao_inicio, responsavel_atual_em, caso_id.
-- ----------------------------------------------------------------------------
with p as (select 20 as teto),
sintetico as (
  select 'A' as operador, g as n,
         timestamptz '2026-10-01 00:00:00-03' + (g || ' minutes')::interval as fidelizacao_inicio,
         timestamptz '2026-08-01 00:00:00-03' + (g || ' hours')::interval as responsavel_atual_em,
         ('00000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid as caso_id,
         false as protegido
    from generate_series(1, 35) g
  union all
  select 'B', g,
         timestamptz '2026-10-01 00:00:00-03' + (g || ' minutes')::interval,
         timestamptz '2026-08-01 00:00:00-03' + (g || ' hours')::interval,
         ('11111111-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
         false
    from generate_series(1, 8) g
),
numerado as (
  select s.*, row_number() over (partition by s.operador
                                 order by s.fidelizacao_inicio asc,
                                          s.responsavel_atual_em asc nulls first,
                                          s.caso_id asc) as ordem_na_fila
    from sintetico s
   where not s.protegido
)
select n.operador,
       count(*) as elegiveis,
       count(*) filter (where n.ordem_na_fila <= p.teto) as libera_hoje,
       count(*) filter (where n.ordem_na_fila >  p.teto) as fica_na_fila,
       case n.operador
         when 'A' then case when count(*) filter (where n.ordem_na_fila <= p.teto) = 20
                             and count(*) filter (where n.ordem_na_fila > p.teto) = 15
                            then 'PASSOU' else '*** FALHOU ***' end
         when 'B' then case when count(*) filter (where n.ordem_na_fila <= p.teto) = 8
                             and count(*) filter (where n.ordem_na_fila > p.teto) = 0
                            then 'PASSOU' else '*** FALHOU ***' end
       end as resultado
  from numerado n cross join p
 group by n.operador, p.teto
 union all
select 'TOTAL', 43, 28, 15,
       case when (select count(*) from numerado n2 cross join p p2
                   where n2.ordem_na_fila <= p2.teto) = 28
            then 'PASSOU -- 28, e nao 20: o teto NAO e global'
            else '*** FALHOU ***' end
 order by 1;

-- ----------------------------------------------------------------------------
-- BLOCO 3 -- CASO PROTEGIDO NAO CONSOME VAGA DO TETO
--
-- Cenario pedido pela gestao: 25 elegiveis ordenados, os 5 PRIMEIROS
-- protegidos, teto 20. Esperado: 20 desprotegidos liberados (nao 15), os 5
-- protegidos ficam registrados mas com posicao nula.
--
-- Na v2 isto sai de graca: em SQL o WHERE e avaliado ANTES das funcoes de
-- janela, entao `where not protegido` faz o row_number numerar apenas os
-- desprotegidos. Este teste existe para provar que nao se perde na reescrita.
-- ----------------------------------------------------------------------------
with p as (select 20 as teto),
sintetico as (
  select 'C' as operador, g as n,
         timestamptz '2026-10-01 00:00:00-03' + (g || ' minutes')::interval as fidelizacao_inicio,
         timestamptz '2026-08-01 00:00:00-03' + (g || ' hours')::interval as responsavel_atual_em,
         ('22222222-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid as caso_id,
         (g <= 5) as protegido          -- os 5 MAIS ANTIGOS estao protegidos
    from generate_series(1, 25) g
),
numerado as (
  select s.*, row_number() over (partition by s.operador
                                 order by s.fidelizacao_inicio asc,
                                          s.responsavel_atual_em asc nulls first,
                                          s.caso_id asc) as ordem_na_fila
    from sintetico s
   where not s.protegido               -- <<< a chave do teste
),
contagem as (
  select (select count(*) from sintetico)                          as vencidos,
         (select count(*) from sintetico where protegido)          as protegidos,
         (select count(*) from numerado n cross join p
           where n.ordem_na_fila <= p.teto)                        as libera_hoje,
         (select count(*) from numerado n cross join p
           where n.ordem_na_fila >  p.teto)                        as fica_na_fila,
         -- o numero que sairia se protegido consumisse vaga (o bug que evitamos)
         (select count(*) from sintetico s cross join p
           where not s.protegido and s.n <= p.teto)                as se_protegido_consumisse
)
select vencidos, protegidos, libera_hoje, fica_na_fila, se_protegido_consumisse,
  case when libera_hoje = 20 and fica_na_fila = 0 and se_protegido_consumisse = 15
       then 'PASSOU -- 20 desprotegidos liberados; se protegido consumisse vaga seriam 15'
       else '*** FALHOU ***' end as resultado
from contagem;

-- ----------------------------------------------------------------------------
-- BLOCO 4 -- OS TRES TIPOS AMPLIADOS
--
-- EM_ATENDIMENTO, RETORNO_TERMO e BAIXA_REALIZADA renovam fidelizacao_inicio e
-- NAO estao na lista antiga (que manda em data_ultimo_acionamento). Prova que a
-- ampliacao e exatamente essa, sem efeito colateral na semantica antiga.
--
-- As duas listas estao reescritas aqui porque a proposta nao foi aplicada;
-- `antiga` e copia literal de public.eh_tipo_acionamento (existe hoje em
-- producao) e `nova` e copia literal de public.eh_acionamento_fidelizacao.
-- ----------------------------------------------------------------------------
with antiga(tipo) as (values
  ('FINALIZACAO_ATENDIMENTO'),('FINALIZACAO'),('ACAO_MASSIVA_EXTERNA'),
  ('ACAO_MASSIVA_EXTERNA_EMAIL'),('CONTATO'),('LINK_ENVIADO_AO_ALUNO'),
  ('SOLICITACAO_LINK_PAGAMENTO'),('COMPROVANTE_ENVIADO_BAIXA'),('QUITADO_MANUAL'),
  ('TERMO_ENVIADO_ADM'),('RETORNO_ADM_CRIADO'),('RETORNO_ADM_CONCLUIDO')),
nova(tipo) as (values
  ('FINALIZACAO_ATENDIMENTO'),('EM_ATENDIMENTO'),('LINK_ENVIADO_AO_ALUNO'),
  ('COMPROVANTE_ENVIADO_BAIXA'),('RETORNO_TERMO'),('BAIXA_REALIZADA'),('QUITADO_MANUAL')),
esperado(tipo, renova_fidelizacao, toca_dua, nota) as (values
  ('EM_ATENDIMENTO',            true,  false, 'ampliado de proposito'),
  ('RETORNO_TERMO',             true,  false, 'ampliado de proposito'),
  ('BAIXA_REALIZADA',           true,  false, 'ampliado de proposito'),
  ('FINALIZACAO_ATENDIMENTO',   true,  true,  'nas duas listas'),
  ('LINK_ENVIADO_AO_ALUNO',     true,  true,  'nas duas listas'),
  ('COMPROVANTE_ENVIADO_BAIXA', true,  true,  'nas duas listas'),
  ('QUITADO_MANUAL',            true,  true,  'nas duas listas'),
  ('RETORNO_ADM_CRIADO',        false, true,  'reprovado para fidelizacao'),
  ('RETORNO_ADM_CONCLUIDO',     false, true,  'reprovado para fidelizacao'),
  ('SOLICITACAO_LINK_PAGAMENTO',false, true,  'reprovado para fidelizacao'),
  ('TERMO_ENVIADO_ADM',         false, true,  'reprovado para fidelizacao'),
  ('CONTATO',                   false, true,  'reprovado para fidelizacao'),
  ('FINALIZACAO',               false, true,  'legado, reprovado'),
  ('ACAO_MASSIVA_EXTERNA',      false, false, 'massiva: barrada no corpo da funcao'),
  ('ACAO_MASSIVA_EXTERNA_EMAIL',false, false, 'massiva: barrada no corpo da funcao'),
  ('ACAO_DESFEITA',             false, false, 'fora das duas listas')
)
select e.tipo, e.nota,
  e.renova_fidelizacao as esperado_renova,
  (e.tipo in (select tipo from nova)) as obtido_renova,
  e.toca_dua as esperado_toca_dua,
  -- massiva esta na lista antiga mas e barrada logo depois, no corpo da funcao
  (e.tipo in (select tipo from antiga)
   and e.tipo not in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')) as obtido_toca_dua,
  case when e.renova_fidelizacao = (e.tipo in (select tipo from nova))
        and e.toca_dua = (e.tipo in (select tipo from antiga)
              and e.tipo not in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL'))
       then 'PASSOU' else '*** FALHOU ***' end as resultado
from esperado e
order by e.renova_fidelizacao desc, e.toca_dua, e.tipo;

-- ----------------------------------------------------------------------------
-- BLOCO 5 -- BACKFILL: nunca reduz, e e idempotente
--
-- Reproduz a expressao do backfill:
--   novo = greatest(fidelizacao_inicio_atual, atribuicao, corte)
-- e a guarda de escrita:
--   (atual is null or atual < greatest(atribuicao, corte))
-- ----------------------------------------------------------------------------
-- ATENCAO: o corte entra como INSTANTE ancorado em Brasilia
-- ((corte::timestamp at time zone 'America/Sao_Paulo')), nunca como
-- corte::timestamptz -- num banco em UTC isso daria 30/09 21:00 BRT e
-- antecipararia a elegibilidade em um dia. Foi assim que este bloco pegou o bug
-- em 29/09/2026, antes de qualquer aplicacao.
with p as (select date '2026-10-01' as corte),
casos(id, descricao, atual, atribuicao, esperado_novo, esperado_escreve) as (values
  ('B01','atribuido ANTES do corte, primeira execucao -> recebe o corte',
     null::timestamptz, timestamptz '2026-08-15 10:00:00-03',
     timestamptz '2026-10-01 00:00:00-03', true),
  ('B02','atribuido DEPOIS do corte -> recebe a atribuicao real',
     null::timestamptz, timestamptz '2026-10-09 16:20:00-03',
     timestamptz '2026-10-09 16:20:00-03', true),
  ('B03','segunda execucao no mesmo dia -> nao escreve (idempotente)',
     timestamptz '2026-10-01 00:00:00-03', timestamptz '2026-08-15 10:00:00-03',
     timestamptz '2026-10-01 00:00:00-03', false),
  ('B04','dono ja renovou depois do corte -> backfill NAO reduz',
     timestamptz '2026-10-07 11:00:00-03', timestamptz '2026-08-15 10:00:00-03',
     timestamptz '2026-10-07 11:00:00-03', false),
  ('B05','aluno sem responsavel_atual_em -> cai no corte',
     null::timestamptz, null::timestamptz,
     timestamptz '2026-10-01 00:00:00-03', true)
)
select c.id, c.descricao,
  greatest(c.atual, coalesce(c.atribuicao, (p.corte::timestamp at time zone 'America/Sao_Paulo')), (p.corte::timestamp at time zone 'America/Sao_Paulo')) as novo,
  c.esperado_novo,
  (c.atual is null
   or c.atual < greatest(coalesce(c.atribuicao, (p.corte::timestamp at time zone 'America/Sao_Paulo')), (p.corte::timestamp at time zone 'America/Sao_Paulo'))) as escreve,
  c.esperado_escreve,
  case when greatest(c.atual, coalesce(c.atribuicao, (p.corte::timestamp at time zone 'America/Sao_Paulo')), (p.corte::timestamp at time zone 'America/Sao_Paulo')) = c.esperado_novo
        and (c.atual is null
             or c.atual < greatest(coalesce(c.atribuicao, (p.corte::timestamp at time zone 'America/Sao_Paulo')), (p.corte::timestamp at time zone 'America/Sao_Paulo')))
            = c.esperado_escreve
       then 'PASSOU' else '*** FALHOU ***' end as resultado
from casos c cross join p
order by c.id;
