-- ============================================================================
-- CONGELAR REDISTRIBUIÇÕES (item 1 da evolução Calibragem)
-- ----------------------------------------------------------------------------
-- Objetivo: suspender IMEDIATAMENTE toda redistribuição automática, manual em
-- massa ou rotina que retire/transfira alunos entre operadores, até que o
-- módulo de Calibragem esteja implementado e validado.
--
-- NÃO altera a lógica da fila operacional (prioridades, criticidades,
-- permanência de 10 dias, remanejamento após o prazo). Apenas interrompe as
-- redistribuições que ocorrem FORA do futuro módulo de Calibragem.
--
-- Mecanismo (100% reversível — ver rollback):
--   1) Flag public.calibragem_flags.redistribuicao_congelada = true
--   2) REVOKE EXECUTE do papel `authenticated` nas RPCs de redistribuição
--      (bloqueia o front, que chama via JWT authenticated)
--   3) Desagendar o cron `nivelamento_diario_carteira` (só onde há pg_cron = prod)
--
-- Idempotente e seguro para staging (sem pg_cron / sem job_nivelamento_diario)
-- e prod. Guardas de existência em cada passo.
-- ============================================================================

begin;

-- 1) Flag de congelamento (também é fundação do módulo Calibragem) -----------
create table if not exists public.calibragem_flags(
  chave         text primary key,
  valor         boolean not null default false,
  observacao    text,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);

insert into public.calibragem_flags(chave, valor, observacao, atualizado_por)
values (
  'redistribuicao_congelada',
  true,
  'Congelamento item 1: toda redistribuição passa a exigir o módulo Calibragem.',
  'migration:20260730220000_congelar_redistribuicao_calibragem'
)
on conflict (chave) do update
  set valor = excluded.valor,
      observacao = excluded.observacao,
      atualizado_em = now(),
      atualizado_por = excluded.atualizado_por;

alter table public.calibragem_flags enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='calibragem_flags'
      and policyname='calibragem_flags_sel_authenticated'
  ) then
    create policy calibragem_flags_sel_authenticated
      on public.calibragem_flags for select to authenticated using (true);
  end if;
end $$;

-- 2) Revogar EXECUTE das RPCs de redistribuição do papel authenticated -------
--    (guardado por existência: cada função pode não existir em todos os ambientes)
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'redistribuir_casos_operadores',
        'redistribuir_casos_operadores_faixas',
        'nivelar_medias_progressivo',
        'job_nivelamento_diario'
      )
  loop
    -- revoga o grant amplo (PUBLIC) e os papéis do PostgREST; mantém
    -- postgres e service_role (uso administrativo/servidor).
    execute format('revoke execute on function %s from public', r.sig);
    execute format('revoke execute on function %s from authenticated', r.sig);
    execute format('revoke execute on function %s from anon', r.sig);
  end loop;
end $$;

-- 3) Desagendar o job noturno de nivelamento (apenas onde há pg_cron = prod) --
do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    if exists (select 1 from cron.job where jobname='nivelamento_diario_carteira') then
      perform cron.unschedule('nivelamento_diario_carteira');
    end if;
  end if;
end $$;

commit;
