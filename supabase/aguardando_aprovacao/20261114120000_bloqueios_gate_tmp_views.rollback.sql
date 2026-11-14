-- ROLLBACK de 20261114120000_bloqueios_gate_tmp_views (PENDENTE, nao aplicada)
-- Restaura exatamente o estado de 14/11/2026 antes da migracao:
--   - _tmp_fila2: authenticated volta a ter ALL (era o padrao medido); anon e PUBLIC nada
--   - views: security_invoker volta ao padrao (RESET), e authenticated volta a ter
--     INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--   - policy criada no item 4 e removida
-- ZERO DML sobre dados. Nenhuma linha e tocada.
begin;

drop policy if exists pagamento_suspeita_leitura_gestao on public.pagamento_suspeita_duplicidade;

alter view public.vw_extracao_calibragem         reset (security_invoker);
alter view public.vw_extracao_observabilidade    reset (security_invoker);
alter view public.vw_extracao_validacao_trilha   reset (security_invoker);
alter view public.vw_pagamento_suspeita_pendente reset (security_invoker);
alter view public.vw_titulo_presenca_historico   reset (security_invoker);

grant insert, update, delete, truncate, references, trigger
  on public.vw_extracao_calibragem,
     public.vw_extracao_observabilidade,
     public.vw_extracao_validacao_trilha,
     public.vw_pagamento_suspeita_pendente,
     public.vw_titulo_presenca_historico
  to authenticated;

grant all on table public._tmp_fila2 to authenticated;

commit;
