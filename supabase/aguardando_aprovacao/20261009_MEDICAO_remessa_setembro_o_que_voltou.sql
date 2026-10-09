-- ============================================================================
-- MEDICAO: O QUE A REMESSA DE SETEMBRO DEVOLVEU PARA A FILA
-- 09/10/2026 · 100% SELECT. Nao escreve nada. Pode rodar em producao.
--
-- Pedido da gestao em 08/10/2026:
--   "tivemos uma nova remessa de inclusao da parcela de setembro e todos os
--    casos que estavam tratados retornaram"
--   "a parcela ja negociada e paga nao volta, quando entra uma nova parcela
--    precisamos trabalhar ela"
--
-- A REGRA, lida ao pe da letra, tem DOIS lados -- e esta medicao existe para
-- separar um do outro, porque a reversao so pode tocar o primeiro:
--
--   ERRADO, reverter : titulo que JA EXISTIA foi reaberto pela remessa
--                      (NEGOCIADO/QUITADO/VENCIDA -> ABERTO), e o aluno voltou
--                      para a fila por causa disso.
--   CERTO, manter    : titulo REALMENTE NOVO entrou, e o caso foi para a fila
--                      para ser trabalhado. E o que a gestao pediu.
--
-- POR QUE O IMPORTADOR FEZ ISSO (codigo em producao, origin/main e5eb166b):
-- `Borderos.jsx` grava titulo com `upsert(..., onConflict: 'documento')` e
-- `situacao: 'ABERTO'` FIXO. A trava do navegador cobre so tres situacoes
-- (`src/utils/bordero.js`: PAGO, EM_CONFIRMACAO, CANCELADA) -- NEGOCIADO,
-- QUITADO, QUITADA, DEVOLVIDO e VENCIDA ficam de fora. O upsert NAO grava
-- `status`, so `situacao`: por isso o titulo fica `vinculada` + `ABERTO`, e
-- `trg_titulo_normaliza_vinculo_incoerente` zera o status para `em_aberto`,
-- COMPLETANDO o apagamento da negociacao.
-- Diagnostico completo: docs/SIMULACAO-REIMPORTACAO-PARCELAS-AUSENTES-2026-10-08.md
--
-- COMO USAR
--   1. Rode o BLOCO 0 e anote o `importacao_id` da remessa de setembro.
--   2. Troque `:LOTE` por esse id (ou pelos ids, se foram varios arquivos).
--   3. Rode os blocos A a G e me mande a saida.
--
-- Sem os numeros do BLOCO A e do BLOCO C2 a reversao NAO deve ser executada:
-- sao eles que dizem quantas linhas ela tem direito de tocar, e a funcao de
-- reversao recusa divergencia.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- BLOCO 0. PRE-VOO: a remessa existe, e as colunas que esta medicao usa tambem
--
-- O schema inicial nao e versionado (so as migrations sao), entao tres colunas
-- so aparecem em migration e nunca num CREATE TABLE deste repositorio. Se
-- alguma faltar, o resto do arquivo falharia com erro obscuro -- aqui ele
-- falha nomeando a coluna.
-- ---------------------------------------------------------------------------
select 'colunas esperadas' as checagem,
       to_jsonb(j) as presentes
  from (
    select
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='acordos_titulos'
          and column_name='created_at')          as acordos_titulos_created_at,
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='acordos_titulos'
          and column_name='importacao_id')       as acordos_titulos_importacao_id,
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='audit_log'
          and column_name='dados_antes')         as audit_log_dados_antes,
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='alunos'
          and column_name='status_acionamento')  as alunos_status_acionamento,
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='casos'
          and column_name='cancelado_em')        as casos_cancelado_em
  ) j;

-- Existe gatilho de auditoria de UPDATE em acordos_titulos? A reversao do
-- BLOCO A depende dele: `dados_antes` e a UNICA fonte da situacao anterior.
-- Se vier 0, a reversao por audit_log nao e possivel e o caminho passa a ser a
-- derivacao pelo vinculo (BLOCO B, coluna `situacao_derivada`).
select 'gatilhos em acordos_titulos' as checagem,
       t.tgname, p.proname
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc  p on p.oid = t.tgfoid
 where c.relname = 'acordos_titulos'
   and not t.tgisinternal
 order by t.tgname;

-- As importacoes recentes. A de setembro e a que tem muita linha e data de
-- 08/10/2026 (ou a data em que o arquivo foi subido).
select i.id as importacao_id,
       i.criado_em,
       count(t.id)                                          as titulos_com_este_lote,
       min(t.vencimento)                                    as venc_min,
       max(t.vencimento)                                    as venc_max,
       count(*) filter (where t.created_at >= i.criado_em)   as nasceram_neste_lote,
       count(*) filter (where t.created_at <  i.criado_em)   as ja_existiam_e_foram_tocados,
       round(sum(coalesce(t.valor_original,0)), 2)          as valor_original_total
  from public.importacoes i
  left join public.acordos_titulos t on t.importacao_id = i.id
 where i.criado_em >= now() - interval '15 days'
 group by i.id, i.criado_em
 order by i.criado_em desc;

-- ===========================================================================
-- A PARTIR DAQUI: troque :LOTE pelo(s) importacao_id do BLOCO 0.
-- Exemplo:  where t.importacao_id = '...uuid...'::uuid
--           where t.importacao_id = any(array['...','...']::uuid[])
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- BLOCO A. O DANO: titulo que JA EXISTIA e a remessa reabriu
--
-- `created_at < criado_em do lote` e a prova de que o titulo nao nasceu aqui.
-- A situacao anterior vem do audit_log -- nao da para derivar de `status`,
-- porque `trg_titulo_normaliza_vinculo_incoerente` ja pode ter zerado ele.
-- ---------------------------------------------------------------------------
with lote as (
  select i.id, i.criado_em
    from public.importacoes i
   where i.id = :LOTE
),
tocados as (
  select t.*
    from public.acordos_titulos t
    join lote l on t.importacao_id = l.id
   where t.created_at < l.criado_em        -- existia ANTES da remessa
),
antes as (
  -- a ultima foto anterior a remessa, por titulo
  select distinct on (a.registro_id)
         a.registro_id,
         a.dados_antes ->> 'situacao'       as situacao_antes,
         a.dados_antes ->> 'status'         as status_antes,
         (a.dados_antes ->> 'saldo_corrigido')::numeric as saldo_antes,
         a.dados_antes ->> 'importacao_id'  as importacao_id_antes,
         a.criado_em
    from public.audit_log a
    join lote l on true
   where a.tabela = 'acordos_titulos'
     and a.operacao = 'UPDATE'
     and a.criado_em >= l.criado_em - interval '5 minutes'
     and a.registro_id in (select id::text from tocados)
   order by a.registro_id, a.criado_em asc   -- a PRIMEIRA update do lote
)
select coalesce(an.situacao_antes, '(sem audit_log)') as situacao_antes,
       coalesce(an.status_antes,   '(sem audit_log)') as status_antes,
       t.situacao                                     as situacao_agora,
       t.status                                       as status_agora,
       count(*)                                       as titulos,
       count(distinct t.aluno_id)                     as alunos,
       round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 2) as saldo_agora,
       round(sum(coalesce(an.saldo_antes, 0)), 2)     as saldo_antes,
       count(*) filter (where exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos ac on ac.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA')
       ))                                             as com_acordo_vivo
  from tocados t
  left join antes an on an.registro_id = t.id::text
 group by 1,2,3,4
 order by titulos desc;

-- ---------------------------------------------------------------------------
-- BLOCO B. A lista titulo a titulo do BLOCO A, com a situacao DERIVADA do
--          vinculo -- o plano B se o audit_log nao cobrir UPDATE.
--
-- `situacao_derivada` e a mesma regra que `titulos_por_status_acordo` usa:
-- titulo com vinculo ativo em acordo nao cancelado e NEGOCIADO/vinculada.
-- ---------------------------------------------------------------------------
with lote as (select i.id, i.criado_em from public.importacoes i where i.id = :LOTE),
tocados as (
  select t.* from public.acordos_titulos t join lote l on t.importacao_id = l.id
   where t.created_at < l.criado_em
)
select t.id            as titulo_id,
       t.documento,
       t.cpf,
       al.nome         as aluno,
       t.vencimento,
       t.situacao      as situacao_agora,
       t.status        as status_agora,
       round(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2) as saldo_agora,
       v.acordo_id,
       ac.status       as status_do_acordo,
       case
         when v.titulo_id is not null
          and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA')
           then 'NEGOCIADO'
         else '(indeterminado -- precisa do audit_log)'
       end             as situacao_derivada,
       t.created_at    as titulo_nasceu_em,
       t.atualizado_em
  from tocados t
  left join public.alunos al on al.id = t.aluno_id
  left join public.acordo_titulo_vinculo v
         on v.titulo_id = t.id and coalesce(v.ativo, true)
  left join public.acordos ac on ac.id = v.acordo_id
 order by al.nome, t.vencimento;

-- ---------------------------------------------------------------------------
-- BLOCO C. OS CASOS QUE VOLTARAM PARA A FILA, separados em dois
--
-- `Borderos.jsx` (producao) faz, para TODO aluno com titulo no lote e
-- `status_jornada in (QUITADO, QUITADO_MANUAL)`:
--     status_jornada = status_atual = status_acionamento = proxima_acao
--       := 'CONTATAR'
-- Nao grava movimentacao: a prova de que o aluno estava quitado tem de vir do
-- audit_log de `alunos`, ou dos campos de quitacao do caso.
--
--   C1 = tinha titulo REALMENTE NOVO no lote  -> CORRETO, nao reverter
--   C2 = so tinha titulo pre-existente        -> voltou por engano, reverter
-- ---------------------------------------------------------------------------
with lote as (select i.id, i.criado_em from public.importacoes i where i.id = :LOTE),
por_aluno as (
  select t.aluno_id,
         count(*) filter (where t.created_at >= l.criado_em) as titulos_novos,
         count(*) filter (where t.created_at <  l.criado_em) as titulos_reabertos
    from public.acordos_titulos t
    join lote l on t.importacao_id = l.id
   where t.aluno_id is not null
   group by t.aluno_id
),
quitado_antes as (
  -- o aluno estava QUITADO/QUITADO_MANUAL imediatamente antes da remessa?
  select distinct on (a.registro_id)
         a.registro_id::uuid as aluno_id,
         a.dados_antes ->> 'status_jornada'     as status_jornada_antes,
         a.dados_antes ->> 'status_atual'       as status_atual_antes,
         a.dados_antes ->> 'status_acionamento' as status_acionamento_antes,
         a.dados_antes ->> 'proxima_acao'       as proxima_acao_antes
    from public.audit_log a
    join lote l on true
   where a.tabela = 'alunos'
     and a.operacao = 'UPDATE'
     and a.criado_em >= l.criado_em - interval '5 minutes'
     and upper(coalesce(a.dados_antes ->> 'status_jornada','')) in ('QUITADO','QUITADO_MANUAL')
     and upper(coalesce(a.dados_depois ->> 'status_jornada','')) = 'CONTATAR'
   order by a.registro_id, a.criado_em asc
)
select case when p.titulos_novos > 0 then 'C1 -- tinha parcela NOVA: correto, manter na fila'
            else                          'C2 -- so reabriu parcela antiga: reverter' end as grupo,
       count(*)                                  as alunos,
       sum(p.titulos_novos)                      as titulos_novos,
       sum(p.titulos_reabertos)                  as titulos_reabertos,
       round(sum(coalesce(
         (select sum(coalesce(t2.saldo_corrigido, t2.valor_em_aberto, t2.valor_original, 0))
            from public.acordos_titulos t2
            join lote l2 on t2.importacao_id = l2.id
           where t2.aluno_id = p.aluno_id), 0)), 2) as saldo_do_lote
  from por_aluno p
  join quitado_antes q on q.aluno_id = p.aluno_id
 group by 1
 order by 1;

-- A lista nominal do C2 -- e ela que a reversao devolve para QUITADO.
with lote as (select i.id, i.criado_em from public.importacoes i where i.id = :LOTE),
por_aluno as (
  select t.aluno_id,
         count(*) filter (where t.created_at >= l.criado_em) as titulos_novos,
         count(*) filter (where t.created_at <  l.criado_em) as titulos_reabertos
    from public.acordos_titulos t join lote l on t.importacao_id = l.id
   where t.aluno_id is not null group by t.aluno_id
),
quitado_antes as (
  select distinct on (a.registro_id)
         a.registro_id::uuid as aluno_id,
         a.dados_antes ->> 'status_jornada'     as status_jornada_antes,
         a.dados_antes ->> 'status_atual'       as status_atual_antes,
         a.dados_antes ->> 'status_acionamento' as status_acionamento_antes,
         a.dados_antes ->> 'proxima_acao'       as proxima_acao_antes
    from public.audit_log a join lote l on true
   where a.tabela='alunos' and a.operacao='UPDATE'
     and a.criado_em >= l.criado_em - interval '5 minutes'
     and upper(coalesce(a.dados_antes ->> 'status_jornada','')) in ('QUITADO','QUITADO_MANUAL')
     and upper(coalesce(a.dados_depois ->> 'status_jornada','')) = 'CONTATAR'
   order by a.registro_id, a.criado_em asc
)
select al.id as aluno_id, al.nome, al.cpf,
       q.status_jornada_antes, q.status_atual_antes,
       q.status_acionamento_antes, q.proxima_acao_antes,
       al.status_jornada as status_jornada_agora,
       al.status_atual   as status_atual_agora,
       p.titulos_reabertos
  from por_aluno p
  join quitado_antes q on q.aluno_id = p.aluno_id
  join public.alunos al on al.id = p.aluno_id
 where p.titulos_novos = 0
 order by al.nome;

-- ---------------------------------------------------------------------------
-- BLOCO D. QUITACAO MANUAL DESFEITA
--
-- Em producao os blocos 2 e 3 do `Borderos.jsx` estao LIGADOS (o interruptor
-- `RESTAURAR_QUITACAO_NO_BORDERO = false` so existe na correcao que ainda nao
-- subiu). Entao a remessa tambem:
--   2) devolveu a ABERTO titulo `quitada` com motivo "quitado manualmente",
--      com saldo_corrigido := valor_original;
--   3) devolveu parcela PAGO sem `pago_em` para A_VENCER e REATIVOU o acordo
--      QUITADO que sobrou com saldo.
--
-- A JANELA DO AUDIT_LOG NAO E FILTRO SUFICIENTE. Nos mesmos cinco minutos
-- escrevem o cron de :35, o motor de baixa e a Conferencia Prime. Cada
-- populacao abaixo e amarrada ao LOTE -- titulo pelo `importacao_id`, parcela e
-- acordo pelo aluno que tem titulo do lote. Sem isso a medicao conta (e a
-- reversao desfaria) trabalho legitimo de outra origem.
-- ---------------------------------------------------------------------------
with lote as (select i.id, i.criado_em from public.importacoes i where i.id = :LOTE)
select 'titulo de quitacao manual reaberto' as o_que,
       count(*) as titulos, count(distinct t.aluno_id) as alunos,
       round(sum(coalesce(t.saldo_corrigido,0)), 2) as saldo_restaurado
  from public.audit_log a
  join lote l on true
  join public.acordos_titulos t on t.id::text = a.registro_id
 where a.tabela='acordos_titulos' and a.operacao='UPDATE'
   and a.criado_em >= l.criado_em - interval '5 minutes'
   and t.importacao_id = l.id
   and lower(coalesce(a.dados_antes ->> 'status','')) = 'quitada'
   and coalesce(a.dados_antes ->> 'motivo_ajuste','') ilike '%quitado manualmente%';

with lote as (select i.id, i.criado_em from public.importacoes i where i.id = :LOTE),
alunos_do_lote as (
  select distinct t.aluno_id from public.acordos_titulos t
   join lote l on t.importacao_id = l.id where t.aluno_id is not null
)
select 'parcela PAGO -> A_VENCER' as o_que,
       count(*) as parcelas, count(distinct p.acordo_id) as acordos
  from public.audit_log a
  join lote l on true
  join public.parcelas p  on p.id::text = a.registro_id
  join public.acordos  ac on ac.id = p.acordo_id
  join alunos_do_lote dl  on dl.aluno_id = ac.aluno_id
 where a.tabela='parcelas' and a.operacao='UPDATE'
   and a.criado_em >= l.criado_em - interval '5 minutes'
   and upper(coalesce(a.dados_antes ->> 'status','')) = 'PAGO'
   and upper(coalesce(a.dados_depois ->> 'status','')) = 'A_VENCER';

with lote as (select i.id, i.criado_em from public.importacoes i where i.id = :LOTE),
alunos_do_lote as (
  select distinct t.aluno_id from public.acordos_titulos t
   join lote l on t.importacao_id = l.id where t.aluno_id is not null
)
select 'acordo QUITADO reativado' as o_que,
       count(*) as acordos, count(distinct ac.aluno_id) as alunos
  from public.audit_log a
  join lote l on true
  join public.acordos ac on ac.id::text = a.registro_id
  join alunos_do_lote dl on dl.aluno_id = ac.aluno_id
 where a.tabela='acordos' and a.operacao='UPDATE'
   and a.criado_em >= l.criado_em - interval '5 minutes'
   and upper(coalesce(a.dados_antes ->> 'status','')) = 'QUITADO'
   and upper(coalesce(a.dados_depois ->> 'status','')) <> 'QUITADO';

-- ---------------------------------------------------------------------------
-- BLOCO E. CASOS REABERTOS PELOS GATILHOS E PELO CRON
--
-- Independente do importador, duas coisas reabrem por SALDO:
--   `casos_reabrir_com_divida`  -- cron horario, minuto 35
--   `_reabrir_aluno_com_divida_nova` / `_reabrir_encerramento_com_mensalidade_nova`
-- Essas DEIXAM rastro em aluno_movimentacoes, e por isso sao faceis de medir.
-- ---------------------------------------------------------------------------
select m.tipo,
       date_trunc('hour', m.registrado_em) as hora,
       count(*)                            as casos,
       count(distinct m.aluno_id)          as alunos
  from public.aluno_movimentacoes m
 where m.tipo in ('REABERTURA_DIVIDA_NOVA','REABERTURA_MENSALIDADE_NOVA','CASO_CRIADO_DIVIDA')
   and m.registrado_em >= now() - interval '3 days'
 group by 1,2
 order by 2 desc, 1;

-- ---------------------------------------------------------------------------
-- BLOCO F. PROVENIENCIA SOBRESCRITA -- o que a reversao NAO consegue desfazer
--
-- O upsert grava `importacao_id` do lote corrente. Para titulo que ja existia,
-- isso APAGA a origem verdadeira, e `ORIGEM_MENSURAVEL` (docs/REGRA-SALDO-COBRAVEL.md §5)
-- depende dela. So da para restaurar o que o audit_log guardou.
-- ---------------------------------------------------------------------------
with lote as (select i.id, i.criado_em from public.importacoes i where i.id = :LOTE),
tocados as (
  select t.* from public.acordos_titulos t join lote l on t.importacao_id = l.id
   where t.created_at < l.criado_em
)
select count(*) as titulos_com_origem_sobrescrita,
       count(*) filter (where an.importacao_id_antes is not null) as recuperaveis_pelo_audit_log,
       count(*) filter (where an.importacao_id_antes is null)     as origem_perdida
  from tocados t
  left join (
    select distinct on (a.registro_id) a.registro_id,
           a.dados_antes ->> 'importacao_id' as importacao_id_antes
      from public.audit_log a join lote l on true
     where a.tabela='acordos_titulos' and a.operacao='UPDATE'
       and a.criado_em >= l.criado_em - interval '5 minutes'
     order by a.registro_id, a.criado_em asc
  ) an on an.registro_id = t.id::text;

-- ---------------------------------------------------------------------------
-- BLOCO G. FOTO GLOBAL -- rodar ANTES e DEPOIS da reversao
--
-- Prova que a reversao nao tocou nada fora do lote.
-- ---------------------------------------------------------------------------
select 'foto' as o_que,
       (select count(*) from public.acordos_titulos)                        as titulos,
       (select count(*) from public.acordos_titulos where situacao='ABERTO') as titulos_abertos,
       (select count(*) from public.acordos_titulos where situacao='NEGOCIADO') as titulos_negociados,
       (select count(*) from public.acordos where upper(coalesce(status,''))='ATIVO')   as acordos_ativos,
       (select count(*) from public.acordos where upper(coalesce(status,''))='QUITADO') as acordos_quitados,
       (select count(*) from public.parcelas where upper(coalesce(status,''))='PAGO')   as parcelas_pagas,
       (select count(*) from public.alunos where upper(coalesce(status_jornada,'')) in ('QUITADO','QUITADO_MANUAL')) as alunos_quitados,
       (select count(*) from public.alunos where upper(coalesce(status_jornada,''))='CONTATAR') as alunos_contatar,
       (select count(*) from public.pagamentos)      as pagamentos,
       (select count(*) from public.baixas_pagamento) as baixas;
