-- Indices de cobertura para 21 foreign keys sem indice (advisor performance).
-- Contexto: pos-incidente 2026-08-07. Todas as tabelas sao pequenas (<= 6.4 MB);
-- criacao instantanea e sem risco. Acelera joins e checagens de integridade.
create index if not exists idx_historico_operacional_aluno_id on public.historico_operacional (aluno_id);
create index if not exists idx_pagamentos_aluno_id on public.pagamentos (aluno_id);
create index if not exists idx_calibragem_auditoria_simulacao_id on public.calibragem_auditoria (simulacao_id);
create index if not exists idx_links_pagamento_historico_link_id on public.links_pagamento_historico (link_id);
create index if not exists idx_importacoes_substitui_importacao_id on public.importacoes (substitui_importacao_id);
create index if not exists idx_historico_operador_projecao_pagamento_id on public.historico_operador_projecao (pagamento_id);
create index if not exists idx_elogios_atendimento_aluno_id on public.elogios_atendimento (aluno_id);
create index if not exists idx_fin_transacoes_extrato_id on public.fin_transacoes (extrato_id);
create index if not exists idx_fin_saldos_diarios_extrato_id on public.fin_saldos_diarios (extrato_id);
create index if not exists idx_conferencia_pagamentos_aluno_id on public.conferencia_pagamentos (aluno_id);
create index if not exists idx_casos_fixados_aluno_id on public.casos_fixados (aluno_id);
create index if not exists idx_fin_extratos_importados_conta_id on public.fin_extratos_importados (conta_id);
create index if not exists idx_operador_agenda_atendimento_id on public.operador_agenda (atendimento_id);
create index if not exists idx_fech_remun_pagamento_fechamento_id on public.fechamento_remuneracao_pagamento (fechamento_id);
create index if not exists idx_borderos_importacao_id on public.borderos (importacao_id);
create index if not exists idx_comercial_aluno_id on public.comercial (aluno_id);
create index if not exists idx_juridico_aluno_id on public.juridico (aluno_id);
create index if not exists idx_validacoes_operacionais_aluno_id on public.validacoes_operacionais (aluno_id);
create index if not exists idx_fech_remun_linha_fechamento_id on public.fechamento_remuneracao_linha (fechamento_id);
create index if not exists idx_fech_remun_faixa_fechamento_id on public.fechamento_remuneracao_faixa (fechamento_id);
create index if not exists idx_borderos_aluno_id on public.borderos (aluno_id);
