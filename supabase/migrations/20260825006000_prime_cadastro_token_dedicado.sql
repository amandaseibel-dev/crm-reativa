-- A rotina noturna passa a se identificar com um TOKEN DEDICADO, em vez da
-- service key do projeto.
--
-- POR QUÊ: a service key passa por cima de todo o RLS -- quem a tem lê e
-- escreve qualquer tabela. Guardá-la no Vault seria aceitável, mas o estrago de
-- um vazamento é o banco inteiro. Com um token próprio, o pior que acontece é
-- alguém disparar uma coleta na Prime.
--
-- O token vai no header `x-rotina-token`. A Edge Function compara com o secret
-- `PRIME_CADASTRO_TOKEN` dela, em tempo constante. Como `verify_jwt` continua
-- ligado, a chamada ainda precisa de um JWT válido -- a anon key serve, e é
-- pública de qualquer forma.
--
-- TRÊS SEGREDOS NO VAULT:
--   projeto_url            (já existia)
--   projeto_anon_key       (a chave pública do projeto)
--   prime_cadastro_token   (o token, mesmo valor do secret da função)
--
-- Sem eles a rotina não quebra: registra em `prime_cadastro_execucoes` o que
-- faltou, nominalmente, e sai.
--
-- APLICADA EM PROD em 2026-08-25.

create or replace function public.prime_cadastro_disparar_noturno(p_limite integer default 300)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_url   text;
  v_token text;
  v_anon  text;
  v_req   bigint;
BEGIN
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'projeto_url';
  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets WHERE name = 'prime_cadastro_token';
  SELECT decrypted_secret INTO v_anon
    FROM vault.decrypted_secrets WHERE name = 'projeto_anon_key';

  IF v_url IS NULL OR v_token IS NULL OR v_anon IS NULL THEN
    INSERT INTO public.prime_cadastro_execucoes (origem, observacao)
    VALUES ('cron', 'nao disparou: falta no Vault -> ' ||
      concat_ws(', ',
        CASE WHEN v_url   IS NULL THEN 'projeto_url' END,
        CASE WHEN v_token IS NULL THEN 'prime_cadastro_token' END,
        CASE WHEN v_anon  IS NULL THEN 'projeto_anon_key' END));
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
                 'Authorization', 'Bearer ' || v_anon,
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
