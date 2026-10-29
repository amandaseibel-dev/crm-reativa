-- Rastreamento das tratativas: registra quando e quem mudou o status.
alter table public.sugestoes
  add column if not exists status_em timestamptz,
  add column if not exists status_por text;
