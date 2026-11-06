-- ROLLBACK de 20261008193000_titulo_suspenso_backfill.sql
--
-- PITR NAO esta habilitado: a reversao e por ID EXATO a partir do snapshot
-- jsonb do lote `suspenso_titulo_20261008193000`. Nenhum DELETE.
--
-- A CHAVE `conferencia_prime.decisao` E OBRIGATORIA: 59 dos 246 titulos voltam
-- para EM_CONFIRMACAO, e `_titulo_em_confirmacao_protegido` RECUSA a entrada em
-- confirmacao sem ela -- levantando excecao, nao em silencio. Sem a chave este
-- rollback falharia na metade.
--
-- O que NAO e desfeito, de proposito: as linhas de
-- `parcela_efeito_sem_pagamento_auditoria` e de `aluno_movimentacoes`. Sao
-- trilha; apagar o registro de que a operacao aconteceu e pior que manter.

do $reverte$
declare
  c_lote text := 'suspenso_titulo_20261008193000';
  v_tit int := 0; v_parc int := 0; v_conf int := 0;
begin
  if not exists (select 1 from public._backup_backfill_efeito_sem_pagamento where lote = c_lote) then
    raise notice 'rollback: lote % ausente. Nada a reverter.', c_lote;
    return;
  end if;

  perform set_config('conferencia_prime.decisao', 'on', true);
  perform set_config('parcela_efeito_sem_pagamento.aplicando', 'on', true);

  -- ---- titulos: volta situacao, status e limpa as colunas de suspensao ----
  with b as (
    select registro_id, snapshot
      from public._backup_backfill_efeito_sem_pagamento
     where lote = c_lote and tabela = 'acordos_titulos'
  ), u as (
    update public.acordos_titulos t
       set situacao = b.snapshot->>'situacao',
           status   = b.snapshot->>'status',
           suspensao_situacao_anterior = b.snapshot->>'suspensao_situacao_anterior',
           suspensao_status_anterior   = b.snapshot->>'suspensao_status_anterior',
           suspensao_origem            = b.snapshot->>'suspensao_origem',
           suspensao_em                = (b.snapshot->>'suspensao_em')::timestamptz,
           motivo_ajuste = b.snapshot->>'motivo_ajuste',
           atualizado_em = now()
      from b where t.id = b.registro_id
    returning t.id)
  select count(*) into v_tit from u;

  -- ---- parcelas: volta status e os campos de efeito -----------------------
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

  -- ---- CONFERENCIA --------------------------------------------------------
  if exists (
    select 1 from public._backup_backfill_efeito_sem_pagamento b
      join public.acordos_titulos t on t.id = b.registro_id
     where b.lote = c_lote and b.tabela = 'acordos_titulos'
       and upper(coalesce(t.situacao,'')) = 'SUSPENSO') then
    raise exception 'rollback: algum titulo seguiu SUSPENSO -- a reversao foi barrada. Abortado.';
  end if;

  -- os 59 tem de ter voltado para EM_CONFIRMACAO, nao para ABERTO
  select count(*) into v_conf
    from public._backup_backfill_efeito_sem_pagamento b
    join public.acordos_titulos t on t.id = b.registro_id
   where b.lote = c_lote and b.tabela = 'acordos_titulos'
     and upper(coalesce(b.snapshot->>'situacao','')) = 'EM_CONFIRMACAO'
     and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO';

  if v_conf <> (select count(*) from public._backup_backfill_efeito_sem_pagamento
                 where lote = c_lote and tabela = 'acordos_titulos'
                   and upper(coalesce(snapshot->>'situacao','')) = 'EM_CONFIRMACAO') then
    raise exception 'rollback: titulo que estava EM_CONFIRMACAO nao voltou para la. Abortado.';
  end if;

  raise notice 'rollback OK -- % titulo(s) (% de volta a EM_CONFIRMACAO) e % parcela(s) restaurados pelo snapshot.',
    v_tit, v_conf, v_parc;
end
$reverte$;
