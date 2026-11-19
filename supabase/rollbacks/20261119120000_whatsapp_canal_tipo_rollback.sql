-- Rollback: remove coluna tipo de whatsapp_canais
ALTER TABLE public.whatsapp_canais DROP COLUMN IF EXISTS tipo;
