-- ============================================================================
-- ROLLBACK da execucao 20260930_2. Determinístico, por ID, a partir do backup.
-- ============================================================================
-- Devolve as mensalidades ao estado EXATO do backup: situacao, status,
-- acordo_id e motivo_ajuste. Nao toca acordo, parcela, vinculo nem pagamento --
-- a execucao tambem nao tocou (as guardas 6.5 provaram item a item).
--
-- `titulo_liquidado_na_origem_e_terminal` e `_titulo_encerrado_administrativo_
-- protegido` sao gatilhos BEFORE UPDATE que podem barrar a volta de PAGO. Como
-- a populacao tinha origem_liquidacao e origem_encerramento NULAS (condicao de
-- elegibilidade), eles nao se aplicam aqui.
-- ============================================================================

begin;

do $$
declare v_b int; v_esperado int;
begin
  select count(*) into v_b from public._backup_negociado_quitado_20260930;
  if v_b = 0 then raise exception 'ABORTA: backup vazio ou inexistente'; end if;

  -- so volta o que a execucao de fato mexeu, e so se ainda esta como ela deixou
  select count(*) into v_esperado
    from public._backup_negociado_quitado_20260930 b
    join public.acordos_titulos t on t.id = b.titulo_id
   where upper(coalesce(t.situacao,'')) = 'PAGO';
  if v_esperado <> v_b then
    raise exception 'ABORTA: % de % titulos nao estao em PAGO -- houve mudanca depois da execucao. Conferir a mao.', v_b - v_esperado, v_b;
  end if;
end $$;

update public.acordos_titulos t
   set situacao      = b.situacao_antes,
       status        = b.status_antes,
       acordo_id     = b.acordo_id_antes,
       motivo_ajuste = b.motivo_antes,
       atualizado_em = now()
  from public._backup_negociado_quitado_20260930 b
 where t.id = b.titulo_id;

do $$
declare v_falta int;
begin
  select count(*) into v_falta
    from public._backup_negociado_quitado_20260930 b
    join public.acordos_titulos t on t.id = b.titulo_id
   where t.situacao is distinct from b.situacao_antes
      or t.status   is distinct from b.status_antes;
  if v_falta > 0 then
    raise exception 'ABORTA: % titulo(s) nao voltaram ao estado do backup', v_falta;
  end if;
  raise notice 'ROLLBACK OK: todos os titulos voltaram ao estado do backup';
end $$;

-- marca o lote como revertido; nao apaga o log (historico e auditoria ficam)
update public.mensalidade_reconciliacao_log
   set motivo = coalesce(motivo,'') || ' | REVERTIDO em ' || to_char(now(),'DD/MM/YYYY HH24:MI')
 where titulo_id in (select titulo_id from public._backup_negociado_quitado_20260930)
   and motivo not like '%REVERTIDO%';

commit;
