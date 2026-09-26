-- Desfaz 20260904150000_revisao_prime_rotina_semanal.sql
select cron.unschedule('revisao_prime_semanal');
select cron.unschedule('prime_extrato_reenfileirar_semanal');
-- extrato volta ao estado de 02/09 (pausado, agenda antiga)
select cron.alter_job((select jobid from cron.job where jobname = 'prime_extrato_mutirao'),
                      schedule => '*/2 * * * *', active => false);
drop function if exists public.prime_extrato_reenfileirar();

-- mutirão do extrato com lote 60 (versão de 31/08)
create or replace function public.prime_extrato_mutirao()
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_url text; v_req bigint; v_carga jsonb; v_faltam int;
begin
  select count(*) into v_faltam from public.prime_extrato_fila
   where coletado_em is null and tentativas < 3;
  if coalesce(v_faltam,0) = 0 then return null; end if;
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then return null; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name='projeto_url';
  if v_url is null then return null; end if;
  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/prime-extrato',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('lote', 60),
    timeout_milliseconds := 170000) into v_req;
  return v_req;
end;
$function$;

-- mutirão do portador sem a trava de "já fechou esta semana" (versão de 02/09)
create or replace function public.prime_portador_mutirao()
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_url text; v_token text; v_req bigint; v_portador int; v_carga jsonb;
begin
  select decrypted_secret into v_url   from vault.decrypted_secrets where name='projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name='prime_cadastro_token';
  if v_url is null or v_token is null then return null; end if;
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then return null; end if;
  select portador into v_portador
    from (select 166 portador union all select 195) p
    left join lateral (select max(coletado_em) ult from public.prime_portador_membro m
                        where m.portador = p.portador) u on true
   order by coalesce(u.ult, timestamptz '2000-01-01') asc limit 1;
  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
    headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
    body := jsonb_build_object('portador', v_portador),
    timeout_milliseconds := 170000) into v_req;
  return v_req;
end;
$function$;
