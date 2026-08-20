-- O painel de gestao nao conseguia salvar canal nenhum.
--
-- SINTOMA: clicar em "Salvar" no painel "Numeros da Central" nao fazia nada.
-- Sem erro na tela, sem chamada ao banco.
--
-- CAUSA: `whatsapp_canais_listar` nao devolvia `sessao_chave`. O formulario
-- monta `sessaoChave: c.sessao_chave` -> undefined, e a validacao
-- `!f.sessaoChave.trim()` estoura em `undefined.trim()` ANTES do try/catch.
-- A excecao subia como rejeicao nao tratada: nada salvava e nada aparecia.
--
-- Ninguem tinha topado nisso porque ate hoje o painel so era usado para
-- CADASTRAR numero (onde o campo e digitado). Editar um numero existente nunca
-- funcionou.
--
-- A SEGUNDA METADE E PIOR QUE A PRIMEIRA. `whatsapp_canal_salvar` faz
-- `SET sessao_chave = btrim(lower(p_sessao_chave))` sem condicao. Bastaria a
-- tela mandar string vazia para a chave da sessao ser APAGADA -- e e ela que
-- amarra o canal ao gateway e ao historico. O numero pararia de receber e
-- ninguem saberia por que. Entao a funcao passa a ignorar valor vazio no
-- UPDATE: chave so muda para algo de verdade.
--
-- Duas travas para o mesmo buraco, de proposito: uma devolve o dado que
-- faltava, a outra garante que, mesmo que volte a faltar, nada e destruido.

DROP FUNCTION IF EXISTS public.whatsapp_canais_listar();

CREATE FUNCTION public.whatsapp_canais_listar()
RETURNS TABLE(id uuid, apelido text, display_phone_number text, sessao_chave text,
              ativo boolean, conexao_status text, conexao_detalhe text,
              conexao_atualizada_em timestamp with time zone,
              ultimo_heartbeat_em timestamp with time zone, online boolean,
              sync_inicial_em timestamp with time zone, aguardando_qr boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT k.id, k.apelido, k.display_phone_number, k.sessao_chave, k.ativo,
         k.conexao_status, k.conexao_detalhe, k.conexao_atualizada_em,
         k.ultimo_heartbeat_em,
         (k.conexao_status = 'CONECTADO'
          AND k.ultimo_heartbeat_em IS NOT NULL
          AND k.ultimo_heartbeat_em > now() - make_interval(
                mins => (SELECT minutos_sem_heartbeat_alerta FROM public.whatsapp_config WHERE id))
         ) AS online,
         k.sync_inicial_em,
         (k.conexao_status = 'AGUARDANDO_QR' AND k.qr_expira_em > now()) AS aguardando_qr
  FROM public.whatsapp_canais k
  WHERE public.app_usuario_ativo()
  ORDER BY k.apelido;
$function$;

GRANT EXECUTE ON FUNCTION public.whatsapp_canais_listar() TO authenticated;

CREATE OR REPLACE FUNCTION public.whatsapp_canal_salvar(
  p_apelido text, p_display_numero text, p_sessao_chave text,
  p_id uuid DEFAULT NULL, p_ativo boolean DEFAULT true)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'somente gestao' USING ERRCODE = '42501';
  END IF;

  IF p_id IS NULL THEN
    IF nullif(btrim(coalesce(p_sessao_chave, '')), '') IS NULL THEN
      RAISE EXCEPTION 'chave da sessao e obrigatoria para cadastrar numero';
    END IF;
    INSERT INTO public.whatsapp_canais (apelido, display_phone_number, sessao_chave, ativo)
    VALUES (btrim(p_apelido), btrim(p_display_numero), btrim(lower(p_sessao_chave)), coalesce(p_ativo, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.whatsapp_canais
    SET apelido              = btrim(p_apelido),
        display_phone_number = btrim(p_display_numero),
        -- Vazio NAO apaga: e a chave que amarra o canal ao gateway.
        sessao_chave         = coalesce(nullif(btrim(lower(coalesce(p_sessao_chave, ''))), ''), sessao_chave),
        ativo                = coalesce(p_ativo, true)
    WHERE id = p_id
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$function$;
