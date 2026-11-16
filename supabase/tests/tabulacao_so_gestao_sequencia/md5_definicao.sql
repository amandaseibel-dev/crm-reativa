-- Mede o hash FINAL da função pelo catálogo, com o MESMO método da guarda: md5(prosrc).
-- prosrc é o corpo fonte; pg_get_functiondef é outra medida e não é intercambiável.
\set ON_ERROR_STOP on
select md5(prosrc) as md5_prosrc_final, length(prosrc) as len_prosrc
  from pg_proc where proname = '_encerramento_so_gestao' and pronamespace = 'public'::regnamespace;
