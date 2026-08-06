-- Observação da tratativa: resposta/registro da gestão em cada sugestão.
alter table public.sugestoes
  add column if not exists observacao_tratativa text;
