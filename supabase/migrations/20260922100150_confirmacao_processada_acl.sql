-- ACL CORRETIVA da migration 20260922100100 (funcoes de leitura da confirmacao processada).
-- Achado: nasceram com EXECUTE para PUBLIC/anon/authenticated (default do Postgres). Sao SECURITY DEFINER e devolvem ids de
-- pagamento/prova financeira. Nenhuma e chamada pelo front; so funcoes internas (SECURITY DEFINER, owner postgres) e service_role.
-- Menor privilegio: sem PUBLIC/anon/authenticated; service_role (rotina/diagnostico) e postgres (owner).
begin;
revoke all on function public._nome_norm(text) from public, anon, authenticated;
revoke all on function public.confirmacao_utc_provada(int) from public, anon, authenticated;
revoke all on function public.confirmacao_pagamentos_resolver(uuid) from public, anon, authenticated;
revoke all on function public.confirmacao_pagamento_processado(uuid) from public, anon, authenticated;
grant execute on function public._nome_norm(text) to service_role;
grant execute on function public.confirmacao_utc_provada(int) to service_role;
grant execute on function public.confirmacao_pagamentos_resolver(uuid) to service_role;
grant execute on function public.confirmacao_pagamento_processado(uuid) to service_role;
commit;
