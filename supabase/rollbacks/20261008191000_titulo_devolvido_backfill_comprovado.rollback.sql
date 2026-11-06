-- ROLLBACK de 20261008191000_titulo_devolvido_backfill_comprovado.sql
--
-- PITR NAO esta habilitado neste projeto, entao a reversao e por ID EXATO a
-- partir do snapshot jsonb gravado em `_backup_backfill_efeito_sem_pagamento`.
-- Nenhum DELETE: so UPDATE de volta aos valores do snapshot, linha por linha.
--
-- A CHAVE `conferencia_prime.decisao` E OBRIGATORIA aqui. Os titulos revertidos
-- tem `origem_encerramento` preenchido, logo
-- `_titulo_encerrado_administrativo_protegido` engata e restauraria `old` --
-- isto e, impediria a propria reversao, em silencio.
--
-- Reverte os DOIS lotes, na ordem inversa da aplicacao:
--   reparo_devolvido_20261008190000  -- Parte B (titulos e parcelas)
--   relabel_devolvido_20261008190000 -- Parte A (os 19 rotulos)
--
-- O que este rollback NAO desfaz, de proposito:
--   * as linhas de `parcela_efeito_sem_pagamento_auditoria` e de
--     `aluno_movimentacoes` criadas pelo reparo. Sao trilha: apagar registro de
--     que a operacao aconteceu seria pior do que manter;
--   * o `status_jornada` do aluno. Ele estava na tabulacao ANTES do reparo (foi
--     justamente por isso que ele entrou no alvo), entao nao ha o que devolver.

-- ---------------------------------------------------------------------------
-- 0. o que existe para reverter
-- ---------------------------------------------------------------------------
do $inventario$
declare r record;
begin
  for r in
    select lote, tabela, count(*) as linhas
      from public._backup_backfill_efeito_sem_pagamento
     where lote in ('reparo_devolvido_20261008190000','relabel_devolvido_20261008190000')
     group by lote, tabela order by lote, tabela
  loop
    raise notice 'rollback: lote % / % -- % linha(s) em backup.', r.lote, r.tabela, r.linhas;
  end loop;
  if not exists (select 1 from public._backup_backfill_efeito_sem_pagamento
                  where lote in ('reparo_devolvido_20261008190000','relabel_devolvido_20261008190000')) then
    raise notice 'rollback: nenhum backup dos dois lotes. Nada a reverter.';
  end if;
end
$inventario$;

-- ---------------------------------------------------------------------------
-- 1. PARTE B primeiro (ordem inversa)
-- ---------------------------------------------------------------------------
do $reverte_b$
declare
  c_lote text := 'reparo_devolvido_20261008190000';
  v_tit int := 0; v_parc int := 0;
begin
  if not exists (select 1 from public._backup_backfill_efeito_sem_pagamento where lote = c_lote) then
    raise notice 'rollback B: lote % ausente. Pulado.', c_lote;
    return;
  end if;

  perform set_config('conferencia_prime.decisao', 'on', true);
  perform set_config('parcela_efeito_sem_pagamento.aplicando', 'on', true);

  with b as (
    select registro_id, snapshot
      from public._backup_backfill_efeito_sem_pagamento
     where lote = c_lote and tabela = 'acordos_titulos'
  ), u as (
    update public.acordos_titulos t
       set situacao = b.snapshot->>'situacao',
           status   = b.snapshot->>'status',
           origem_encerramento     = b.snapshot->>'origem_encerramento',
           origem_encerramento_ref = b.snapshot->>'origem_encerramento_ref',
           origem_encerramento_em  = (b.snapshot->>'origem_encerramento_em')::timestamptz,
           motivo_ajuste = b.snapshot->>'motivo_ajuste',
           atualizado_em = now()
      from b where t.id = b.registro_id
    returning t.id)
  select count(*) into v_tit from u;

  with b as (
    select registro_id, snapshot
      from public._backup_backfill_efeito_sem_pagamento
     where lote = c_lote and tabela = 'parcelas'
  ), u as (
    update public.parcelas p
       set status = b.snapshot->>'status',
           efeito_sem_pagamento        = b.snapshot->>'efeito_sem_pagamento',
           efeito_sem_pagamento_origem = b.snapshot->>'efeito_sem_pagamento_origem',
           efeito_sem_pagamento_por    = b.snapshot->>'efeito_sem_pagamento_por',
           efeito_sem_pagamento_em     = (b.snapshot->>'efeito_sem_pagamento_em')::timestamptz,
           observacao = b.snapshot->>'observacao',
           atualizado_em = now()
      from b where p.id = b.registro_id
    returning p.id)
  select count(*) into v_parc from u;

  perform set_config('conferencia_prime.decisao', '', true);
  perform set_config('parcela_efeito_sem_pagamento.aplicando', '', true);

  -- CONFERENCIA: nenhuma linha do lote pode ter ficado DEVOLVIDO
  if exists (
    select 1 from public._backup_backfill_efeito_sem_pagamento b
      join public.acordos_titulos t on t.id = b.registro_id
     where b.lote = c_lote and b.tabela = 'acordos_titulos'
       and upper(coalesce(t.situacao,'')) = 'DEVOLVIDO') then
    raise exception 'rollback B: algum titulo seguiu DEVOLVIDO -- a reversao foi barrada em silencio. Abortado.';
  end if;

  raise notice 'rollback B OK -- % titulo(s) e % parcela(s) de volta ao snapshot.', v_tit, v_parc;
end
$reverte_b$;

-- ---------------------------------------------------------------------------
-- 2. PARTE A: os 19 rotulos voltam a CANCELADA
-- ---------------------------------------------------------------------------
do $reverte_a$
declare
  c_lote text := 'relabel_devolvido_20261008190000';
  v_tit int := 0;
begin
  if not exists (select 1 from public._backup_backfill_efeito_sem_pagamento where lote = c_lote) then
    raise notice 'rollback A: lote % ausente. Pulado.', c_lote;
    return;
  end if;

  perform set_config('conferencia_prime.decisao', 'on', true);

  with b as (
    select registro_id, snapshot
      from public._backup_backfill_efeito_sem_pagamento
     where lote = c_lote and tabela = 'acordos_titulos'
  ), u as (
    update public.acordos_titulos t
       set situacao = b.snapshot->>'situacao',
           status   = b.snapshot->>'status',
           motivo_ajuste = b.snapshot->>'motivo_ajuste',
           atualizado_em = now()
      from b where t.id = b.registro_id
    returning t.id)
  select count(*) into v_tit from u;

  perform set_config('conferencia_prime.decisao', '', true);

  if exists (
    select 1 from public._backup_backfill_efeito_sem_pagamento b
      join public.acordos_titulos t on t.id = b.registro_id
     where b.lote = c_lote and b.tabela = 'acordos_titulos'
       and upper(coalesce(t.situacao,'')) <> 'CANCELADA') then
    raise exception 'rollback A: algum dos 19 nao voltou a CANCELADA. Abortado.';
  end if;

  raise notice 'rollback A OK -- % titulo(s) de volta a CANCELADA.', v_tit;
end
$reverte_a$;

-- ---------------------------------------------------------------------------
-- 3. os 29 da Conferencia Prime nunca foram tocados, nem na ida nem na volta
-- ---------------------------------------------------------------------------
do $confere$
declare v_qtd int;
begin
  select count(*) into v_qtd
    from public.acordos_titulos
   where origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA'
     and upper(coalesce(situacao,'')) = 'CANCELADA';
  raise notice 'rollback: Conferencia Prime segue com % titulo(s) CANCELADA.', v_qtd;
end
$confere$;
