-- Caminho administrativo para disparar a coleta do 202 pelo SQL Editor.
--
-- O PROBLEMA. `prime_portador_202_coletar` exige `usuario_e_gestao()` ou
-- service_role, e as duas coisas vem do JWT. O SQL Editor do Supabase roda
-- como `postgres`, SEM JWT (medido em 24/09/2026: current_user = session_user
-- = current_role = postgres, is_superuser = off, request.jwt.claims ausente).
-- Por isso a coleta nunca disparava: a funcao recusava com SEM_PERMISSAO.
--
-- POR QUE **NAO** RESOLVEMOS COM `current_user = 'postgres'` NO GATE.
-- `prime_portador_202_coletar` e SECURITY DEFINER e seu owner e `postgres`.
-- Dentro dela, `current_user` e SEMPRE o owner -- ou seja, 'postgres' --
-- independentemente de quem chamou. Um gate assim seria um bypass total:
-- `anon` e `authenticated` passariam. (Amanda levantou exatamente este risco
-- antes de qualquer linha ser escrita.)
--
-- O DESENHO: um nucleo, dois porteiros.
--
--   _prime_portador_202_disparar()      <- o fluxo, SEM gate de identidade
--        ^                    ^
--        |                    |
--   coletar()            coletar_admin()
--   gate por JWT         gate por GRANT
--   (aplicacao)          (SQL Editor)
--
-- A protecao do caminho administrativo NAO e uma condicao dentro da funcao: e
-- o privilegio de EXECUTE, que o Postgres verifica ANTES de executar qualquer
-- linha. Condicao dentro de funcao pode ser enganada por contexto; GRANT nao.
--
-- E O WRAPPER E `SECURITY INVOKER` DE PROPOSITO. Se fosse DEFINER, ele rodaria
-- como postgres e conseguiria chamar o nucleo mesmo tendo sido invocado por
-- outro papel. Sendo INVOKER, ele roda como o chamador -- e um `authenticated`
-- que de algum jeito o alcancasse esbarraria DE NOVO no EXECUTE do nucleo, que
-- tambem nao lhe e concedido. Duas barreiras, nao uma.
--
-- Nao recebe portador como parametro: 202 e literal no nucleo. Nao ha como
-- disparar 166, 195 ou qualquer outro por aqui.

-- 1) NUCLEO. Sem gate de identidade -- quem chega aqui ja passou por um
--    porteiro. DEFINER porque precisa do vault e da auditoria.
create or replace function public._prime_portador_202_disparar(
  p_usuario text,
  p_reiniciar boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_url text; v_token text; v_req bigint; v_carga jsonb;
  v_estado jsonb; v_erro text;
begin
  v_estado := jsonb_build_object(
    'snapshot_202', public.prime_portador_snapshot_estado(202),
    'reiniciar', coalesce(p_reiniciar, false)
  );

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    perform public._prime_portador_202_auditar(
      p_usuario, 'RECUSADA', 'SISTEMA_SOB_CARGA', null,
      v_estado || jsonb_build_object('carga', v_carga));
    return jsonb_build_object('ok', false, 'motivo', 'SISTEMA_SOB_CARGA', 'carga', v_carga);
  end if;

  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'prime_cadastro_token';
  if v_url is null or v_token is null then
    perform public._prime_portador_202_auditar(
      p_usuario, 'RECUSADA', 'SEGREDO_AUSENTE', null,
      v_estado || jsonb_build_object('tem_projeto_url', v_url is not null,
                                     'tem_prime_cadastro_token', v_token is not null));
    return jsonb_build_object('ok', false, 'motivo', 'SEGREDO_AUSENTE',
      'tem_projeto_url', v_url is not null, 'tem_prime_cadastro_token', v_token is not null);
  end if;

  begin
    select net.http_post(
      url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
      headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
      body := jsonb_build_object('portador', 202, 'reiniciar', coalesce(p_reiniciar,false)),
      timeout_milliseconds := 170000) into v_req;
  exception when others then
    v_erro := sqlerrm;
    perform public._prime_portador_202_auditar(
      p_usuario, 'RECUSADA', 'FALHA_DISPARO_HTTP', null,
      v_estado || jsonb_build_object('erro', v_erro, 'sqlstate', sqlstate));
    return jsonb_build_object('ok', false, 'motivo', 'FALHA_DISPARO_HTTP', 'erro', v_erro);
  end;

  if v_req is null then
    perform public._prime_portador_202_auditar(
      p_usuario, 'RECUSADA', 'FALHA_DISPARO_HTTP', null,
      v_estado || jsonb_build_object('erro', 'net.http_post devolveu null'));
    return jsonb_build_object('ok', false, 'motivo', 'FALHA_DISPARO_HTTP',
      'erro', 'net.http_post devolveu null');
  end if;

  perform public._prime_portador_202_auditar(p_usuario, 'DISPARADA', null, v_req, v_estado);
  return jsonb_build_object('ok', true, 'motivo', null, 'request_id', v_req,
    'observacao', 'chamada enfileirada; confira prime_portador_snapshot_estado(202) ate motivo = OK');
end;
$function$;

revoke all on function public._prime_portador_202_disparar(text, boolean) from public;
revoke all on function public._prime_portador_202_disparar(text, boolean) from anon;
revoke all on function public._prime_portador_202_disparar(text, boolean) from authenticated;

-- 2) PORTEIRO DA APLICACAO. Gate identico ao de antes; so o corpo virou
--    delegacao. A ACL desta funcao NAO e tocada.
create or replace function public.prime_portador_202_coletar(p_reiniciar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_usuario text := coalesce(nullif(lower(auth.jwt() ->> 'email'), ''), nullif(auth.role(),''), 'sistema');
  v_gestao  boolean := coalesce(public.usuario_e_gestao(), false);
  v_service boolean := (coalesce(auth.role(),'') = 'service_role');
begin
  if not v_gestao and not v_service then
    perform public._prime_portador_202_auditar(
      v_usuario, 'RECUSADA', 'SEM_PERMISSAO', null,
      jsonb_build_object('snapshot_202', public.prime_portador_snapshot_estado(202),
                         'reiniciar', coalesce(p_reiniciar,false),
                         'role', coalesce(auth.role(),'(sem role)'),
                         'via', 'aplicacao'));
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PERMISSAO',
      'observacao', 'a coleta do portador 202 e da gestao financeira');
  end if;

  return public._prime_portador_202_disparar(v_usuario, p_reiniciar);
end;
$function$;

-- 3) PORTEIRO ADMINISTRATIVO. INVOKER; quem protege e o GRANT.
--    Sem parametro de portador: 202 e literal no nucleo.
create or replace function public.prime_portador_202_coletar_admin(p_reiniciar boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $function$
begin
  return public._prime_portador_202_disparar(
    'admin:' || session_user::text || '@sql-editor', p_reiniciar);
end;
$function$;

-- A barreira. Revogar de PUBLIC nao basta: o schema `public` deste projeto tem
-- default privileges que concedem EXECUTE a `authenticated` -- por isso cada
-- papel e revogado por nome, e so `postgres` recebe.
revoke all on function public.prime_portador_202_coletar_admin(boolean) from public;
revoke all on function public.prime_portador_202_coletar_admin(boolean) from anon;
revoke all on function public.prime_portador_202_coletar_admin(boolean) from authenticated;
revoke all on function public.prime_portador_202_coletar_admin(boolean) from service_role;
grant execute on function public.prime_portador_202_coletar_admin(boolean) to postgres;
