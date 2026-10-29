-- ============================================================================
-- mensalidade_reconciliacao_log: privilegios iguais aos do audit_log.
-- ============================================================================
-- A tabela nasceu em 20260930153112 com o DEFAULT do schema public do Supabase
-- (`ALTER DEFAULT PRIVILEGES` concede tudo a authenticated), entao ficou com
-- `authenticated=arwdDxtm` -- incluindo **D = TRUNCATE**.
--
-- POR QUE ISSO IMPORTA: TRUNCATE **nao e comando de RLS**. `pg_policy.polcmd`
-- so aceita r/a/w/d/* (select/insert/update/delete/all); nao existe politica de
-- TRUNCATE. A RLS ligada barra INSERT/UPDATE/DELETE por ausencia de politica,
-- mas NAO barra TRUNCATE. Um operador logado poderia apagar a trilha inteira.
--
-- MEDIDO em 30/09/2026 -- esta tabela era a UNICA excecao do projeto:
--   audit_log                     authenticated=rm       TRUNCATE nao
--   sugestoes                     authenticated=arwd     TRUNCATE nao
--   baixas_pagamento              authenticated=arwd     TRUNCATE nao
--   mensalidade_reconciliacao_log authenticated=arwdDxtm TRUNCATE SIM  <--
--
-- NADA DEPENDE DESSES GRANTS. O unico escritor e
-- `mensalidade_reconciliar_negociado_quitado`, que e SECURITY DEFINER com owner
-- `postgres` (= owner da tabela): ela escreve com os privilegios do owner, nao
-- com os de authenticated. Zero gatilhos, zero crons, zero views e zero
-- referencias no frontend tocam esta tabela.
--
-- O QUE FICA DE PE
--   * SELECT para authenticated -- a politica `mrl_leitura_gestao`
--     (usando usuario_e_gestao()) precisa dele para a gestao ler.
--   * A politica de leitura, intocada.
--   * service_role com privilegio cheio, igual ao audit_log.
--   * Os 64 registros do log: nenhum dado e alterado.
--   * A RPC: nao e recriada nem alterada aqui.
--
-- Alvo: `authenticated=rm/postgres`, identico ao audit_log (r = SELECT,
-- m = MAINTAIN). Sao revogados a, w, d, D, x, t.
-- ============================================================================

revoke insert, update, delete, truncate, references, trigger
  on public.mensalidade_reconciliacao_log
  from authenticated;

-- Guarda: falha a migration se o resultado nao for exatamente o pretendido.
do $do$
declare v_acl text; v_pol int;
begin
  select array_to_string(c.relacl,' | ') into v_acl
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='mensalidade_reconciliacao_log';

  if position('authenticated=rm/postgres' in v_acl) = 0 then
    raise exception 'ABORTA: authenticated nao ficou em rm. ACL=%', v_acl;
  end if;

  if has_table_privilege('authenticated','public.mensalidade_reconciliacao_log','TRUNCATE') then
    raise exception 'ABORTA: authenticated ainda tem TRUNCATE';
  end if;
  if not has_table_privilege('authenticated','public.mensalidade_reconciliacao_log','SELECT') then
    raise exception 'ABORTA: authenticated perdeu SELECT -- a gestao deixaria de ler';
  end if;
  if not has_table_privilege('postgres','public.mensalidade_reconciliacao_log','INSERT') then
    raise exception 'ABORTA: o owner perdeu INSERT -- a RPC deixaria de escrever';
  end if;

  select count(*) into v_pol from pg_policy p join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='mensalidade_reconciliacao_log'
     and p.polname='mrl_leitura_gestao';
  if v_pol <> 1 then
    raise exception 'ABORTA: a politica mrl_leitura_gestao nao esta mais la';
  end if;

  raise notice 'OK: authenticated=rm (igual ao audit_log), politica e SELECT preservados';
end
$do$;