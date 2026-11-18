-- CONCORRENCIA B4, sessao B (destino Mauricio). Sincroniza com a sessao A antes de mover.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
insert into public.cg_teste2_bar values ('b') on conflict (sessao) do nothing;
do $$
declare i int;
begin
  for i in 1..1000 loop
    exit when (select count(*) from public.cg_teste2_bar) = 2;
    perform pg_sleep(0.01);
  end loop;
end $$;
do $$
declare pid text; r jsonb;
begin
  select previa into pid from public.cg_teste2_ids where nome = 'PB';
  begin
    r := public.carteira_geral_mover(pid::uuid, 'concorrencia B4 destino Mauricio');
  exception when others then
    r := jsonb_build_object('erro', sqlerrm, 'sqlstate', sqlstate);
  end;
  insert into public.cg_teste2_res values ('b', r) on conflict (sessao) do update set resultado = excluded.resultado;
end $$;
