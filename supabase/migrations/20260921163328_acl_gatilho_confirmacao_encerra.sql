-- ACL do gatilho da migration 20260922100200 (aplicar DEPOIS dela). Gatilho so e invocado pelo motor: sem EXECUTE direto.
begin;
revoke all on function public.tg_pagamento_baixado_encerra_confirmacao() from public, anon, authenticated;
commit;
