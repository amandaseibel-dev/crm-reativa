-- ============================================================================
-- Blocos 2 e 3 — Corrige policies amplas (fila_acordos_confirmar + 6 SELECT USING(true)).
-- Isola por gestão/carteira/dono; bloqueia anon e usuário sem perfil.
-- RESTRICTIVE painel_negado permanece (AND NOT eh_painel). Consumo mapeado no frontend:
--  conferencia_pagamentos, links_pagamento_historico, historico_casos: sem .from() ativo (só backend/RPC).
--  baixas_importadas: MinhaFilaQuitacao (tela de gestão/aprovação Amanda).
--  fila_receptivo: board de presença (exceção justificada: visível a usuário ativo).
--  fila_acordos_confirmar/acordo_titulo_vinculo: leitura por dono/gestão.
-- ============================================================================

-- 2) fila_acordos_confirmar: troca policy ampla (public/ALL) por policies por comando.
drop policy if exists fila_acordos_rw on public.fila_acordos_confirmar;
create policy fac_select on public.fila_acordos_confirmar for select to authenticated
  using (usuario_e_gestao_fila() or lower(coalesce(operador_email,'')) = app_email());
create policy fac_insert on public.fila_acordos_confirmar for insert to authenticated
  with check (app_usuario_ativo() and usuario_e_gestao_fila());
create policy fac_update on public.fila_acordos_confirmar for update to authenticated
  using (app_usuario_ativo() and usuario_e_gestao_fila())
  with check (app_usuario_ativo() and usuario_e_gestao_fila());
create policy fac_delete on public.fila_acordos_confirmar for delete to authenticated
  using (app_usuario_ativo() and usuario_e_gestao_fila());

-- 3a) conferencia_pagamentos: SELECT restrito à gestão (financeiro; sem uso direto no front).
drop policy if exists conferencia_pagamentos_select on public.conferencia_pagamentos;
create policy conferencia_pagamentos_select on public.conferencia_pagamentos for select to authenticated
  using (app_usuario_ativo() and usuario_e_gestao());

-- 3b) baixas_importadas: SELECT restrito à gestão (MinhaFilaQuitacao = aprovação Amanda; sem coluna de operador).
drop policy if exists baixas_importadas_select_authenticated on public.baixas_importadas;
create policy baixas_importadas_select_authenticated on public.baixas_importadas for select to authenticated
  using (app_usuario_ativo() and usuario_e_gestao());

-- 3c) fila_receptivo: board de presença — visível a usuário ATIVO (bloqueia anon/sem-perfil). Exceção justificada.
drop policy if exists fila_receptivo_select on public.fila_receptivo;
create policy fila_receptivo_select on public.fila_receptivo for select to authenticated
  using (app_usuario_ativo());

-- 3d) historico_casos: SELECT gestão OU próprio (por nome). Remove USING(true) e painel_negado_select permissivo.
drop policy if exists historico_casos_select on public.historico_casos;
drop policy if exists painel_negado_select on public.historico_casos;
create policy historico_casos_select on public.historico_casos for select to authenticated
  using ((not eh_painel()) and (usuario_e_gestao() or app_matches_nome(operador)));

-- 3e) links_pagamento_historico: SELECT gestão OU próprio (usuario). Remove USING(true) e painel_negado_select permissivo.
drop policy if exists links_pagamento_historico_select on public.links_pagamento_historico;
drop policy if exists painel_negado_select on public.links_pagamento_historico;
create policy links_pagamento_historico_select on public.links_pagamento_historico for select to authenticated
  using ((not eh_painel()) and (usuario_e_gestao() or lower(coalesce(usuario,'')) = app_email()));

-- 3f) acordo_titulo_vinculo: SELECT gestão OU dono do acordo (alinha com INSERT/UPDATE/DELETE existentes).
drop policy if exists atv_select on public.acordo_titulo_vinculo;
create policy atv_select on public.acordo_titulo_vinculo for select to authenticated
  using (usuario_e_gestao() or app_owns_acordo(acordo_id));
