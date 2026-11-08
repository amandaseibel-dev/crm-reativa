-- Depois do rollback, sobre o CORPO REAL: tem de voltar BYTE A BYTE.
\set ON_ERROR_STOP on

do $rb$
declare
  v_def   text;
  v_antes text;
  v_bytes int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'acordos_pos_importacao';

  select md5, bytes into v_antes, v_bytes
    from public._prova_corpo_real where etapa = 'antes';

  if position('revoke truncate' in v_def) > 0 then
    raise exception 'FALHOU: sobrou "revoke truncate" no corpo depois do rollback';
  end if;

  if md5(v_def) <> v_antes then
    raise exception
      'FALHOU: o rollback nao devolveu o texto original. md5 antes %, agora % (% bytes vs %)',
      v_antes, md5(v_def), v_bytes, length(v_def);
  end if;

  raise notice 'OK: rollback devolveu o corpo real byte a byte -- md5 %, % bytes',
    v_antes, length(v_def);
end
$rb$;
