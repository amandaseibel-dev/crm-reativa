-- CONCORRENCIA, sessao b (roda em paralelo com a outra). Registra o resultado.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
do $$
declare pid text; r jsonb;
begin
  select previa into pid from public.cg_teste_ids where nome = 'MESMO_B';
  begin
    r := public.carteira_geral_mover(pid::uuid, 'concorrencia b');
  exception when others then
    r := jsonb_build_object('erro', sqlerrm, 'sqlstate', sqlstate);
  end;
  insert into public.cg_teste_res values ('b', r) on conflict (sessao) do update set resultado = excluded.resultado;
end $$;
