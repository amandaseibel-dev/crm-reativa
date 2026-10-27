-- ============================================================================
-- ROLLBACK de 20261027120000_protecao_importacao_nao_reativa
-- Artefato de 08/10/2026, renumerado e revisado em 27/10/2026.
--
-- Reversao determinística e completa: os cinco objetos criados pela migration
-- sao NOVOS (nenhum `create or replace` sobre funcao preexistente), entao
-- remove-los devolve o banco ao estado anterior exato. Nenhuma linha de
-- `acordos_titulos`, `parcelas`, `acordos`, `casos` ou `alunos` e lida ou
-- escrita aqui.
--
-- PITR NAO esta habilitado neste projeto (memoria
-- `pitr-nao-habilitado-rollback-nao-e-restore`), por isso o rollback e por
-- objeto nomeado, nunca por restore.
--
-- CONSEQUENCIA DE EXECUTAR: a importacao volta a poder reativar titulo
-- NEGOCIADO (e a sobrescrever valor, vencimento, dono e `importacao_id` de
-- titulo existente), porque nenhum dos tres gatilhos preexistentes cobre
-- NEGOCIADO. Executar so se a trava provar efeito colateral em producao.
--
-- As linhas de `auditoria` com acao TITULO_IMPORTACAO_REATIVACAO_RECUSADA e
-- TITULO_DUPLICADO_NORMALIZADO_RECUSADO FICAM: sao evidencia, nao estado.
-- (MENSALIDADES_AUSENTES_INSERIDAS nao e mais desta migration -- saiu com a RPC
-- para 20261027120001.)
-- ============================================================================

begin;

-- ACCESS EXCLUSIVE na mesma tabela quente que a migration: teto de lock para
-- a reversa falhar rapido em vez de bloquear todo leitor de acordos_titulos.
set local lock_timeout = '3s';

drop trigger if exists trg_titulo_importacao_nao_reativa on public.acordos_titulos;
drop function if exists public._titulo_importacao_nao_reativa();
drop trigger if exists trg_titulo_recusa_duplicata_normalizada on public.acordos_titulos;
drop function if exists public._titulo_recusa_duplicata_normalizada();
drop index  if exists public.ux_acordos_titulos_documento_norm;

do $prova$
begin
  -- Toda funcao e todo gatilho que este arquivo dropa tem assercao propria.
  -- O padrao e "sem a assercao ninguem provava que saiu", e ele vale para os
  -- cinco objetos, nao para alguns.
  if exists (select 1 from pg_trigger
              where tgname = 'trg_titulo_importacao_nao_reativa'
                and not tgisinternal) then
    raise exception 'PROVA DA REVERSA: sobrou a trava trg_titulo_importacao_nao_reativa';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname = '_titulo_importacao_nao_reativa') then
    raise exception 'PROVA DA REVERSA: sobrou a funcao _titulo_importacao_nao_reativa';
  end if;
  if exists (select 1 from pg_trigger
              where tgname = 'trg_titulo_recusa_duplicata_normalizada'
                and not tgisinternal) then
    raise exception 'PROVA DA REVERSA: sobrou a guarda trg_titulo_recusa_duplicata_normalizada';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname = '_titulo_recusa_duplicata_normalizada') then
    raise exception 'PROVA DA REVERSA: sobrou a funcao _titulo_recusa_duplicata_normalizada';
  end if;
  if exists (select 1 from pg_class where relname = 'ux_acordos_titulos_documento_norm') then
    raise exception 'ROLLBACK INCOMPLETO: indice ainda existe';
  end if;
  -- os tres gatilhos preexistentes NAO podem ter sido levados junto
  if (select count(*) from pg_trigger g
       where g.tgrelid = 'public.acordos_titulos'::regclass and not g.tgisinternal
         and g.tgname in ('trg_titulo_em_confirmacao_protegido',
                          'trg_titulo_encerrado_administrativo_protegido',
                          'trg_titulo_liquidado_na_origem_e_terminal')) <> 3 then
    raise exception 'ROLLBACK ERRADO: levou um gatilho preexistente';
  end if;
end $prova$;

commit;
