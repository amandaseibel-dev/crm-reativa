-- ============================================================================
-- ROLLBACK: CONGELAR REDISTRIBUIÇÕES (item 1 Calibragem)
-- ----------------------------------------------------------------------------
-- Reverte o congelamento:
--   1) Reconcede EXECUTE das RPCs ao papel authenticated (estado original)
--   2) Reagenda o cron nivelamento_diario_carteira (30 3 * * *) — só em prod
--   3) Marca a flag redistribuicao_congelada = false
--
-- OBS.: os grants originais eram:
--   authenticated=X (execute) em todas as 4 funções.
-- ============================================================================

begin;

-- 1) Reconceder EXECUTE ao authenticated -------------------------------------
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
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

-- 2) Reagendar o job noturno (apenas onde há pg_cron = prod) ------------------
do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    if not exists (select 1 from cron.job where jobname='nivelamento_diario_carteira') then
      perform cron.schedule(
        'nivelamento_diario_carteira',
        '30 3 * * *',
        'SELECT public.job_nivelamento_diario();'
      );
    end if;
  end if;
end $$;

-- 3) Liberar a flag ----------------------------------------------------------
update public.calibragem_flags
   set valor = false,
       observacao = 'Congelamento revertido via rollback.',
       atualizado_em = now(),
       atualizado_por = 'rollback:20260730220000_congelar_redistribuicao_calibragem'
 where chave = 'redistribuicao_congelada';

commit;
