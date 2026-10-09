-- Rotina semanal da revisão CRM x Prime: o status de cada aluno se atualiza sozinho.
--
-- Amanda, 04/09/2026: "precisamos dessa atualização; coloque na rotina de
-- domingo atualizar o status".
--
-- O status (`revisao_prime_aluno`) depende de três coletas do Prime, e só
-- vale se as três estiverem frescas quando ele for recalculado:
--
--   sábado 00:00-01:59 UTC  portador 195/166 ......... já existia (prime_portador_mutirao)
--   sábado 02:05 UTC        reenfileira o extrato de TODA a base (nova)
--   sábado 02:06-23:58 UTC  prime-extrato a cada 2 min, lote 400 ......... religado
--                           (~240 alunos por chamada de 110 s; a base inteira,
--                           ~17,2 mil, fecha em ~2h30)
--   domingo (o dia todo)    cadastro/contratos/telefones ......... já existia (prime_cadastro_mutirao)
--   domingo 23:50 UTC       revisao_prime_recalcular() .............. novo
--
-- Horários em UTC, como os crons que já existiam (o "domingo" da rotina
-- cadastral também é UTC). Recalcular às 23:50 de domingo deixa o status pronto
-- para a segunda-feira com portador, extrato e cadastro da mesma semana.
--
-- POR QUE O EXTRATO VOLTA. Foi pausado em 02/09 porque rodava vazio e não tinha
-- consumidor. Agora tem: é ele que diz se a mensalidade do 195 continua em
-- aberto (ver 20260904120000). Sem recoleta, o status envelhece calado.
--
-- PORTADOR: trava de "já fechou esta semana". O mutirão do portador escolhia
-- sempre o portador com coleta mais antiga e, quando os dois fechavam o ciclo
-- ainda dentro da janela, começava OUTRO ciclo que a janela cortava pela metade
-- (ciclo interrompido só termina na semana seguinte, com a limpeza atrasada).
-- Agora, se os dois cursores estão em 0 e foram atualizados nas últimas 3 horas,
-- ele para.
--
-- DESFAZER: supabase/rollbacks/20260904150000_revisao_prime_rotina_semanal.rollback.sql

-- 1) Reenfileirar o extrato de toda a base (uma vez por semana, sábado 02:05).
create or replace function public.prime_extrato_reenfileirar()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_n integer;
begin
  insert into public.prime_extrato_fila (matricula, cpf, motivo, tentativas, criado_em)
  select c.registration, c.cpf, 'atualizacao semanal', 0, now()
    from (
      select distinct on (cpf) cpf, registration
        from public.prime_contratos
       order by cpf, valid_from desc
    ) c
   where exists (
     select 1 from public.alunos a
      where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = c.cpf)
  on conflict (matricula) do update
     set coletado_em = null,
         tentativas  = 0,
         ultimo_erro = null,
         motivo      = excluded.motivo;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

revoke all on function public.prime_extrato_reenfileirar() from public, anon, authenticated;

comment on function public.prime_extrato_reenfileirar() is
  'Poe toda a base (alunos com matricula conhecida no Prime) de volta na fila do extrato. Roda sabado 02:05 UTC; o prime-extrato consome ate esvaziar.';

-- 2) O mutirão do extrato passa a pedir lote 400 (a Edge para aos 110 s e
--    devolve o que coube, ~240). Com 60 a base inteira levaria o fim de semana.
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
    body := jsonb_build_object('lote', 400),
    timeout_milliseconds := 170000) into v_req;
  return v_req;
end;
$function$;

-- 3) Portador: para quando os dois já fecharam o ciclo nesta janela.
create or replace function public.prime_portador_mutirao()
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_url text; v_token text; v_req bigint; v_portador int; v_carga jsonb;
begin
  -- Os dois portadores fecharam um ciclo nas últimas 3 horas: a semana está
  -- feita. Sem isto, a janela de sábado começava um terceiro ciclo e o cortava
  -- pela metade.
  if (select count(*) from public.prime_sync_cursor
       where carrier_id in (166, 195)
         and proximo_skip = 0
         and atualizado_em > now() - interval '3 hours') = 2 then
    return null;
  end if;

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

-- 4) Agenda.
select cron.schedule(
  'prime_extrato_reenfileirar_semanal',
  '5 2 * * 6',
  $cron$ select public.prime_extrato_reenfileirar(); $cron$
);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'prime_extrato_mutirao'),
  schedule => '*/2 2-23 * * 6',
  active   => true
);

select cron.schedule(
  'revisao_prime_semanal',
  '50 23 * * 0',
  $cron$ select public.revisao_prime_recalcular(); $cron$
);
