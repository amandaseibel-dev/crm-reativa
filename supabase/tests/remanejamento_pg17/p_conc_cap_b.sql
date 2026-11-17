\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
do $$ declare r jsonb; begin
  begin r := public.carteira_geral_mover((select previa::uuid from public.cg_teste_ids where nome='CAP_F'), 'cap f');
  exception when others then r := jsonb_build_object('erro', sqlerrm); end;
  insert into public.cg_teste_res values ('cap_f', r) on conflict (sessao) do update set resultado = excluded.resultado;
end $$;
