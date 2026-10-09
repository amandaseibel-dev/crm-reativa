-- ============================================================================
-- ROLLBACK de 20261008120000_protecao_importacao_nao_reativa
-- 08/10/2026.
--
-- Reversao determinística e completa: os quatro objetos criados pela migration
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
-- MENSALIDADES_AUSENTES_INSERIDAS FICAM: sao evidencia, nao estado.
-- ============================================================================

begin;

drop trigger if exists trg_titulo_importacao_nao_reativa on public.acordos_titulos;
drop function if exists public._titulo_importacao_nao_reativa();
drop function if exists public.mensalidades_ausentes_inserir(jsonb, text, boolean);
drop index  if exists public.ux_acordos_titulos_documento_norm;

do $prova$
begin
  if exists (select 1 from pg_trigger
              where tgrelid = 'public.acordos_titulos'::regclass
                and tgname = 'trg_titulo_importacao_nao_reativa') then
    raise exception 'ROLLBACK INCOMPLETO: gatilho ainda existe';
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
