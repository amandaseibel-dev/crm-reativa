-- DESFAZER 20260831260000_relatorio_2026_1_tira_quem_ja_quitou_pelo_extrato.sql
--
-- Devolve ao relatorio de jan-jun as 91 pessoas que ja quitaram pelo extrato --
-- gente que pagou e voltaria a contar como divida em aberto.
--
-- Nao ha motivo conhecido para desfazer. Se o incomodo for o corte ser largo
-- demais, ele JA e o estreito: tira so quem pagou >= o que deve. O corte largo
-- (qualquer pagamento) tiraria 202 em vez de 91, e foi recusado de proposito.

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='_relatorio_2026_1_eleg';

  v_novo := regexp_replace(v_def,
    E'\\n[^\\n]*-- JA QUITOU PELO EXTRATO.*?valor_original, 0\\) > 0\\)\\n', E'\\n', 'ns');

  if v_novo = v_def then
    raise exception 'nada a desfazer -- a funcao nao esta na versao com o corte do extrato';
  end if;
  execute v_novo;
end $do$;
