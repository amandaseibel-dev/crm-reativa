drop trigger if exists trg_pagamento_matricula on public.pagamentos;
drop function if exists public._pagamento_matricula_do_arquivo();
drop index if exists public.idx_pagamentos_matricula;
alter table public.pagamentos drop column if exists matricula;
