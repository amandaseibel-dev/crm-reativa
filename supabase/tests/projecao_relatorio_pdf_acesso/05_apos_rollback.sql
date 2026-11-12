-- Após o ROLLBACK: a versão anterior volta, mas os bloqueios de inativo e
-- anônimo NÃO podem reabrir.
do $$
declare m text := to_char(current_date,'YYYY-MM');
begin
  begin
    perform set_config('request.jwt.claims', '{}', true);
    perform public.projecao_relatorio_pdf(m);
    raise exception 'ROLLBACK REABRIU: anônimo';
  exception when sqlstate '42501' then null; end;
  begin
    perform set_config('request.jwt.claims', '{"email":"inativo.sintetico@teste.local","role":"authenticated"}', true);
    perform public.projecao_relatorio_pdf(m);
    raise exception 'ROLLBACK REABRIU: inativo';
  exception when sqlstate '42501' then null; end;
  raise notice 'OK após rollback: inativo e anônimo seguem bloqueados.';
end $$;
