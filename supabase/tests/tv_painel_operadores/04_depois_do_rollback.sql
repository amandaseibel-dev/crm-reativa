\set ON_ERROR_STOP on
select public.afirmar(not exists (select 1 from pg_proc where proname = 'tv_painel_operadores'), 'rollback removeu a função');
select public.afirmar((select count(*) from public.pagamentos) = 34 and (select count(*) from public.acordos) = 16,
  'rollback não tocou em dado');
