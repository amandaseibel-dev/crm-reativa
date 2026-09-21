-- ROLLBACK de 20260922150000: remove SOMENTE o job acordo_alertas_d2_diario (nenhum outro job e tocado; alertas existentes permanecem).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'acordo_alertas_d2_diario') then
    perform cron.unschedule('acordo_alertas_d2_diario');
  end if;
end $$;
