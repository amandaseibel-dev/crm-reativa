-- ROLLBACK DO NIVELAMENTO V2 (20261112120000 + 20261112120100).
-- Restaura o estado ANTERIOR a aplicacao, a partir de public.nivelamento_v2_backup.
-- Nao apaga linhas de calibragem_auditoria (append-only): as movimentacoes V2
-- ja gravadas permanecem como trilha. Desfazer uma movimentacao V2 e manual,
-- caso a caso, por caso_id, com decisao da gestao.
--
-- ORDEM: rodar em UMA transacao. Pre-condicao: a backup existir com as
-- definicoes (se nao existir, o rollback aborta sem alterar nada).

begin;

do $$
begin
  if not exists (select 1 from public.nivelamento_v2_backup where nome = 'fn:assumir_caso_livre(uuid)') then
    raise exception 'Backup de assumir_caso_livre ausente. Rollback abortado.';
  end if;
  if not exists (select 1 from public.nivelamento_v2_backup where nome = 'cron:48') then
    raise exception 'Backup do job 48 ausente. Rollback abortado.';
  end if;
end $$;

-- 1. Gate das calibragem_* / onda1_*: restaura a definicao anterior (com o
--    "or auth.jwt() is null"). Ou seja, reverte a correcao de seguranca.
--    So execute se a gestao aprovar reverter o gate.
do $$
declare r record;
begin
  for r in select nome, definicao from public.nivelamento_v2_backup where nome like 'fn:%'
                                                                     and nome <> 'fn:assumir_caso_livre(uuid)'
                                                                     and nome <> 'fn:nivelamento_v2_gate_marker'
  loop
    execute r.definicao;
  end loop;
end $$;

-- 2. assumir_caso_livre: definicao anterior + grants anteriores.
do $$
declare v_def text;
begin
  select definicao into v_def from public.nivelamento_v2_backup where nome = 'fn:assumir_caso_livre(uuid)';
  execute v_def;
end $$;
revoke all on function public.assumir_caso_livre(uuid) from public, anon;
grant execute on function public.assumir_caso_livre(uuid) to authenticated, service_role;

-- 3. Jobs: remove a reposicao V2 e restaura o job antigo com o mesmo NOME,
--    agendamento e comando. O jobid muda: pg_cron atribui um novo id ao agendar.
--    (Nao ha como reatribuir o id 48 pelo SQL do pg_cron.)
select cron.unschedule(jobid) from cron.job where jobname = 'nivelamento_v2_reposicao';
do $$
declare v_partes text[];
begin
  select string_to_array(definicao, '|') into v_partes
    from public.nivelamento_v2_backup where nome = 'cron:48';
  -- formato: schedule|command|active  (command pode conter '|': juntar o meio)
  perform cron.schedule('nivelamento_automatico_gestao', v_partes[1],
           array_to_string(v_partes[2:array_length(v_partes,1)-1], '|'));
end $$;

-- 4. Remove funcoes V2 (nao usadas pelo estado anterior).
drop function if exists public.nivelamento_reposicao_por_baixas(int);
drop function if exists public.nivelamento_escolher_troca(uuid, text, uuid);
drop function if exists public.nivelamento_caso_movivel(uuid);
drop function if exists public.nivelamento_saldo_caso_centavos(uuid);
drop function if exists public.nivelamento_acionaveis(text);
drop function if exists public.nivelamento_ocupacao(text);

-- 5. Indices de idempotencia V2 (nao afetam dados existentes).
drop index if exists public.calibragem_auditoria_v2_baixa_uq;
drop index if exists public.calibragem_auditoria_v2_pagamento_uq;

-- 6. Corte V2.
delete from public.calibragem_parametros where chave = 'nivelamento_v2_desde';

commit;

-- Verificacao pos-rollback (job antigo ativo pelo nome, sem job V2):
--   select jobid, jobname, schedule, active from cron.job where jobname like 'nivelamento%';
--   select array_to_string(p.proacl,' ') from pg_proc p where proname = 'assumir_caso_livre';
--     -> esperado: postgres=X/postgres authenticated=X/postgres service_role=X/postgres
