-- ESTADO APOS O ROLLBACK: deve voltar ao anterior a V2.
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'nivelamento_automatico_gestao' and active
                  and schedule = '20 9 * * *') then
    raise exception 'FALHOU: job antigo nao voltou (nome, agendamento e ativo)';
  end if;
  if exists (select 1 from cron.job where jobname = 'nivelamento_v2_reposicao') then
    raise exception 'FALHOU: job V2 ainda agendado apos rollback';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname = 'nivelamento_reposicao_por_baixas') then
    raise exception 'FALHOU: funcao V2 ainda existe apos rollback';
  end if;
  -- O rollback PRINCIPAL nao reabre o gate: a funcao continua com a forma corrigida.
  if position('or auth.jwt() is null' in pg_get_functiondef(
       (select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='calibragem_teste_gate'))) > 0 then
    raise exception 'FALHOU: rollback principal reabriu o gate (deveria permanecer corrigido)';
  end if;
  if exists (select 1 from public.calibragem_parametros where chave = 'nivelamento_v2_desde') then
    raise exception 'FALHOU: corte V2 ainda gravado';
  end if;
  raise notice 'OK: rollback restaurou job 48, gate antigo e removeu a V2';
end $$;
