-- MONITOR DO FLUXO DE PAGAMENTOS · FECHA A ESCRITA NA VIEW
--
-- SÓ PRIVILÉGIO E UMA OPÇÃO DE VIEW. Zero DML, zero DDL de objeto novo. A
-- função, a view e a lógica da rodada ficam idênticas -- nada do que a
-- 20261021195950 criou é recriado aqui.
--
-- ===========================================================================
-- O DEFEITO, medido em 21/10/2026 logo depois de aplicar a 20261021195950
-- ===========================================================================
--
-- A view nasceu com `authenticated=arwdDxtm`, não com o `select` que a migration
-- pediu. O `grant select` não "apertou" nada: o default do schema public já
-- havia dado tudo. Mesma causa raiz do achado de 20260930232237 (tabela nova
-- herda TRUNCATE para authenticated) -- é o default do schema, não um grant
-- escrito por engano.
--
-- Por que isso não era inofensivo, medido e não suposto:
--
--   pg_relation_is_updatable(view) = 28  -> aceita DELETE e UPDATE
--   has_table_privilege(authenticated, 'delete') = true
--   a view NÃO era security_invoker -> executava com o dono (postgres)
--   fluxo_pagamentos_execucoes tem relrowsecurity = true
--
-- Juntando: qualquer usuário logado poderia apagar linha da trilha de
-- monitoramento ATRAVÉS da view, e o RLS da tabela base não o barraria, porque
-- a view rodava como o dono. Não alcança dado financeiro -- a view só expõe
-- `fluxo_pagamentos_execucoes` -- mas apagar o monitoramento é apagar a prova
-- do que a automação fez.
--
-- ===========================================================================
-- AS TRÊS CAMADAS QUE ESTA MIGRATION PÕE, e por que nenhuma basta sozinha
-- ===========================================================================
--
--   1. REVOGA a escrita na view para `authenticated`. Sozinho não bastaria:
--      o default do schema voltaria a valer para QUALQUER view nova.
--   2. `security_invoker = true`: a leitura passa a valer-se das permissões e
--      do RLS de QUEM CHAMA, em vez das do dono. Sozinho não bastaria: o grant
--      de escrita continuaria lá, e bastaria uma política de UPDATE nascer um
--      dia para a porta reabrir.
--   3. REVOGA a escrita na TABELA BASE para `authenticated`. Sozinho não
--      bastaria: a view, rodando como dono, contornaria.
--
-- ===========================================================================
-- POR QUE `security_invoker = true` NÃO CEGA O MONITORAMENTO -- conferido
-- ===========================================================================
--
-- `fluxo_pagamentos_execucoes` tem UMA política de RLS:
--
--   fluxo_exec_gestao | cmd = r (SELECT) | USING usuario_e_gestao() | authenticated
--
-- e `usuario_e_gestao()` devolve true para os três e-mails da gestão -- os
-- mesmos de `calibragem_e_gestao()`. Então, com a opção ligada:
--
--   gestão logada        LÊ (a política a aceita)
--   logado não-gestão    vê ZERO LINHAS (sem erro -- é RLS, não permissão)
--   anon                 não alcança (sem grant de select)
--   service_role         LÊ (rolbypassrls = true, conferido)
--   a própria rodada     ESCREVE (é SECURITY DEFINER de dono postgres, e
--                        relforcerowsecurity = false, então o dono não é
--                        filtrado pelo RLS ao inserir)
--
-- Não há política de UPDATE nem de DELETE. Logo, mesmo que um grant de escrita
-- reapareça por engano, o RLS passa a recusar a escrita por si -- que é
-- exatamente a defesa em profundidade que faltava.
--
-- ===========================================================================
-- O QUE NÃO FOI TOCADO, de propósito
-- ===========================================================================
--
-- `service_role` mantém os privilégios que tinha na TABELA BASE. Ele bypassa
-- RLS e é a chave do backend; estreitá-lo aqui poderia quebrar caminho de Edge
-- Function que eu não inventariei. Na VIEW, onde nada escreve, a escrita é
-- revogada dele também.
--
-- Conferido antes de escrever: os ÚNICOS que escrevem em
-- `fluxo_pagamentos_execucoes` são `fluxo_pagamentos_rodar` e
-- `fluxo_pagamentos_incremental`, ambas SECURITY DEFINER e de dono `postgres`.
-- Revogar a escrita de `authenticated` não quebra nenhuma delas.
--
-- Reversível: supabase/rollbacks/20261021213000_*.rollback.sql

-- 1. A VIEW: só leitura, e só para quem deve.
revoke all on public.vw_fluxo_pagamentos_monitor from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.vw_fluxo_pagamentos_monitor from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.vw_fluxo_pagamentos_monitor from service_role;

-- 2. A leitura passa a respeitar o RLS de quem chama.
alter view public.vw_fluxo_pagamentos_monitor set (security_invoker = true);

grant select on public.vw_fluxo_pagamentos_monitor to authenticated, service_role;

-- 3. A TABELA BASE: usuário comum não altera nem apaga registro de
--    monitoramento, nem direto nem pela view.
revoke insert, update, delete, truncate, references, trigger
  on public.fluxo_pagamentos_execucoes from authenticated;
revoke all on public.fluxo_pagamentos_execucoes from anon;

grant select on public.fluxo_pagamentos_execucoes to authenticated;
