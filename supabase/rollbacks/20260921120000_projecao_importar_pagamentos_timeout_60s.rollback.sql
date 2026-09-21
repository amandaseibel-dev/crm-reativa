-- ROLLBACK de 20260921120000_projecao_importar_pagamentos_timeout_60s.
-- Remove o statement_timeout proprio da sobrecarga de 7 argumentos e devolve o proconfig ao estado
-- anterior: {search_path=public}. md5(pg_get_functiondef) volta a 7ec234634c69e86fa74fefea250c2d9f.
-- Nenhum dado e tocado.
begin;

ALTER FUNCTION public.projecao_importar_pagamentos(text, text, jsonb, text, boolean, uuid, text)
  RESET statement_timeout;

commit;
