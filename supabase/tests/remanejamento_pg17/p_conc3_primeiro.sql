-- CONTENCAO B4, sessao SEGURADORA: pega o lock do destino dentro de uma transacao e a segura ~2 s.
-- Variaveis psql: nome = 'primeiro' ou 'segundo' (quem segura); prev = previa ('X' ou 'Y').
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create temp table _pv as select :'prev'::text as nome;
create temp table _nm as select :'nome'::text as n;
insert into public.cg_teste3_bar values (:'nome', clock_timestamp()) on conflict (sessao) do nothing;
insert into public.cg_teste3_flag values ('holder:' || :'nome', clock_timestamp()) on conflict (nome) do nothing;
do $$
declare i int;
begin
  for i in 1..1000 loop
    exit when (select count(*) from public.cg_teste3_bar) = 2;
    perform pg_sleep(0.01);
  end loop;
  perform pg_temp.afirma((select count(*) from public.cg_teste3_bar) = 2, 'contencao barreira: as duas sessoes prontas');
end $$;
BEGIN;
do $$
declare pid text; r jsonb; t0 timestamptz := clock_timestamp();
begin
  select previa into pid from public.cg_teste3_ids where nome = (select nome from _pv);
  r := public.carteira_geral_mover(pid::uuid, 'contencao B4 segurador');
  insert into public.cg_teste3_res values ((select n from _nm), r, t0, clock_timestamp())
    on conflict (sessao) do update set resultado = excluded.resultado, inicio = excluded.inicio, fim = excluded.fim;
end $$;
select pg_sleep(2);
COMMIT;
insert into public.cg_teste3_flag values ('commit_holder', clock_timestamp()) on conflict (nome) do nothing;
