-- ROLLBACK de 20261009210000_recalculo_de_saldo_por_titulo.sql
-- 27/10/2026 · NAO EXECUTAR sem autorizacao expressa da Amanda.
--
-- Escrito porque o parecer do Guardiao de 27/10/2026 REPROVOU a migration por
-- ausencia de reversa (§13 da premissa de seguranca). Este arquivo fecha esse
-- apontamento.
--
-- ============================================================================
-- POR QUE ESTA REVERSA E DDL PURA, E NAO BACKUP DE DADO
-- ============================================================================
-- PITR NAO esta habilitado neste projeto: rollback aqui NUNCA e restore, e sim
-- backup + SQL por id (memoria `pitr-nao-habilitado-rollback-nao-e-restore`).
-- A pergunta certa, entao, e: que DADO a migration original cria ou altera?
--
-- NENHUM.
--
--   . `recalculo_saldo_pendente` nasce VAZIA (a prova 4.6 da migration aborta
--     se nao nascer) e so recebe linha em escrita FUTURA de `acordos_titulos`;
--   . os tres gatilhos sao de INSTRUCAO e so escrevem nessa fila;
--   . `recalculo_saldo_pendente_processar` nao e chamada pela migration;
--   . nada em `acordos_titulos`, `acordos`, `parcelas`, `pagamentos`,
--     `baixas_pagamento`, `aluno_movimentacoes`, `solicitacoes_*`, `casos` ou
--     `alunos` e lido para escrita durante a aplicacao.
--
-- Logo a reversa e remover exatamente os objetos criados, por nome. Nao ha
-- de/para a restaurar, e nao ha linha financeira a desfazer.
--
-- ============================================================================
-- O QUE ESTA REVERSA NAO DESFAZ -- leia antes de executar
-- ============================================================================
-- Se o dreno JA tiver sido chamado (pela tela de Borderos ou a mao), ele
-- executou `recalcular_situacao_aluno`, que escreve campo DERIVADO em `casos`
-- e `alunos`: criticidade, situacao_operacional, proxima_acao, saldo_vencido,
-- saldo_total, data_retorno, retorno_origem.
--
-- **Esses valores NAO voltam ao que eram, e nao devem voltar.** Eles passaram a
-- refletir a divida que realmente existe em `acordos_titulos` -- era justamente
-- o defeito dos 485 alunos / R$ 692.047,04. Desfazer o recalculo recriaria o
-- defeito, e `recalcular_situacao_aluno` ja e chamada por sete outros gatilhos
-- em producao: o valor recalculado e o valor correto, venha de onde vier.
--
-- Quem quiser mesmo reverter o efeito de UM aluno usa o caminho de sempre:
-- backup da linha por id, depois SQL por id. Nao e trabalho deste arquivo.
--
-- Esta reversa, portanto, PARA de enfileirar e PARA de drenar. Ela nao
-- "desrecalcula".
--
-- ============================================================================
-- O BACKUP DA FILA E FEITO, NAO RECOMENDADO
-- ============================================================================
-- Uma versao anterior deste arquivo SUGERIA o backup em comentario. O §13 pede
-- backup dos dados afetados FEITO -- e o `drop table` abaixo destroi a fila
-- pendente, que e a lista de alunos cujo saldo esta desatualizado e que
-- deixarao de ser corrigidos. Entao o backup virou a secao 0, obrigatoria, com
-- RLS deny-all (memoria `rls-tabelas-backup-snapshot`).
--
-- Para conferir o que sera guardado, antes de executar:
--   select count(*) as na_fila,
--          count(*) filter (where tentativas >= 3) as desistidos
--     from public.recalculo_saldo_pendente;

begin;

set local lock_timeout = '3s';

-- 0. BACKUP DA FILA, antes de qualquer drop. Guarda por id (aluno_id e PK),
--    com RLS deny-all e sem grant -- PITR nao esta habilitado, entao esta
--    tabela E a unica reversa possivel do conteudo da fila.
do $bkp$
begin
  if exists (select 1 from pg_class where relname = 'recalculo_saldo_pendente') then
    execute 'create table if not exists public._backup_recalculo_fila_rollback as
               select *, now() as salvo_em from public.recalculo_saldo_pendente';
    execute 'alter table public._backup_recalculo_fila_rollback enable row level security';
    execute 'alter table public._backup_recalculo_fila_rollback force row level security';
    execute 'revoke all on public._backup_recalculo_fila_rollback from public, anon, authenticated';
    raise notice 'Fila salva em public._backup_recalculo_fila_rollback (RLS deny-all).';
  end if;
end $bkp$;

-- 1. Para de enfileirar. Primeiro os gatilhos: enquanto eles existirem,
--    `drop table` abaixo falharia por dependencia.
drop trigger if exists trg_enfileirar_recalculo_titulo_ins on public.acordos_titulos;
drop trigger if exists trg_enfileirar_recalculo_titulo_upd on public.acordos_titulos;
drop trigger if exists trg_enfileirar_recalculo_titulo_del on public.acordos_titulos;

-- 2. Para de drenar.
drop function if exists public.recalculo_saldo_pendente_processar(int, text);

-- 3. A funcao do gatilho, depois dos gatilhos que a usam.
drop function if exists public._trg_enfileirar_recalculo_titulo();

-- 4. A fila e seu indice. `drop table` leva o indice junto; o `drop index`
--    fica por explicitude, para o caso de a tabela ter sido preservada a mao.
drop index if exists public.ix_recalculo_saldo_pendente_ordem;
drop table if exists public.recalculo_saldo_pendente;

-- ---------------------------------------------------------------------------
-- 5. PROVA DA REVERSA. Aborta se algo da migration sobreviveu, ou se a reversa
--    custou um objeto que nao era dela.
-- ---------------------------------------------------------------------------
do $prova$
declare v_n int;
begin
  -- 5.1 nada da migration sobrou
  if exists (select 1 from pg_class where relname = 'recalculo_saldo_pendente') then
    raise exception 'PROVA DA REVERSA: a tabela recalculo_saldo_pendente ainda existe';
  end if;
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'public.acordos_titulos'::regclass and not g.tgisinternal
     and g.tgname like 'trg_enfileirar_recalculo_titulo%';
  if v_n <> 0 then
    raise exception 'PROVA DA REVERSA: sobraram % gatilho(s) de enfileiramento', v_n;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('recalculo_saldo_pendente_processar',
                                  '_trg_enfileirar_recalculo_titulo')) then
    raise exception 'PROVA DA REVERSA: sobrou funcao da migration';
  end if;

  -- 5.2 a reversa NAO pode ter levado os gatilhos de protecao da tabela.
  --     Isto e o que separa "reverter" de "estragar".
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'public.acordos_titulos'::regclass and not g.tgisinternal
     and g.tgname in ('trg_titulo_em_confirmacao_protegido',
                      'trg_titulo_encerrado_administrativo_protegido',
                      'trg_titulo_liquidado_na_origem_e_terminal');
  if v_n <> 3 then
    raise exception 'PROVA DA REVERSA: os tres gatilhos de protecao deveriam continuar de pe, achei %', v_n;
  end if;

  -- 5.3 a funcao canonica de recalculo NAO e desta migration e tem de ficar:
  --     sete gatilhos em producao dependem dela.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'recalcular_situacao_aluno') then
    raise exception 'PROVA DA REVERSA: recalcular_situacao_aluno desapareceu -- ela NAO e desta migration';
  end if;

  -- 5.4 o backup da fila existe e esta fechado. Sem ele, a reversa teria
  --     destruido a lista de alunos com saldo desatualizado.
  if not exists (select 1 from pg_class where relname = '_backup_recalculo_fila_rollback') then
    raise exception 'PROVA DA REVERSA: o backup da fila nao foi criado';
  end if;
  if not exists (select 1 from pg_class
                  where relname = '_backup_recalculo_fila_rollback'
                    and relrowsecurity and relforcerowsecurity) then
    raise exception 'PROVA DA REVERSA: o backup da fila esta sem RLS deny-all';
  end if;
end $prova$;

commit;
