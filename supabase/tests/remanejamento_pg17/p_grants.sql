-- GRANTS e SEARCH_PATH das funcoes criadas ou alteradas pela migracao (B6). Roda DEPOIS da migracao.
-- Premissa de seguranca: CREATE OR REPLACE restaura grants padrao e search_path precisa ser reconferido.
-- Conjunto conferido (12): 8 internal.cg_* (criadas) e 4 RPCs publicas alteradas.
--  - search_path fixado em proconfig;
--  - anon nao executa nenhuma delas;
--  - internal.* nao executa para authenticated.
\i lib.sql
do $$
declare f record; n int := 0;
begin
  for f in
    select n.nspname || '.' || p.proname as nome, p.oid, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'internal' and p.proname like 'cg\_%')
        or (n.nspname = 'public' and p.proname in
            ('carteira_geral_previa','carteira_geral_mover','calibragem_executar_simulacao','liberar_fidelizacao_caso'))
  loop
    n := n + 1;
    perform pg_temp.afirma(exists (select 1 from unnest(coalesce(f.proconfig, '{}'::text[])) c where c like 'search_path=%'),
      format('%s: search_path fixado (%s)', f.nome, coalesce(array_to_string(f.proconfig, ','), 'nenhum')));
    perform pg_temp.afirma(not has_function_privilege('anon', f.oid, 'EXECUTE'),
      format('%s: anon NAO executa', f.nome));
    if f.nome like 'internal.%' then
      perform pg_temp.afirma(not has_function_privilege('authenticated', f.oid, 'EXECUTE'),
        format('%s: authenticated NAO executa (funcao interna)', f.nome));
    end if;
  end loop;
  raise notice 'grants/search_path: % funcoes conferidas (esperado 12)', n;
  perform pg_temp.afirma(n = 12, format('grants: %s funcoes conferidas (esperado 12)', n));
end $$;
select 'GRANTS OK' as resultado;
