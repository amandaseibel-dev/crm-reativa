-- ACOES MASSIVAS: ESTRUTURA DE RASTREABILIDADE (lote <-> movimentacao, previa auditavel).
--
-- So ACRESCENTA. Nada e alterado nem apagado; nenhuma linha existente e tocada:
--   * aluno_movimentacoes.lote_id (nullable): de qual lote confirmado a acao veio.
--     Registros antigos ficam NULL. O vinculo dos lotes historicos e um backfill
--     separado, com simulacao previa (supabase/aguardando_aprovacao/).
--   * acoes_massivas_lotes: filtros usados, solicitado / encontrado / selecionado,
--     previa de origem, resumo das exclusoes e a recencia usada.
--   * acoes_massivas_previas: uma linha por previa, so contadores e filtros
--     (sem CPF, sem nome). Responde "pedi 1.000 e vieram 59: por que?".
--
-- O lote aberto de 19/09 (97 alunos) NAO e tocado: nenhuma linha de
-- acoes_massivas_lotes e alterada por esta migration.

alter table public.acoes_massivas_lotes
  add column if not exists filtros          jsonb,
  add column if not exists solicitado       integer,
  add column if not exists encontrado       integer,
  add column if not exists selecionado      integer,
  add column if not exists previa_id        uuid,
  add column if not exists resumo_exclusoes jsonb,
  add column if not exists recencia_dias    integer;

create table if not exists public.acoes_massivas_previas (
  id               uuid primary key default gen_random_uuid(),
  criado_em        timestamptz not null default now(),
  criado_por_email text,
  filtros          jsonb not null,
  solicitado       integer not null,
  universo_base    integer not null,
  disponiveis      integer not null,
  elegiveis        integer not null,
  selecionado      integer not null,
  indisponiveis    integer not null,
  motivos          jsonb not null default '{}'::jsonb,
  com_responsavel  integer not null default 0,
  com_fidelizacao  integer not null default 0
);
comment on table public.acoes_massivas_previas is
  'Auditoria da previa das Acoes Massivas: filtros e contadores. Sem dado pessoal. Escrita so pela RPC acoes_massivas_previa.';

alter table public.acoes_massivas_previas enable row level security;
revoke all on table public.acoes_massivas_previas from public, anon, authenticated;
grant select, insert on table public.acoes_massivas_previas to service_role;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'acoes_massivas_lotes_previa_fk') then
    alter table public.acoes_massivas_lotes
      add constraint acoes_massivas_lotes_previa_fk
      foreign key (previa_id) references public.acoes_massivas_previas(id);
  end if;
end $$;

alter table public.aluno_movimentacoes
  add column if not exists lote_id uuid references public.acoes_massivas_lotes(id);

create index if not exists ix_aluno_mov_lote
  on public.aluno_movimentacoes (lote_id) where lote_id is not null;

comment on column public.aluno_movimentacoes.lote_id is
  'Lote de Acao Massiva confirmado que originou esta movimentacao. NULL nas demais e nas anteriores ao vinculo.';
