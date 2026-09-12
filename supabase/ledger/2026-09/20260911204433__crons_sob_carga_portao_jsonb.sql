-- Portao de carga comparava jsonb com boolean: tres jobs nunca executaram.
-- Mesma agenda, mesma rotina, mesmos argumentos. So o portao muda.
select cron.schedule(
  'baixa_automatica_por_titulo',
  '0 */2 * * *',
  $$
  do $inner$
  declare v_carga jsonb;
  begin
    v_carga := public.sistema_sob_carga();
    if coalesce((v_carga->>'sob_carga')::boolean, false) then return; end if;
    perform public.baixa_automatica_por_titulo(true);
  end
  $inner$;
  $$
);

select cron.schedule(
  'fluxo_acordos_diario',
  '40 9 * * *',
  $$
  do $inner$
  declare v_carga jsonb;
  begin
    v_carga := public.sistema_sob_carga();
    if coalesce((v_carga->>'sob_carga')::boolean, false) then return; end if;
    perform public.fluxo_acordos_rodar(true);
  end
  $inner$;
  $$
);

select cron.schedule(
  'vigia_invariantes_diario',
  '10 9 * * *',
  $$
  do $inner$
  declare v_carga jsonb;
  begin
    v_carga := public.sistema_sob_carga();
    if coalesce((v_carga->>'sob_carga')::boolean, false) then return; end if;
    perform public.invariantes_rodar();
  end
  $inner$;
  $$
);
