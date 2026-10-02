-- =============================================================================
-- PROVA ANTES/DEPOIS — COBERTURA DE ACIONAMENTO EM 10 DIAS
-- Saúde Completa da Carteira  x  Ações Massivas
--
-- SOMENTE LEITURA. Nenhum statement aqui escreve, cria ou altera objeto.
-- Rodar no SQL Editor do Supabase (projeto da produção) e me devolver a saída.
--
-- O QUE ESTA PROVA RESPONDE
--   A tela calcula acionamento por `casos.data_ultimo_acionamento`.
--   Ações Massivas calcula por `aluno_movimentacoes` + acoes_massivas_tipo_cobertura(),
--   descartando finalização desfeita.
--   Desde 20/09 a ação massiva confirmada NÃO atualiza data_ultimo_acionamento
--   (migration 20260920120000, para não renovar fidelização) mas CONTA na cobertura.
--   Logo a tela deve estar subcontando cobertura. Estas queries medem o tamanho disso.
--
-- NADA AQUI TOCA FIDELIZAÇÃO NEM REGRA FINANCEIRA.
--
-- NOTA DE TIPO: em acoes_massivas_universo o filtro usa `v_ids_txt`, o que sugere
-- aluno_movimentacoes.aluno_id como TEXT. O bloco 0 confirma. Se for text, as
-- queries abaixo já fazem o cast; se for uuid, remova os `::text`.
-- =============================================================================


-- 0) SANIDADE: tipos, volume e janela. Rode primeiro.
--    Se algo aqui surpreender, pare e me diga antes do resto.
select
  (select data_type from information_schema.columns
    where table_schema='public' and table_name='aluno_movimentacoes' and column_name='aluno_id') as mov_aluno_id_tipo,
  (select data_type from information_schema.columns
    where table_schema='public' and table_name='casos' and column_name='aluno_id') as casos_aluno_id_tipo,
  (select count(*) from public.mv_saude_carteira where encerrado = false)          as casos_ativos_universo,
  (select atualizado_em from public.saude_carteira_mv_meta limit 1)                as matview_atualizada_em,
  current_date                                                                      as hoje;


-- 1) ANTES — como a tela conta HOJE (fonte: casos.data_ultimo_acionamento).
--    Reproduz literalmente saude_carteira_resumo_impl, trocando o limite 5 -> 10.
with universo as (
  select * from public.mv_saude_carteira where encerrado = false
)
select
  'ANTES (data_ultimo_acionamento)'                                        as definicao,
  count(*)                                                                  as casos_ativos,
  count(distinct aluno_id)                                                  as alunos,
  count(*) filter (where nunca_acionado)                                    as nunca_acionados,
  count(*) filter (where nunca_acionado or dias_sem_acionamento >= 10)      as sem_acionamento_10d,
  count(*) filter (where not nunca_acionado and dias_sem_acionamento < 10)  as dentro_da_cobertura_10d,
  round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= 10)
        / greatest(count(*),1), 1)                                          as pct_sem_acionamento_10d
from universo;


-- 2) DEPOIS — definição de cobertura das Ações Massivas, aplicada ao MESMO universo.
--    Acionamento válido = acoes_massivas_tipo_cobertura(tipo), finalização desfeita fora.
--    Inclui ACAO_MASSIVA_EXTERNA e ACAO_MASSIVA_EXTERNA_EMAIL.
with universo as (
  select * from public.mv_saude_carteira where encerrado = false
),
mov as (
  select m.aluno_id::text as aluno_id, max(m.registrado_em) as ult
    from public.aluno_movimentacoes m
   where public.acoes_massivas_tipo_cobertura(m.tipo)
     and not exists (select 1 from public.acoes_desfazer ad
                      where ad.movimentacao_id = m.id and ad.desfeito_em is not null)
   group by 1
),
j as (
  select u.caso_id, u.aluno_id, mv.ult,
         case when mv.ult is null then null
              else greatest(0, current_date - mv.ult::date) end as dias_cob
    from universo u
    left join mov mv on mv.aluno_id = u.aluno_id::text
)
select
  'DEPOIS (movimentações + ação massiva)'                      as definicao,
  count(*)                                                      as casos_ativos,
  count(distinct aluno_id)                                      as alunos,
  count(*) filter (where ult is null)                           as nunca_acionados,
  count(*) filter (where ult is null or dias_cob >= 10)         as sem_acionamento_10d,
  count(*) filter (where ult is not null and dias_cob < 10)     as dentro_da_cobertura_10d,
  round(100.0 * count(*) filter (where ult is null or dias_cob >= 10)
        / greatest(count(*),1), 1)                              as pct_sem_acionamento_10d
from j;


-- 3) O DELTA, caso a caso: quem muda de lado e por quê.
--    É aqui que se vê se a hipótese (ação massiva invisível para a tela) se sustenta.
with universo as (
  select * from public.mv_saude_carteira where encerrado = false
),
mov as (
  select m.aluno_id::text as aluno_id,
         max(m.registrado_em) as ult,
         max(m.registrado_em) filter (
           where m.tipo in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')) as ult_massivo
    from public.aluno_movimentacoes m
   where public.acoes_massivas_tipo_cobertura(m.tipo)
     and not exists (select 1 from public.acoes_desfazer ad
                      where ad.movimentacao_id = m.id and ad.desfeito_em is not null)
   group by 1
),
j as (
  select u.caso_id, u.nunca_acionado, u.dias_sem_acionamento, mv.ult, mv.ult_massivo,
         case when mv.ult is null then null else greatest(0, current_date - mv.ult::date) end as dias_cob
    from universo u
    left join mov mv on mv.aluno_id = u.aluno_id::text
)
select
  case
    when (nunca_acionado or dias_sem_acionamento >= 10)
     and (ult is not null and dias_cob < 10)                       then '1. ENTRA na cobertura (hoje contado como descoberto)'
    when nunca_acionado and ult is not null                        then '2. Deixa de ser "nunca acionado" (tem histórico)'
    when (not nunca_acionado and dias_sem_acionamento < 10)
     and (ult is null or dias_cob >= 10)                           then '3. SAI da cobertura (atenção: regressão)'
    else                                                                '4. Sem mudança'
  end                                                               as efeito,
  count(*)                                                          as casos,
  count(*) filter (where ult_massivo is not null
                     and ult_massivo = ult)                         as casos_em_que_a_massiva_e_o_acionamento_mais_recente
from j
group by 1
order by 1;


-- 4) CONTROLE DE REGRESSÃO — o caso 3 acima NÃO deveria existir.
--    Se existir, há acionamento em `casos.data_ultimo_acionamento` que não tem
--    movimentação correspondente: a definição nova perderia informação, e aí a
--    troca não pode ser simples substituição. Amostra para inspeção manual.
with universo as (
  select * from public.mv_saude_carteira where encerrado = false
),
mov as (
  select m.aluno_id::text as aluno_id, max(m.registrado_em) as ult
    from public.aluno_movimentacoes m
   where public.acoes_massivas_tipo_cobertura(m.tipo)
     and not exists (select 1 from public.acoes_desfazer ad
                      where ad.movimentacao_id = m.id and ad.desfeito_em is not null)
   group by 1
)
select u.caso_id, u.caso_codigo, u.estabelecimento, u.operador_email,
       u.data_ultimo_acionamento, u.tipo_ultimo_acionamento,
       mv.ult as ultimo_acionamento_por_movimentacao
  from universo u
  left join mov mv on mv.aluno_id = u.aluno_id::text
 where u.nunca_acionado = false
   and u.dias_sem_acionamento < 10
   and (mv.ult is null or greatest(0, current_date - mv.ult::date) >= 10)
 order by u.data_ultimo_acionamento desc
 limit 50;


-- 5) RECONCILIAÇÃO COM A TELA DE AÇÕES MASSIVAS.
--    A cobertura calculada acima tem de bater com a fonte oficial daquela tela.
--    Divergência aqui significa que recriei a regra errado — e isso invalida
--    tudo acima. Compara por ALUNO, que é a unidade do universo de massivas.
with mov as (
  select m.aluno_id::text as aluno_id, max(m.registrado_em) as ult
    from public.aluno_movimentacoes m
   where public.acoes_massivas_tipo_cobertura(m.tipo)
     and not exists (select 1 from public.acoes_desfazer ad
                      where ad.movimentacao_id = m.id and ad.desfeito_em is not null)
   group by 1
),
oficial as (
  select u.aluno_id::text as aluno_id, u.ultimo_acionamento
    from public.acoes_massivas_universo('{}'::jsonb) u
)
select
  count(*)                                                                     as alunos_comparados,
  count(*) filter (where o.ultimo_acionamento is distinct from mv.ult)          as divergentes,
  min(o.ultimo_acionamento)                                                     as amostra_oficial,
  min(mv.ult)                                                                   as amostra_recriada
from oficial o
full join mov mv on mv.aluno_id = o.aluno_id;


-- 6) IMPACTO POR ESTABELECIMENTO — para a gestão ver onde a leitura muda mais.
with universo as (
  select * from public.mv_saude_carteira where encerrado = false
),
mov as (
  select m.aluno_id::text as aluno_id, max(m.registrado_em) as ult
    from public.aluno_movimentacoes m
   where public.acoes_massivas_tipo_cobertura(m.tipo)
     and not exists (select 1 from public.acoes_desfazer ad
                      where ad.movimentacao_id = m.id and ad.desfeito_em is not null)
   group by 1
),
j as (
  select u.estabelecimento, u.nunca_acionado, u.dias_sem_acionamento,
         case when mv.ult is null then null else greatest(0, current_date - mv.ult::date) end as dias_cob,
         mv.ult
    from universo u
    left join mov mv on mv.aluno_id = u.aluno_id::text
)
select estabelecimento,
       count(*)                                                                    as casos,
       round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= 10)
             / greatest(count(*),1), 1)                                            as pct_descoberto_antes,
       round(100.0 * count(*) filter (where ult is null or dias_cob >= 10)
             / greatest(count(*),1), 1)                                            as pct_descoberto_depois
  from j
 group by 1
 order by casos desc;
