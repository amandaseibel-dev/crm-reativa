-- ROLLBACK de 20261108130000_acordos_pos_importacao_sem_truncate
--
-- Remove do corpo de `public.acordos_pos_importacao` exatamente as três linhas
-- que a migration acrescentou (dois comentários e o `execute format` do
-- revoke), devolvendo a função ao texto anterior.
--
-- BASE DO ROLLBACK: a mesma âncora, pelo avesso. A migration inseriu o bloco
-- imediatamente depois da linha que liga a RLS; o rollback procura
-- `âncora + bloco` e troca por `âncora`. Se o resultado não voltar a conter a
-- âncora sozinha, ou se sobrar qualquer `revoke truncate` no corpo, a
-- transação aborta.
--
-- NÃO é restauração a partir de cópia guardada: é remoção determinística do
-- que foi inserido. Como a inserção é literal e única, a remoção devolve o
-- texto original byte a byte.
--
-- ATENÇÃO -- o que o rollback REABRE: desfeito isto, a próxima execução de
-- `acordos_pos_importacao` volta a criar tabela de backup com TRUNCATE para
-- `authenticated`, porque o default privilege do schema `public` não foi
-- alterado por nenhuma das duas migrations. Use só se o patch tiver quebrado
-- algo -- e registre o que quebrou.
--
-- NÃO desfaz o revoke das 545 tabelas existentes: isso é outro arquivo
-- (`20261107200000_revoke_truncate_backup_pos_import.rollback.sql`).

begin;

do $rollback$
declare
  v_def       text;
  v_novo      text;
  v_acl_antes text;
  v_acl_depois text;
  v_ancora constant text :=
    'execute format(''alter table public.%I enable row level security'', ''_backup_pos_import_'' || v_lote);';
  v_adicao constant text :=
    E'\n  -- Fecha o TRUNCATE que o default privilege do schema `public` abre em\n'
    || E'  -- toda tabela nova. RLS nao cobre TRUNCATE. (migration 20261108130000)\n'
    || E'  execute format(''revoke truncate on table public.%I from authenticated'', ''_backup_pos_import_'' || v_lote);';
begin
  select pg_get_functiondef(p.oid),
         (select string_agg(x.grantee::regrole::text || ':' || x.privilege_type, ', ' order by x.grantee::regrole::text)
            from aclexplode(p.proacl) x)
    into v_def, v_acl_antes
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'acordos_pos_importacao';

  if v_def is null then
    raise exception 'public.acordos_pos_importacao nao existe neste banco';
  end if;

  if position('revoke truncate' in lower(v_def)) = 0 then
    raise exception 'nada a desfazer: o corpo nao contem "revoke truncate" (a migration nao foi aplicada, ou ja foi revertida)';
  end if;

  if position(v_ancora || v_adicao in v_def) = 0 then
    raise exception 'o bloco acrescentado nao esta no formato esperado -- alguem editou a funcao depois; reverta a mao, com leitura da funcao inteira';
  end if;

  v_novo := replace(v_def, v_ancora || v_adicao, v_ancora);

  if position('revoke truncate' in lower(v_novo)) > 0 then
    raise exception 'sobrou "revoke truncate" no corpo depois da remocao -- abortando';
  end if;
  if position(v_ancora in v_novo) = 0 then
    raise exception 'a ancora desapareceu na remocao -- abortando';
  end if;

  execute v_novo;

  select (select string_agg(x.grantee::regrole::text || ':' || x.privilege_type, ', ' order by x.grantee::regrole::text)
            from aclexplode(p.proacl) x)
    into v_acl_depois
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'acordos_pos_importacao';

  if v_acl_depois is distinct from v_acl_antes then
    raise exception 'EXECUTE mudou no rollback: antes [%] depois [%]', v_acl_antes, v_acl_depois;
  end if;

  raise notice 'rollback OK: revoke removido do corpo; EXECUTE intacto [%]', v_acl_depois;
end
$rollback$;

-- Conferência: a função voltou inteira, sem o revoke.
do $confere$
declare
  v_secdef boolean; v_cfg text; v_args text; v_tem boolean;
begin
  select p.prosecdef, array_to_string(p.proconfig, ', '),
         pg_get_function_arguments(p.oid),
         position('revoke truncate' in lower(p.prosrc)) > 0
    into v_secdef, v_cfg, v_args, v_tem
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'acordos_pos_importacao';

  if v_tem then raise exception 'o revoke continua no corpo'; end if;
  if not v_secdef then raise exception 'a funcao perdeu SECURITY DEFINER'; end if;
  if v_cfg is distinct from 'search_path=public, statement_timeout=600s' then
    raise exception 'config mudou: [%]', v_cfg;
  end if;
  if position('DEFAULT' in upper(v_args)) = 0 then
    raise exception 'os DEFAULT dos argumentos foram perdidos: [%]', v_args;
  end if;

  raise notice 'conferencia do rollback OK: % / SECURITY DEFINER / %', v_args, v_cfg;
end
$confere$;

commit;
