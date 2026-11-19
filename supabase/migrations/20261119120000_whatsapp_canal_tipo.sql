-- Classificação de tipo do canal WhatsApp.
-- 'COBRANCA': exige aluno_id confirmado antes do envio quando a proteção estiver ativa.
-- 'OUTRO': sem exigência adicional de vínculo (Comercial, Piloto, etc.).
--
-- Rollback: supabase/rollbacks/20261119120000_whatsapp_canal_tipo_rollback.sql

ALTER TABLE public.whatsapp_canais
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'OUTRO'
  CONSTRAINT ck_whatsapp_canal_tipo CHECK (tipo IN ('COBRANCA', 'OUTRO'));

-- Canal de cobrança existente
UPDATE public.whatsapp_canais SET tipo = 'COBRANCA' WHERE sessao_chave = 'cobranca';

-- Garantia: se o canal não existir no ambiente, o apply aborta em vez de deixar
-- tipo='OUTRO' para todos (fail-open silencioso). Detecta restore incompleto ou
-- nome diferente no ambiente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_canais
    WHERE sessao_chave = 'cobranca' AND tipo = 'COBRANCA'
  ) THEN
    RAISE EXCEPTION
      'Canal cobranca nao classificado: apply abortado. '
      'Verifique se whatsapp_canais contém sessao_chave=cobranca antes de aplicar.';
  END IF;
END $$;
