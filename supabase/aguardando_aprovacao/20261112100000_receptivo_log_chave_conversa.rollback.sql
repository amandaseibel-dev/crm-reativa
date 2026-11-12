-- ROLLBACK da chave do log receptivo (conversa) -> volta a chave (operador, ciclo)
-- Restaura exatamente o estado da cota 10 (20261111150000).
-- NAO apaga linhas. A coluna conversa_id fica (sem perda; nao quebra nada).
-- Se houver duas linhas com o mesmo (operador, ciclo) criadas pela chave nova,
-- o rollback PARA com a lista: resolver a mao antes de tentar de novo.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. conflitos que impediriam o indice antigo
DO $conf$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT operador_email, responsavel_desde FROM public.receptivo_atendimentos_log
     WHERE responsavel_desde IS NOT NULL
     GROUP BY 1,2 HAVING count(*) > 1) x;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'rollback recusado: % pares (operador, ciclo) duplicados. Resolver a mao; nada foi apagado.', v_n
      USING ERRCODE = '23505';
  END IF;
END $conf$;

-- 1. funcao volta ao alvo antigo (cota 10, sem conversa_id na chave)
CREATE OR REPLACE FUNCTION public.fila_receptivo_registrar_atendimento(
  p_email text, p_conversa_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_hoje           date := (now() at time zone 'America/Sao_Paulo')::date;
  v_nome           text;
  v_resp_desde     timestamptz;
  v_rows           integer;
begin
  if p_conversa_id is not null then
    select responsavel_desde into v_resp_desde
      from public.whatsapp_conversas
     where id = p_conversa_id
       and lower(responsavel_email) = lower(p_email);

    if not found or v_resp_desde is null then
      return false;
    end if;
  end if;

  select nome into v_nome from public.fila_receptivo where email = p_email;
  if not found then return false; end if;

  insert into public.receptivo_atendimentos_log
    (operador_email, operador_nome, atendido_em, responsavel_desde, fonte)
  values (
    p_email,
    v_nome,
    now(),
    v_resp_desde,
    case when p_conversa_id is not null then 'WHATSAPP' else 'MANUAL' end
  )
  on conflict (operador_email, responsavel_desde)
  where responsavel_desde is not null
  do nothing;

  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    update public.fila_receptivo
       set atendimentos_hoje = case when data_referencia = v_hoje then atendimentos_hoje + 1 else 1 end,
           data_referencia   = v_hoje,
           ultimo_atendimento = now(),
           online_em          = now()
     where email = p_email;
  end if;

  return v_rows > 0;
end;
$function$;

REVOKE ALL ON FUNCTION public.fila_receptivo_registrar_atendimento(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fila_receptivo_registrar_atendimento(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fila_receptivo_registrar_atendimento(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fila_receptivo_registrar_atendimento(text, uuid) TO service_role;

-- 2. indice antigo de volta (agora sem conflito, verificado acima)
CREATE UNIQUE INDEX IF NOT EXISTS uq_receptivo_log_operador_ciclo
  ON public.receptivo_atendimentos_log (operador_email, responsavel_desde)
  WHERE responsavel_desde IS NOT NULL;

-- 3. sai o que a migration criou
DROP INDEX IF EXISTS public.uq_receptivo_log_operador_conversa_ciclo;
DROP INDEX IF EXISTS public.uq_receptivo_log_operador_ciclo_legado;

-- 4. verificacao final
DO $verifica$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='receptivo_atendimentos_log'
                    AND indexname='uq_receptivo_log_operador_ciclo') THEN
    RAISE EXCEPTION 'indice antigo nao voltou' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='receptivo_atendimentos_log'
                AND indexname IN ('uq_receptivo_log_operador_conversa_ciclo','uq_receptivo_log_operador_ciclo_legado')) THEN
    RAISE EXCEPTION 'indice novo ainda existe' USING ERRCODE = '22023';
  END IF;
  RAISE NOTICE 'rollback receptivo log: chave (operador, ciclo) restaurada';
END $verifica$;

COMMIT;
