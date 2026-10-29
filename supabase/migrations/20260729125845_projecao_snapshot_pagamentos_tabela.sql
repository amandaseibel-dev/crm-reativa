-- =============================================================================
-- Detalhe dos pagamentos por dia (snapshot separado do payload principal).
-- Preenchido SOMENTE no clique de "Atualizar projecao" (mesma execucao atomica).
-- Leitura paginada por RPC com validacao de escopo. Sem PII sensivel (sem CPF,
-- sem telefone). RLS deny-all: acesso somente via RPC SECURITY DEFINER.
-- =============================================================================
create table if not exists public.projecao_snapshot_pagamentos (
  mes_referencia                 text not null,
  data_pagamento                 date not null,
  operador_email                 text not null,   -- email lower do operador ou 'SEM_OPERADOR'
  pagamento_id                   uuid not null,
  aluno_nome                     text,
  valor_pago                     numeric,
  valor_honorario                numeric,
  importacao_id                  uuid,            -- origem/importacao
  operador_ajustado_manualmente  boolean,         -- indicacao de alteracao de operador (Fernanda)
  atualizado_em                  timestamptz,
  primary key (mes_referencia, pagamento_id)
);

create index if not exists ix_proj_snap_pag_lookup
  on public.projecao_snapshot_pagamentos (mes_referencia, operador_email, data_pagamento, pagamento_id);

alter table public.projecao_snapshot_pagamentos enable row level security;
-- sem policies => nenhum acesso direto por PostgREST; somente via RPCs definer.
