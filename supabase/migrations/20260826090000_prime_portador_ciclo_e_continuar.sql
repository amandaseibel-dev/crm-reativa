-- Varredura de portador da Ulbra: marcador de rodada e continuacao automatica.
--
-- POR QUE ISSO EXISTE. A regra de leitura da divida, dita pela Amanda em
-- 25/08/2026, nao depende de adivinhar padrao de pagamento:
--
--     esta no 195 (REATIVA RECUPERACAO)  -> mensalidade em cobranca, AINDA DEVE
--     esta no 166 (SANTANDER REATIVA)    -> negociou, virou ACORDO
--     nao esta em nenhum dos dois        -> QUITOU
--
-- So existia a lista do 166. Faltava o 195 -- e e ele que separa "ainda deve"
-- de "quitou". Sao 40.491 registros, que nao cabem numa invocacao da Edge
-- (teto de 150s), entao a varredura atravessa varias chamadas.

-- 1) Marcador de rodada na lista de membros.
--
-- `prime_sync_cursor.ciclo` ja era um inteiro por portador; esta coluna e o
-- outro lado do par, e permite saber no fim QUEM saiu do portador. Sem ela a
-- unica pista seria o horario, que muda a cada fatia e nao serve de marca.
alter table public.prime_portador_membro
  add column if not exists ciclo integer not null default 0;

comment on column public.prime_portador_membro.ciclo is
  'Rodada da varredura que carimbou esta linha; pareia com prime_sync_cursor.ciclo. Quem fica com ciclo antigo ao fim da varredura saiu do portador.';

-- 2) Continuacao ate fechar -- e parada automatica.
--
-- O PONTO DELICADO: quando a varredura FECHA, o cursor volta para skip 0. Se o
-- cron continuasse disparando, comecaria tudo de novo, para sempre, batendo na
-- API da Ulbra a cada 3 minutos sem motivo. Por isso a funcao so dispara
-- enquanto houver skip pendente.
--
-- Para recomecar de proposito (a lista muda com o tempo), chame a Edge com
-- {"reiniciar": true} -- explicitamente, por decisao de gente.
create or replace function public.prime_portador_continuar(p_portador integer default 195)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_skip  integer;
  v_url   text;
  v_token text;
  v_carga jsonb;
  v_req   bigint;
begin
  select proximo_skip into v_skip
  from public.prime_sync_cursor where carrier_id = p_portador;

  if v_skip is null or v_skip = 0 then
    return null;
  end if;

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    return null;
  end if;

  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'prime_cadastro_token';
  if v_url is null or v_token is null then
    return null;
  end if;

  select net.http_post(
    url     := rtrim(v_url,'/') || '/functions/v1/prime-portador',
    headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
    body    := jsonb_build_object('portador', p_portador),
    timeout_milliseconds := 200000
  ) into v_req;

  return v_req;
end;
$$;

revoke all on function public.prime_portador_continuar(integer) from public, anon, authenticated;

comment on function public.prime_portador_continuar(integer) is
  'Continua a varredura do portador enquanto houver cursor pendente; para sozinha quando skip volta a 0.';

select cron.schedule(
  'prime_portador_195',
  '*/3 * * * *',
  $cron$ select public.prime_portador_continuar(195); $cron$
);
