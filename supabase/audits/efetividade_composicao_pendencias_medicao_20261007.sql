-- MEDIÇÃO DAS TRÊS FUNÇÕES NOVAS — roteiro para rodar em produção, SOMENTE
-- LEITURA, antes de liberar a tela.
--
-- POR QUE ESTE ARQUIVO EXISTE EM VEZ DOS NÚMEROS NO CABEÇALHO DA MIGRATION.
-- As outras migrations desta frente trazem os números medidos escritos no
-- comentário, datados. Esta não traz: a sessão em que ela foi escrita NÃO teve
-- acesso ao banco de produção (`ahattpqrjmhkzsmnbdzs`) — o conector disponível
-- alcançava apenas um projeto inativo, não havia `psql` na máquina e as únicas
-- credenciais locais são chaves `anon`, que as RPCs de carteira recusam por
-- desenho (`carteira_2026_1_pode_ler()`). Inventar número medido seria pior que
-- não medir, então o roteiro fica aqui, pronto, e a medição é um passo com
-- autorização própria — como já se fez com
-- `mensalidade_reconciliar_pago_sem_lastro`.
--
-- O QUE A INVARIANTE NÃO DEPENDE DESTA MEDIÇÃO. O fechamento ao centavo é por
-- CONSTRUÇÃO (cada título entra em uma linha só, e aluno sem situação importada
-- é categoria em vez de descarte) e é CONFERIDO a cada chamada, no bloco
-- `conferencia` que as funções devolvem e a tela exibe. Está provado em
-- PostgreSQL real em supabase/tests/carteira_pendencias_e_composicao.test.js
-- (25 asseverações, PGlite). O que falta medir é DESEMPENHO e os VALORES reais.
--
-- COMO RODAR: sessão de leitura, como `authenticated`, com o mesmo teto da
-- aplicação. Nada aqui escreve.

\timing on

-- ---------------------------------------------------------------------------
-- 0. O TETO REAL DA APLICAÇÃO. 8s é o `statement_timeout` do papel
-- `authenticated` neste projeto; foi ele que derrubou
-- `carteira_academico_perfil` em 2024 e obrigou ao snapshot. Medir como dono do
-- banco (sem teto) não prova nada sobre a tela.
-- ---------------------------------------------------------------------------
set role authenticated;
set local statement_timeout = '8s';

-- ---------------------------------------------------------------------------
-- 1. COMPOSIÇÃO DO SALDO EM ABERTO POR STATUS ACADÊMICO
--    Esperado (validado pela gestão em 07/10/2026):
--      2024    1.976 alunos ·  6.367 títulos · R$ 3.675.095,03
--      2025    2.881 alunos · 10.469 títulos · R$ 6.212.880,60
--      2026/1  2.522 alunos ·  7.810 títulos · R$ 9.931.064,45
--    E, em 2024, `(sem situação importada)` com 806 alunos / 2.502 títulos /
--    R$ 1.964.708,62 = 53,46% do saldo.
-- ---------------------------------------------------------------------------
select r->>'recorte'                        as recorte,
       r->'total'->>'alunos'                as alunos,
       r->'total'->>'titulos'               as titulos,
       r->'total'->>'valor'                 as saldo_em_aberto,
       r->'conferencia'->>'diferenca'       as diferenca,
       r->'conferencia'->>'fecha'           as fecha,
       r->'conferencia'->>'titulos_total'   as titulos_total,
       r->'conferencia'->>'titulos_soma'    as titulos_soma,
       r->'fonte_academica'->>'importacao_atualizada_em' as fonte_academica
  from (values ('2024', null::text), ('2025', null), ('2026', '1')) v(ano, sem),
       lateral (select public.carteira_em_aberto_por_status_academico(v.ano, v.sem) r) x;

-- A quebra de 2024, linha a linha, para conferir contra a planilha da gestão.
select l->>'status' status, l->>'alunos' alunos, l->>'titulos' titulos, l->>'valor' valor
  from jsonb_array_elements(
         public.carteira_em_aberto_por_status_academico('2024', null)->'linhas') l;

-- ---------------------------------------------------------------------------
-- 2. O FECHAMENTO CONTRA AS SEIS LINHAS
--    A composição tem de dar, AO CENTAVO, o mesmo "Em aberto" que
--    `carteira_safra_situacoes` publica em 2024/2025. Em 2026/1 a comparação é
--    contra inadimplência + em validação, pela regra da safra: ali o número da
--    composição é `em_aberto` + a parcela `em_validacao` de `pendente_detalhe`.
-- ---------------------------------------------------------------------------
select v.ano, v.sem,
       (c->'total'->>'valor')::numeric                        as composicao,
       (s->'situacoes'->'em_aberto'->>'valor')::numeric        as seis_linhas_em_aberto,
       (s->'pendente_detalhe'->>'em_validacao')::numeric       as em_validacao,
       (c->'total'->>'valor')::numeric
         - ((s->'situacoes'->'em_aberto'->>'valor')::numeric
            + case when v.ano = '2026'
                   then coalesce((s->'pendente_detalhe'->>'em_validacao')::numeric, 0)
                   else 0 end)                                as diferenca
  from (values ('2024', null::text), ('2025', null), ('2026', '1')) v(ano, sem),
       lateral (select public.carteira_em_aberto_por_status_academico(v.ano, v.sem) c) a,
       lateral (select public.carteira_safra_situacoes(v.ano, v.sem) s) b;

-- ---------------------------------------------------------------------------
-- 3. PENDÊNCIAS POR MOTIVO, e o fechamento contra a linha "Pendente"
-- ---------------------------------------------------------------------------
select v.ano, v.sem,
       (p->'total'->>'valor')::numeric                   as pendente_por_motivo,
       (s->'situacoes'->'pendente'->>'valor')::numeric   as pendente_seis_linhas,
       p->'conferencia'->>'fecha'                        as fecha,
       p->>'contagens_somaveis'                          as contagens_somaveis,
       p->'motivos'                                      as motivos
  from (values ('2024', null::text), ('2025', null), ('2026', '1')) v(ano, sem),
       lateral (select public.carteira_pendencias_por_motivo(v.ano, v.sem) p) a,
       lateral (select public.carteira_safra_situacoes(v.ano, v.sem) s) b;

-- ---------------------------------------------------------------------------
-- 4. O REGISTRO INDIVIDUAL — a primeira página de cada motivo, como a Fila
--    Única pede (50 por página).
-- ---------------------------------------------------------------------------
select motivo, count(*) linhas, sum(valor) soma
  from (
    select * from public.carteira_pendencias_itens('em_confirmacao', '2024', null, 50, 0)
    union all
    select * from public.carteira_pendencias_itens('pago_sem_lastro', '2024', null, 50, 0)
    union all
    select * from public.carteira_pendencias_itens('em_validacao', '2026', '1', 50, 0)
    union all
    select * from public.carteira_pendencias_itens('ajuste_academico', '2026', '1', 50, 0)
    union all
    select * from public.carteira_pendencias_itens('convertido_origem_comprovada', '2026', '1', 50, 0)
  ) t group by motivo order by soma desc;

-- ---------------------------------------------------------------------------
-- 5. O PLANO, para saber de onde vem o custo. 2024 é o recorte caro — foi ele
--    que estourou os 8s em `carteira_academico_perfil`.
-- ---------------------------------------------------------------------------
explain (analyze, buffers, timing)
select public.carteira_em_aberto_por_status_academico('2024', null);

explain (analyze, buffers, timing)
select public.carteira_pendencias_por_motivo('2024', null);

explain (analyze, buffers, timing)
select * from public.carteira_pendencias_itens('em_confirmacao', '2024', null, 50, 0);

reset role;

-- ---------------------------------------------------------------------------
-- CRITÉRIO DE ACEITE
--   • `fecha` = true nos três recortes, nas duas funções;
--   • `titulos_total` = `titulos_soma` na composição;
--   • diferença 0,00 contra as seis linhas no bloco 2 e no bloco 3;
--   • os totais iguais aos validados pela gestão (bloco 1);
--   • cada chamada abaixo de 8s como `authenticated`, com folga — se a
--     composição de 2024 chegar perto do teto, a decisão conservadora é a MESMA
--     que já se tomou no perfil acadêmico: snapshot em tabela, com rotina que
--     recalcula e tela que lê, NÃO reescrita da consulta (PR #620 mediu ~20% de
--     ganho reescrevendo, e a distância até o teto era maior que isso).
-- ---------------------------------------------------------------------------
