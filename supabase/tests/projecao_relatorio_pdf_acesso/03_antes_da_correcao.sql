-- Reproduz o BUG na versão anterior (20260729240000): diretoria sai zerada.
do $$
declare r jsonb; m text := to_char(current_date,'YYYY-MM');
begin
  perform set_config('request.jwt.claims', '{"email":"diretoria.sintetica@teste.local","role":"authenticated"}', true);
  r := public.projecao_relatorio_pdf(m);
  if (r->'total'->>'pagamentos')::bigint <> 0 then
    raise exception 'ESPERADO bug reproduzido (diretoria zerada) e veio %', r->'total'; end if;
  raise notice 'OK antes: bug reproduzido (diretoria recebe 0 pagamentos).';
end $$;
