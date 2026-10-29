-- ROLLBACK de 20260922300000_saneamento_dupla_baixa_historica.sql
--
-- Devolve as 10 baixas saneadas ao estado exato de antes: `devolvido_em` nulo,
-- `status_baixa = 'REALIZADA'`, `motivo_devolucao` e `devolvido_por_email`
-- nulos. Isto e, as 10 parcelas voltam a ter DUAS baixas vivas -- ou seja,
-- reabre a duplicidade. So faz sentido se a validacao pos-aplicacao apontar
-- que algum dos 10 casos estava mal classificado.
--
-- SEGURANCA:
--   * age por ID EXATO, os mesmos 10 da migration. Nao seleciona nada de forma
--     dinamica;
--   * so toca linha cujo `motivo_devolucao` comeca com
--     SANEAMENTO_DUPLICIDADE_HISTORICA_20260922 -- se a linha foi devolvida
--     depois por outro motivo (uma devolucao legitima de operacao), ela NAO e
--     tocada e o rollback aborta avisando;
--   * NAO toca na parcela da Maiara (e62006af-...), que nunca entrou;
--   * nao altera `parcelas`, `alunos`, `acordos`, `casos`;
--   * nenhum DELETE.
--
-- Os mesmos dois gatilhos saem de cena durante a reversao, pela mesma razao da
-- migration: `trg_notif_divergencia_cartao` mandaria aviso falso de cartao e
-- `trg_recalc_baixa` escreveria em `public.alunos`. Voltam antes do commit e
-- sao conferidos.

do $rollback$
declare
  v_alvos int; v_ok int; v_lig int;
begin
  create temporary table _san_undo (baixa_id uuid primary key) on commit drop;
  insert into _san_undo (baixa_id) values
   ('41fcfcd6-8e6d-4636-884e-694b62b0a46b'),
   ('bd2fe50e-b2e2-49a5-bf71-836dac3ccd12'),
   ('f18fc685-8ba8-4254-ab48-f65b59505af8'),
   ('b7b336d1-8cc5-4114-90ac-0e958ad05560'),
   ('9953927f-c80e-45e1-9e85-117b6a4d0fe6'),
   ('3d9cf264-c8de-43cc-af57-7424f6cfca1c'),
   ('80832d6f-b09c-40ab-9140-1e220dc1bfd6'),
   ('ec2fb7c7-5dc4-43e2-be88-00db70557018'),
   ('4f84aff9-a590-4f21-b572-90e11857c664'),
   ('c5a391ec-3f1d-4e65-b6bf-16e67f8e8cb1');

  select count(*) into v_alvos from _san_undo;
  if v_alvos <> 10 then
    raise exception 'ROLLBACK ABORTADO: a lista tem % alvos, esperados 10.', v_alvos;
  end if;

  -- so reverte o que ESTE saneamento devolveu
  select count(*) into v_ok
    from _san_undo u join public.baixas_pagamento b on b.id = u.baixa_id
   where b.devolvido_em is not null
     and coalesce(b.motivo_devolucao,'') like 'SANEAMENTO_DUPLICIDADE_HISTORICA_20260922%';
  if v_ok <> 10 then
    raise exception 'ROLLBACK ABORTADO: % de 10 linhas estao no estado esperado (devolvidas por este saneamento). Alguma pode ter sido devolvida depois por outro motivo -- confira antes.', v_ok;
  end if;

  alter table public.baixas_pagamento disable trigger trg_notif_divergencia_cartao;
  alter table public.baixas_pagamento disable trigger trg_recalc_baixa;

  update public.baixas_pagamento b
     set devolvido_em        = null,
         status_baixa        = 'REALIZADA',
         devolvido_por_email = null,
         motivo_devolucao    = null
    from _san_undo u
   where b.id = u.baixa_id;

  get diagnostics v_ok = row_count;
  if v_ok <> 10 then
    raise exception 'ROLLBACK ABORTADO: o update alcancou % linhas, esperadas 10.', v_ok;
  end if;

  alter table public.baixas_pagamento enable trigger trg_notif_divergencia_cartao;
  alter table public.baixas_pagamento enable trigger trg_recalc_baixa;

  select count(*) into v_lig
    from pg_trigger
   where tgrelid = 'public.baixas_pagamento'::regclass
     and not tgisinternal and tgenabled <> 'O';
  if v_lig <> 0 then
    raise exception 'ROLLBACK ABORTADO: % gatilho(s) ficaram desabilitados.', v_lig;
  end if;

  -- de volta a 11 duplicidades
  select count(*) into v_ok from (
    select b.parcela_id from public.baixas_pagamento b
     where b.devolvido_em is null and b.parcela_id is not null
     group by b.parcela_id having count(*) > 1) x;
  if v_ok <> 11 then
    raise exception 'ROLLBACK ABORTADO: ficaram % parcelas com duplicidade, esperadas 11.', v_ok;
  end if;

  raise notice 'ROLLBACK OK: 10 baixas restauradas, 11 duplicidades de volta.';
end;
$rollback$;
