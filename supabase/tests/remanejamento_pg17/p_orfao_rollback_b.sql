-- MARCADOR ORFAO apos o rollback: limpo, sem tocar a marca de outra origem.
\i lib.sql
do $$
declare o uuid;
begin
  select caso into o from public.cg_orfao where nome = 'ORFAO';
  perform pg_temp.afirma((select remanejamento_lote_id from public.casos where id = o) is null,
    'rollback: o marcador orfao foi limpo');
end $$;
select 'ORFAO ROLLBACK OK' as resultado;
