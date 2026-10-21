-- ROLLBACK de 20261021213000_vw_fluxo_monitor_fecha_escrita.sql
--
-- O QUE REVERTER REINTRODUZ, EM LETRAS MAIÚSCULAS:
--
--   DEVOLVE A QUALQUER USUÁRIO LOGADO O PODER DE APAGAR E ALTERAR A TRILHA DE
--   MONITORAMENTO DO FLUXO DE PAGAMENTOS -- pela view e pela tabela base. A
--   view volta a executar com o dono (postgres), logo volta a CONTORNAR o RLS
--   da tabela base, e a única política existente (SELECT para a gestão) deixa
--   de proteger a escrita.
--
--   Medido em 21/10/2026: pg_relation_is_updatable da view = 28, isto é, ela
--   ACEITA DELETE e UPDATE. Sem security_invoker e com o grant de volta, a
--   porta é real, não teórica.
--
-- Não alcança dado financeiro: a view só expõe fluxo_pagamentos_execucoes.
-- Ainda assim, apagar o monitoramento é apagar a prova do que a automação fez.
--
-- Por isso este rollback só deve ser usado com decisão expressa e motivo
-- declarado -- e o motivo não pode ser "para alguém poder limpar a tabela":
-- para isso existe a gestão via service_role, que já tem o acesso.
--
-- ESTADO ANTERIOR, conferido em 21/10/2026:
--   view:   postgres=arwdDxtm/postgres|authenticated=arwdDxtm/postgres|service_role=arwdDxtm/postgres
--   tabela: postgres=arwdDxtm/postgres|authenticated=arwdDxtm/postgres|service_role=arwdDxtm/postgres
--   security_invoker: ausente (ou seja, false)
--
-- ZERO DML: nenhuma linha de dado a reverter nos dois sentidos.

alter view public.vw_fluxo_pagamentos_monitor set (security_invoker = false);

grant insert, update, delete, truncate, references, trigger
  on public.vw_fluxo_pagamentos_monitor to authenticated;
grant insert, update, delete, truncate, references, trigger
  on public.vw_fluxo_pagamentos_monitor to service_role;

grant insert, update, delete, truncate, references, trigger
  on public.fluxo_pagamentos_execucoes to authenticated;
