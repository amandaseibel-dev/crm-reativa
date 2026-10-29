-- ============================================================================
-- Remove o residuo de teste `public._teste_portal_meta`.
-- ============================================================================
-- ORIGEM. Criada em 11/09/2026 pela versao `20260911114545
-- teste_portal_meta_do_mes`, que existe SO em producao (nunca teve arquivo no
-- repositorio). O SQL dela era, literalmente, um smoke test materializado:
--
--   DROP TABLE IF EXISTS public._teste_portal_meta;
--   CREATE TABLE public._teste_portal_meta AS
--   SELECT public.portal_meta_do_mes() AS setembro,
--          public.portal_meta_do_mes('2026-07') AS julho,
--          public.portal_meta_do_mes('2099-01') AS mes_sem_meta;
--
-- Ou seja: tres chamadas da funcao congeladas numa tabela para conferir o
-- retorno. Nunca foi estrutura de produto.
--
-- RECONFERIDO EM 30/09/2026, tudo zero:
--   pg_depend externo  (nenhuma)     funcoes que a citam   (nenhuma)
--   views/matviews     (nenhuma)     triggers              (nenhum)
--   cron               (nenhum)      FKs apontando         (nenhuma)
--   referencias no repositorio (grep em js/jsx/sql/ts/mjs/md): (nenhuma)
--   pg_stat: ins=0 upd=0 del=0, 3 seq_scan, autovacuum nunca
--
-- `portal_meta_do_mes(text)` CONTINUA SENDO A FONTE OFICIAL e nao e tocada aqui:
-- segue existindo, assinatura `p_mes text DEFAULT NULL::text`, com EXECUTE para
-- authenticated. Quem quiser os mesmos numeros chama a funcao. Por isso a tabela
-- nao expoe nada que a funcao ja nao exponha -- e so copia velha, de 11/09.
--
-- BACKUP LOGICO PARA AUDITORIA. A tabela tinha 1 linha e 3 colunas jsonb.
-- Estrutura: setembro jsonb, julho jsonb, mes_sem_meta jsonb (sem PK, sem
-- indice, sem constraint, RLS desligada, owner postgres).
-- Conteudo integral, preservado aqui porque a tabela deixa de existir:
--
-- setembro:
-- {"mes": "2026-09", "faixas": [{"n": 1, "de": 0, "ate": 15000.00, "percentual": 4},
--  {"n": 2, "de": 15000.01, "ate": 21600.00, "percentual": 8},
--  {"n": 3, "de": 21600.01, "ate": 27000.00, "percentual": 9},
--  {"n": 4, "de": 27000.01, "ate": null, "percentual": 9.5}],
--  "atualizado_em": "2026-09-03T16:54:27.35796+00:00", "meta_operacional": 120000}
--
-- julho:
-- {"mes": "2026-07", "faixas": [{"n": 1, "de": 0, "ate": 38000.00, "percentual": 4},
--  {"n": 2, "de": 38000.01, "ate": 45000.00, "percentual": 8},
--  {"n": 3, "de": 45000.01, "ate": 60000.00, "percentual": 9},
--  {"n": 4, "de": 60000.01, "ate": null, "percentual": 9.5}],
--  "atualizado_em": "2026-07-29T12:57:59.056953+00:00", "meta_operacional": 340000.01}
--
-- mes_sem_meta:
-- {"mes": "2099-01", "sem_meta": true}
--
-- Os valores acima sao configuracao de faixa/meta de 11/09 -- NAO sao a
-- configuracao vigente. A vigente vem de `portal_meta_do_mes(text)`, sempre.
--
-- ESCOPO: uma tabela, so esta. Nenhuma funcao, nenhuma outra tabela, nenhum
-- dado de produto.
-- ============================================================================

-- Guarda: so derruba se continuar sendo o residuo que foi medido.
do $do$
declare v_linhas int; v_cols int; v_deps int;
begin
  if to_regclass('public._teste_portal_meta') is null then
    raise notice 'JA REMOVIDA: nada a fazer';
    return;
  end if;

  select count(*) into v_linhas from public._teste_portal_meta;
  if v_linhas <> 1 then
    raise exception 'ABORTA: a tabela tem % linhas, o residuo medido tinha 1. Reanalisar.', v_linhas;
  end if;

  select count(*) into v_cols from information_schema.columns
   where table_schema='public' and table_name='_teste_portal_meta';
  if v_cols <> 3 then
    raise exception 'ABORTA: a tabela tem % colunas, o residuo medido tinha 3. Reanalisar.', v_cols;
  end if;

  select count(*) into v_deps from pg_constraint
   where confrelid = 'public._teste_portal_meta'::regclass;
  if v_deps > 0 then
    raise exception 'ABORTA: % chave(s) estrangeira(s) apontam para a tabela', v_deps;
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and pg_get_functiondef(p.oid) like '%_teste_portal_meta%') then
    raise exception 'ABORTA: alguma funcao passou a citar a tabela';
  end if;

  -- a fonte oficial tem de estar de pe. Assinatura real: p_mes text DEFAULT NULL.
  if to_regprocedure('public.portal_meta_do_mes(text)') is null then
    raise exception 'ABORTA: portal_meta_do_mes(text) nao existe -- a fonte oficial tem de estar de pe';
  end if;
end
$do$;

drop table if exists public._teste_portal_meta;

do $do$
begin
  if to_regclass('public._teste_portal_meta') is not null then
    raise exception 'ABORTA: a tabela continua existindo depois do DROP';
  end if;
  if to_regprocedure('public.portal_meta_do_mes(text)') is null then
    raise exception 'ABORTA: portal_meta_do_mes(text) desapareceu -- nao era o alvo';
  end if;
  raise notice 'OK: _teste_portal_meta removida; portal_meta_do_mes(text) intacta';
end
$do$;