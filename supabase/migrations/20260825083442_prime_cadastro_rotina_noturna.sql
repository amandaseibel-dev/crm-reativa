-- Rotina noturna da atualização cadastral.
--
-- O cron chama a Edge Function `prime-cadastro` via pg_net, com a service key
-- do projeto. A função reconhece esse chamador e libera; para qualquer outro,
-- continua exigindo gestão.
--
-- PRÉ-REQUISITO QUE SÓ A AMANDA FAZ: guardar a service key no Vault com o nome
-- `prime_cadastro_service_key`. Enquanto ela não existir, a rotina não quebra
-- e não tenta nada -- apenas registra que faltou o segredo e sai. É de
-- propósito: melhor um cron mudo do que um cron gritando erro toda madrugada.
--
--   select vault.create_secret('<A SERVICE KEY>', 'prime_cadastro_service_key',
--                              'Service key para o cron da atualizacao cadastral');
--
-- POR QUE 300 POR NOITE: a Prime cobra 2 a 3 requisições por aluno e devolve
-- 503 quando aperta. 300 é o que cabe com folga numa janela de madrugada. São
-- ~4.600 devedores; com recoleta a cada 7 dias, a base inteira gira em duas
-- semanas e depois vira manutenção.

begin;

create table if not exists public.prime_cadastro_execucoes (
  id           bigserial primary key,
  iniciado_em  timestamptz not null default now(),
  origem       text not null default 'cron',
  requisicao   bigint,        -- id do pg_net, para cruzar com net._http_response
  observacao   text
);

alter table public.prime_cadastro_execucoes enable row level security;
drop policy if exists prime_cadastro_execucoes_select on public.prime_cadastro_execucoes;
create policy prime_cadastro_execucoes_select on public.prime_cadastro_execucoes
  for select to authenticated using (NOT public.eh_painel());

comment on table public.prime_cadastro_execucoes is
  'Registro dos disparos da atualizacao cadastral. `requisicao` cruza com net._http_response.';

create or replace function public.prime_cadastro_disparar_noturno(p_limite integer default 300)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_url  text;
  v_key  text;
  v_req  bigint;
BEGIN
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'projeto_url';
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'prime_cadastro_service_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    INSERT INTO public.prime_cadastro_execucoes (origem, observacao)
    VALUES ('cron', 'nao disparou: falta o segredo prime_cadastro_service_key no Vault');
    RETURN NULL;
  END IF;

  -- Disjuntor: se o banco já está sob carga, a madrugada não é hora de somar
  -- I/O. Fica para a próxima noite.
  IF public.sistema_sob_carga() THEN
    INSERT INTO public.prime_cadastro_execucoes (origem, observacao)
    VALUES ('cron', 'nao disparou: sistema sob carga');
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := rtrim(v_url, '/') || '/functions/v1/prime-cadastro',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object('limite', greatest(1, least(coalesce(p_limite, 300), 500))),
    timeout_milliseconds := 300000
  ) INTO v_req;

  INSERT INTO public.prime_cadastro_execucoes (origem, requisicao, observacao)
  VALUES ('cron', v_req, 'disparado com limite ' || coalesce(p_limite, 300));

  RETURN v_req;
END;
$function$;

revoke all on function public.prime_cadastro_disparar_noturno(integer) from public, authenticated;
grant execute on function public.prime_cadastro_disparar_noturno(integer) to service_role;

-- 03h10 BRT. Escolhido para não encostar nos vizinhos: 02h50 é o snapshot do
-- relatório 2026/1 e 03h05 é a atualização de parcelas vencidas.
select cron.unschedule('prime_cadastro_noturno')
 where exists (select 1 from cron.job where jobname = 'prime_cadastro_noturno');

select cron.schedule(
  'prime_cadastro_noturno',
  '10 6 * * *',   -- 06h10 UTC = 03h10 BRT
  $cron$ select public.prime_cadastro_disparar_noturno(300); $cron$
);

commit;
