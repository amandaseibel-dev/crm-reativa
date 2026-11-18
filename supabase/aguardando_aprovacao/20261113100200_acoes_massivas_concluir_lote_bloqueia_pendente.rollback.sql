-- ROLLBACK de 20261113100200_acoes_massivas_concluir_lote_bloqueia_pendente.
-- ORDEM DE REVERSAO: este rollback ANTES de reverter 20261113100000 e 20261113100100.
-- Remove a recusa de CONFIRMAR de lote pendente e devolve o corpo publicado (md5 3a940022...).
-- Nao toca dado. Com lote pendente, reverter esta migration reabre a confirmacao integral
-- sem destinatario: por isso o rollback recusa se houver lote de WhatsApp pendente.
--
-- lock_timeout restrito a ESTA transacao (SET LOCAL). Se a trava nao for obtida em 5 s,
-- a transacao aborta sem alterar nada.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_concluir_lote') IS NULL THEN
    RAISE EXCEPTION 'Rollback abortado: acoes_massivas_concluir_lote nao existe.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.acoes_massivas_lotes
              WHERE canal = 'WHATSAPP' AND confirmado_em IS NULL AND descartado_em IS NULL) THEN
    RAISE EXCEPTION 'Rollback recusado: ha lote de WhatsApp pendente de envio. Tratar o lote antes. Nada alterado.';
  END IF;
END $g$;

-- 1. REMOVE A RECUSA: substituicao exata do bloco de guarda (uma ocorrencia), como na 100100.
DO $r1$
DECLARE
  v_src text;
  v_guarda text := $guarda$  -- 17/11/2026: CONFIRMAR de lote PENDENTE de envio contorna a confirmacao por destinatario.
  -- Recusa antes de qualquer gravacao. Quem confirma e acoes_massivas_concluir_envio.
  if v_acao = 'CONFIRMAR' and coalesce(v_lote.registro_automatico, false) = false then
    raise exception 'Este lote esta pendente de envio. Confirme o envio destinatario a destinatario ou descarte o lote. Nada foi registrado.'
      using errcode = '55000';
  end if;

$guarda$;
  v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_concluir_lote' LIMIT 1;
  v_n := (length(v_src) - length(replace(v_src, v_guarda, ''))) / length(v_guarda);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Rollback abortado: bloco de guarda encontrado % vez(es), esperado 1.', v_n;
  END IF;
  EXECUTE replace(v_src, v_guarda, '');
END $r1$;

-- 2. MD5 FINAL = corpo publicado
DO $f$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_concluir_lote') IS DISTINCT FROM '3a94002240236f6ccd63296ccc4b6a42' THEN
    RAISE EXCEPTION 'Rollback abortado: md5 final de acoes_massivas_concluir_lote difere do publicado.';
  END IF;
END $f$;

COMMIT;
