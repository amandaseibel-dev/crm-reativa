-- O token da rotina passa a viver em UM lugar só: o Vault.
--
-- ANTES: precisava ser cadastrado em dois lugares -- no Vault (para o banco
-- chamar) e como secret da Edge Function (para ela conferir). Dois lugares
-- significa alguém copiando segredo entre telas, que é justamente o momento em
-- que segredo vaza. E era um passo a mais para dar errado.
--
-- AGORA: a função pergunta ao banco se o token confere. Ela já tem a service
-- key para gravar, então não precisa guardar cópia de nada.
--
-- A comparação usa digest em vez de `=` para não entregar o segredo pelo tempo
-- de resposta -- comparação de texto para cedo no primeiro byte diferente.
--
-- E a função passou a rodar com `verify_jwt = false`, o que também tirou a
-- necessidade de guardar a anon key no Vault. Não é afrouxamento: são as mesmas
-- duas portas de antes (token da rotina ou sessão de gestão), e nada passa fora
-- delas -- testado, 401 sem token e 401 com token errado.
--
-- APLICADA EM PROD em 2026-08-25.

create or replace function public.prime_cadastro_token_valido(p_token text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
DECLARE
  v_esperado text;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'Acesso negado: apenas service_role.' USING ERRCODE='42501';
  END IF;

  SELECT decrypted_secret INTO v_esperado
    FROM vault.decrypted_secrets WHERE name = 'prime_cadastro_token';

  IF v_esperado IS NULL OR coalesce(p_token,'') = '' THEN
    RETURN false;
  END IF;

  RETURN encode(extensions.digest(p_token, 'sha256'), 'hex')
       = encode(extensions.digest(v_esperado, 'sha256'), 'hex');
END;
$function$;

revoke all on function public.prime_cadastro_token_valido(text) from public, authenticated;
grant execute on function public.prime_cadastro_token_valido(text) to service_role;

-- A rotina deixa de precisar da anon key.
create or replace function public.prime_cadastro_disparar_noturno(p_limite integer default 300)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_url   text;
  v_token text;
  v_req   bigint;
BEGIN
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'projeto_url';
  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets WHERE name = 'prime_cadastro_token';

  IF v_url IS NULL OR v_token IS NULL THEN
    INSERT INTO public.prime_cadastro_execucoes (origem, observacao)
    VALUES ('cron', 'nao disparou: falta no Vault -> ' ||
      concat_ws(', ',
        CASE WHEN v_url   IS NULL THEN 'projeto_url' END,
        CASE WHEN v_token IS NULL THEN 'prime_cadastro_token' END));
    RETURN NULL;
  END IF;

  IF public.sistema_sob_carga() THEN
    INSERT INTO public.prime_cadastro_execucoes (origem, observacao)
    VALUES ('cron', 'nao disparou: sistema sob carga');
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := rtrim(v_url, '/') || '/functions/v1/prime-cadastro',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-rotina-token', v_token
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
