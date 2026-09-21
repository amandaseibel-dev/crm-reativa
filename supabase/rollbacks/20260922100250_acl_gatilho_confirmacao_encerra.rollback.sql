-- ROLLBACK de 20260922100250 (devolve EXECUTE default; nao recomendado).
begin;
grant execute on function public.tg_pagamento_baixado_encerra_confirmacao() to public, anon, authenticated;
commit;
