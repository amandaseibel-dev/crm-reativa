-- ROLLBACK de 20260922100150 (devolve o EXECUTE default; NAO recomendado: reabre exposicao a anon).
begin;
grant execute on function public._nome_norm(text), public.confirmacao_utc_provada(int),
  public.confirmacao_pagamentos_resolver(uuid), public.confirmacao_pagamento_processado(uuid) to public, anon, authenticated;
commit;
