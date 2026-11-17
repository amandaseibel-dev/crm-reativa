-- ROLLBACK, parte B: depois de rodar o rollback, so Z (nossa) perde a marca.
\i lib.sql
do $$
declare z uuid; x uuid; y uuid;
begin
  select caso into z from public.cg_teste_ids where nome = 'Z';
  select caso into x from public.cg_teste_ids where nome = 'X';
  select caso into y from public.cg_teste_ids where nome = 'Y';
  perform pg_temp.afirma(pg_temp.marca(z) is null and (select remanejamento_lote_id from public.casos where id = z) is null,
    'rollback: Z (nossa) perdeu marca e marcador');
  perform pg_temp.afirma(pg_temp.marca(x) = pg_temp.hoje() + 10,
    'rollback: X (marca alheia, mesma data) preservada');
  perform pg_temp.afirma(pg_temp.marca(y) = pg_temp.hoje() + 3,
    'rollback: Y (marca alheia, outra data) preservada');
  perform pg_temp.afirma(not exists (select 1 from pg_trigger where tgname = 'trg_cg_marcador_segue_a_marca'),
    'rollback removeu o gatilho do marcador');
end $$;
select 'ROLLBACK B OK' as resultado;
