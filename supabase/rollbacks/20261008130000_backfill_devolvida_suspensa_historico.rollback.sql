-- ROLLBACK do backfill 20261008130000.
--
-- Este e o unico rollback desta frente que REVERTE DADO, e ele pode, porque o
-- backfill guardou a linha inteira em jsonb antes de escrever. PITR nao esta
-- habilitado neste projeto: a reversao e por id exato a partir do backup, nunca
-- por restore.
--
-- Reverte SO as linhas do lote `backfill_20261008130000`. Nao toca em nada que
-- a tabulacao ao vivo tenha marcado depois -- quem veio pelo gatilho tem
-- `efeito_sem_pagamento_por` com e-mail de gestao, nao a marca do backfill.

do $reverter$
declare
  c_lote text := 'backfill_20261008130000';
  v_parc int := 0; v_tit int := 0; v_n int;
begin
  select count(*) into v_n
    from public._backup_backfill_efeito_sem_pagamento where lote = c_lote;
  if v_n = 0 then
    raise notice 'rollback backfill: lote % nao tem backup. Nada a reverter.', c_lote;
    return;
  end if;

  -- ---- PARCELAS: volta status e limpa o efeito -----------------------------
  -- O status volta do SNAPSHOT, nao recalculado por vencimento: se a parcela
  -- era VENCIDA, volta VENCIDA. Reconstruir por data poderia devolve-la como
  -- A_VENCER e mudar criticidade de um caso que ninguem pediu para mudar.
  with b as (
    select registro_id, snapshot from public._backup_backfill_efeito_sem_pagamento
     where lote = c_lote and tabela = 'parcelas'
  ), upd as (
    update public.parcelas p
       set status = b.snapshot->>'status',
           efeito_sem_pagamento = null,
           efeito_sem_pagamento_origem = null,
           efeito_sem_pagamento_por = null,
           efeito_sem_pagamento_em = null,
           observacao = b.snapshot->>'observacao',
           atualizado_em = now()
      from b
     where p.id = b.registro_id
       -- so reverte o que ainda esta como o backfill deixou
       and p.efeito_sem_pagamento_por = 'backfill 08/10/2026 (gestao)'
    returning p.id)
  select count(*) into v_parc from upd;

  -- ---- TITULOS: o encerramento administrativo e TERMINAL por gatilho -------
  -- Sem este set_config o UPDATE e revertido em silencio por
  -- `_titulo_encerrado_administrativo_protegido`, que grava a recusa em
  -- public.auditoria e devolve a linha para CANCELADA.
  perform set_config('conferencia_prime.decisao', 'on', true);

  with b as (
    select registro_id, snapshot from public._backup_backfill_efeito_sem_pagamento
     where lote = c_lote and tabela = 'acordos_titulos'
  ), upd as (
    update public.acordos_titulos t
       set situacao = b.snapshot->>'situacao',
           status   = b.snapshot->>'status',
           origem_encerramento = null,
           origem_encerramento_ref = null,
           origem_encerramento_em = null,
           motivo_ajuste = b.snapshot->>'motivo_ajuste',
           atualizado_em = now()
      from b
     where t.id = b.registro_id
       and t.origem_encerramento_ref like 'backfill:' || c_lote || '%'
    returning t.id)
  select count(*) into v_tit from upd;

  perform set_config('conferencia_prime.decisao', 'off', true);

  -- ---- AUDITORIA ----------------------------------------------------------
  delete from public.parcela_efeito_sem_pagamento_auditoria
   where executado_por = 'backfill 08/10/2026 (gestao)';

  -- ---- O MOTOR DECIDE A SITUACAO, nao este arquivo ------------------------
  perform public.recalcular_situacao_aluno(a.aluno_id, 'rollback_' || c_lote)
     from (select distinct aluno_id from public._backup_backfill_efeito_sem_pagamento
            where lote = c_lote and aluno_id is not null) a;

  raise notice 'rollback backfill: % parcela(s) e % titulo(s) revertidos do lote %.',
    v_parc, v_tit, c_lote;

  -- O BACKUP FICA. Ele e a evidencia de que o lote existiu e de qual era o
  -- estado anterior. Para remove-lo, depois de conferir a reversao:
  --   delete from public._backup_backfill_efeito_sem_pagamento where lote = 'backfill_20261008130000';
end
$reverter$;
