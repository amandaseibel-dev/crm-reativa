-- Três defeitos que só apareceram no primeiro disparo real da rotina.
-- Todos aplicados em prod em 2026-08-25.
--
-- 1. DISJUNTOR LIA BOOLEANO ONDE VINHA OBJETO
--    `sistema_sob_carga()` devolve jsonb com o diagnóstico
--    ({"sob_carga": false, "ativos": 0, ...}), não um booleano. O IF explodia
--    com "invalid input syntax for type boolean" e a rotina NUNCA teria
--    disparado. Agora lê a chave certa e guarda o diagnóstico no log quando
--    corta -- assim dá para saber por que cortou.
--
-- 2. A CHAVE DA PRIME NÃO ESTAVA EM LUGAR NENHUM
--    A função esperava o secret de ambiente `PRIME_API_KEY`, que nunca foi
--    cadastrado neste projeto -- o disparo morreu em 500. Passa a vir do Vault
--    (`prime_api_key`), mesmo padrão do token. O secret de ambiente continua
--    valendo como alternativa.
--
-- 3. A FILA ESTOURAVA O TEMPO LIMITE
--    O `EXISTS (... WHERE s.cpf = d.cpf)` dentro do ORDER BY era correlacionado:
--    reavaliado uma vez por devedor, ~13 mil vezes, contra uma CTE sem índice.
--    `_relatorio_2026_1_eleg()` sozinho leva 300ms; era a repetição que matava.
--    Virou LEFT JOIN com CTEs MATERIALIZED. Medido depois: 496ms.
--
-- Depois das três: HTTP 200, 3 pedidos, 3 aplicados, 0 erros, 116 títulos
-- classificados.

create or replace function public.prime_api_key_backend()
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  v_chave text;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'Acesso negado: apenas service_role.' USING ERRCODE='42501';
  END IF;
  SELECT decrypted_secret INTO v_chave
    FROM vault.decrypted_secrets WHERE name = 'prime_api_key';
  RETURN v_chave;
END;
$function$;

revoke all on function public.prime_api_key_backend() from public, authenticated;
grant execute on function public.prime_api_key_backend() to service_role;

create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table (cpf text, saldo numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  WITH sem_negociacao AS MATERIALIZED (
    SELECT DISTINCT e.cpf FROM public._relatorio_2026_1_eleg() e
  ),
  devedores AS MATERIALIZED (
    SELECT lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') AS cpf,
           round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 2) AS saldo
      FROM public.acordos_titulos t
     WHERE lower(coalesce(t.status,'')) = 'em_aberto'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND length(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g')) = 11
     GROUP BY 1
  ),
  ja_coletados AS MATERIALIZED (
    SELECT DISTINCT c.cpf FROM public.prime_contratos c
     WHERE c.coletado_em > now() - interval '7 days'
  )
  SELECT d.cpf, d.saldo
    FROM devedores d
    LEFT JOIN sem_negociacao s ON s.cpf = d.cpf
    LEFT JOIN ja_coletados j   ON j.cpf = d.cpf
   WHERE j.cpf IS NULL
   ORDER BY (s.cpf IS NOT NULL) DESC, d.saldo DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;

revoke all on function public.prime_cadastro_pendentes(integer) from public, authenticated;
grant execute on function public.prime_cadastro_pendentes(integer) to service_role;

create or replace function public.prime_cadastro_disparar_noturno(p_limite integer default 300)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_url    text;
  v_token  text;
  v_carga  jsonb;
  v_req    bigint;
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

  v_carga := public.sistema_sob_carga();
  IF coalesce((v_carga->>'sob_carga')::boolean, false) THEN
    INSERT INTO public.prime_cadastro_execucoes (origem, observacao)
    VALUES ('cron', 'nao disparou: sistema sob carga -> ' || v_carga::text);
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
