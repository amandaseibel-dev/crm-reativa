-- CONTENCAO B4, sessao NAO-SEGURADORA: so chama o mover depois de VER o lock do destino tomado por outra sessao.
-- Variaveis psql: nome2 = o nome desta sessao; prev2 = a previa desta sessao.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create temp table _pv2 as select :'prev2'::text as nome;
create temp table _nm2 as select :'nome2'::text as n2;
insert into public.cg_teste3_bar values (:'nome2', clock_timestamp()) on conflict (sessao) do nothing;
do $$
declare i int;
begin
  for i in 1..1000 loop
    exit when (select count(*) from public.cg_teste3_bar) = 2;
    perform pg_sleep(0.01);
  end loop;
  perform pg_temp.afirma((select count(*) from public.cg_teste3_bar) = 2, 'contencao barreira: as duas sessoes prontas');
  -- sincroniza no proprio lock: espera outra sessao segurar um advisory lock (o do destino)
  for i in 1..1000 loop
    exit when exists (select 1 from pg_locks where locktype = 'advisory' and granted
                      and objid::bigint = (hashtext('carteira_geral_mover:cobranca05@aelbra.com.br')::bigint & 4294967295));
    perform pg_sleep(0.01);
  end loop;
  perform pg_temp.afirma(exists (select 1 from pg_locks where locktype = 'advisory' and granted
                                 and objid::bigint = (hashtext('carteira_geral_mover:cobranca05@aelbra.com.br')::bigint & 4294967295)),
    'contencao: o lock do DESTINO (chave de carteira_geral_mover) estava concedido a outra sessao antes de mover');
end $$;
do $$
declare pid text; r jsonb; t0 timestamptz := clock_timestamp();
begin
  select previa into pid from public.cg_teste3_ids where nome = (select nome from _pv2);
  r := public.carteira_geral_mover(pid::uuid, 'contencao B4 nao-segurador');
  insert into public.cg_teste3_res values ((select n2 from _nm2), r, t0, clock_timestamp())
    on conflict (sessao) do update set resultado = excluded.resultado, inicio = excluded.inicio, fim = excluded.fim;
end $$;
