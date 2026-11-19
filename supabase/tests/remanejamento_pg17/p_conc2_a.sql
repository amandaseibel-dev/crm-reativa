-- CONCORRENCIA B4, sessao A (destino Luana). Sincroniza com a sessao B antes de mover.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
insert into public.cg_teste2_bar values ('a') on conflict (sessao) do nothing;
do $$
declare i int;
begin
  -- barreira: so segue quando as DUAS sessoes estao prontas (ate ~10 s)
  for i in 1..1000 loop
    exit when (select count(*) from public.cg_teste2_bar) = 2;
    perform pg_sleep(0.01);
  end loop;
  -- sem as duas sessoes prontas o teste NAO roda: nao ha timeout silencioso
  perform pg_temp.afirma((select count(*) from public.cg_teste2_bar) = 2, 'B4 barreira: as duas sessoes chegaram ao ponto de sincronizacao');
end $$;
do $$
declare pid text; r jsonb;
begin
  select previa into pid from public.cg_teste2_ids where nome = 'PA';
  begin
    r := public.carteira_geral_mover(pid::uuid, 'concorrencia B4 destino Luana');
  exception when others then
    r := jsonb_build_object('erro', sqlerrm, 'sqlstate', sqlstate);
  end;
  insert into public.cg_teste2_res values ('a', r) on conflict (sessao) do update set resultado = excluded.resultado;
end $$;
