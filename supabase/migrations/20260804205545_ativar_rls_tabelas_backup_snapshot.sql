-- Ativa RLS nas 28 tabelas de backup/revert/snapshot que estavam com RLS desabilitado
-- (advisor: rls_disabled_in_public). SEM criar policies = deny-all para anon/authenticated,
-- replicando o padrao ja usado em projecao_snapshot/tv_snapshot/etc.
-- Acesso via RPC SECURITY DEFINER e service_role NAO e afetado -> zero impacto operacional.

alter table public._backup_casos_pre_calibragem_20260730 enable row level security;
alter table public._backup_acordos_recon_63fbaa7b enable row level security;
alter table public._backup_casos_orfaos_20260803 enable row level security;
alter table public._backup_parcelas_ajuste_arred enable row level security;
alter table public._backup_link_baixa_fila_alunos_20260731 enable row level security;
alter table public._backup_link_baixa_fila_casos_20260731 enable row level security;
alter table public.relatorio_mens_2026_1_snapshot enable row level security;
alter table public._backup_acordos_dup_20260801 enable row level security;
alter table public._backup_parcelas_dup_20260801 enable row level security;
alter table public._backup_confirmacoes_orfaos_20260803 enable row level security;
alter table public._backup_merge_aluno_dup_20260803_alunos enable row level security;
alter table public._backup_merge_aluno_dup_20260803_acordos enable row level security;
alter table public._backup_merge_aluno_dup_20260803_fila enable row level security;
alter table public._backup_merge_aluno_dup_20260803_movs enable row level security;
alter table public._backup_completar_parcelas_lote enable row level security;
alter table public._backup_corrigir_quitado_saldo enable row level security;
alter table public._backup_reconc_baixados_pagos_20260730_casos enable row level security;
alter table public._backup_reconciliacao_pagos_20260730 enable row level security;
alter table public._backup_reconc_baixados_pagos_20260730_solic enable row level security;
alter table public._backup_reconc_baixados_pagos_20260730_alunos enable row level security;
alter table public._backup_reconc_pagos_baixa_20260730_alunos enable row level security;
alter table public._backup_reconc_pagos_baixa_20260730_casos enable row level security;
alter table public._revert_alvo_137_20260730 enable row level security;
alter table public._backup_revert_baixa_falsa_20260730 enable row level security;
alter table public._backup_pagamentos_borges_20260730 enable row level security;
alter table public._backup_acordo_em_dia_20260803 enable row level security;
alter table public._backup_acordo_em_dia_criticidade_20260803 enable row level security;
alter table public._backup_fidelizacao_expirada_20260803 enable row level security;
