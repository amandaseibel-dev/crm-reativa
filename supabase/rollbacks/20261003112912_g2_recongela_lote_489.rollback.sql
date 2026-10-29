-- ============================================================================
-- ROLLBACK de 20261003112912 -- devolve as guardas ao lote de 491.
-- ============================================================================
-- Troca de volta SO as constantes: 489->491, 144->145, 829542.26->831136.87 e o
-- hash dabc3737...->5178651c.... Mesmo patch ancorado, na direcao inversa.
--
-- USAR ISTO SO FAZ SENTIDO se o recongelamento tiver sido um erro. Se os 2
-- titulos do acordo 3108 continuam com lastro (acordo QUITADO, zero parcela
-- viva), voltar para 491 faz a previa abortar em G1 de novo -- que e exatamente
-- o estado de 03/10/2026 antes desta versao.
--
-- NAO desfaz execucao nenhuma: a rotina nunca foi chamada com p_confirmar=true.
-- ============================================================================

begin;

do $$
declare
  v_src text; v_novo text; v_a text; v_t text; i int; v_n int;
  v_anc text[] := array[
    '  if v_qtd    <> 489       then raise exception ''ABORTADO G1: % titulos, esperado 489'', v_qtd; end if;',
    '  if v_alunos <> 144       then raise exception ''ABORTADO G2: % alunos, esperado 144'', v_alunos; end if;',
    '  if v_acordos<> 144       then raise exception ''ABORTADO G3: % acordos, esperado 144'', v_acordos; end if;',
    '  if v_soma   <> 829542.26 then raise exception ''ABORTADO G4: soma %, esperado 829542.26'', v_soma; end if;',
    '  if v_hash   <> ''dabc3737726912c348124edd876e874f''',
    '  if v_vinc   <> 489       then raise exception ''ABORTADO G6: % vinculos vivos, esperado 489'', v_vinc; end if;',
    '  if v_ac_parc<> 144       then raise exception ''ABORTADO G7: % acordos com parcela viva, esperado 144'', v_ac_parc; end if;',
    '  if v_ok <> 489 then',
    '    raise exception ''ABORTADO: % titulos reabertos, esperado 489'', v_ok;',
    '  if v_mudou <> 489 then raise exception ''ABORTADO P1: % em NEGOCIADO/vinculada com trinca limpa, esperado 489'', v_mudou; end if;',
    '  if v_pago_depois <> v_pago_antes - 489 then raise exception ''ABORTADO P2: PAGO global % -> %, esperado -489'', v_pago_antes, v_pago_depois; end if;',
    '  if v_neg_depois  <> v_neg_antes  + 489 then raise exception ''ABORTADO P3: NEGOCIADO global % -> %, esperado +489'', v_neg_antes, v_neg_depois; end if;'
  ];
  v_tro text[] := array[
    '  if v_qtd    <> 491       then raise exception ''ABORTADO G1: % titulos, esperado 491'', v_qtd; end if;',
    '  if v_alunos <> 145       then raise exception ''ABORTADO G2: % alunos, esperado 145'', v_alunos; end if;',
    '  if v_acordos<> 145       then raise exception ''ABORTADO G3: % acordos, esperado 145'', v_acordos; end if;',
    '  if v_soma   <> 831136.87 then raise exception ''ABORTADO G4: soma %, esperado 831136.87'', v_soma; end if;',
    '  if v_hash   <> ''5178651c5f5af0d68e9757c1af5bc296''',
    '  if v_vinc   <> 491       then raise exception ''ABORTADO G6: % vinculos vivos, esperado 491'', v_vinc; end if;',
    '  if v_ac_parc<> 145       then raise exception ''ABORTADO G7: % acordos com parcela viva, esperado 145'', v_ac_parc; end if;',
    '  if v_ok <> 491 then',
    '    raise exception ''ABORTADO: % titulos reabertos, esperado 491'', v_ok;',
    '  if v_mudou <> 491 then raise exception ''ABORTADO P1: % em NEGOCIADO/vinculada com trinca limpa, esperado 491'', v_mudou; end if;',
    '  if v_pago_depois <> v_pago_antes - 491 then raise exception ''ABORTADO P2: PAGO global % -> %, esperado -491'', v_pago_antes, v_pago_depois; end if;',
    '  if v_neg_depois  <> v_neg_antes  + 491 then raise exception ''ABORTADO P3: NEGOCIADO global % -> %, esperado +491'', v_neg_antes, v_neg_depois; end if;'
  ];
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'mensalidade_reconciliar_pago_sem_lastro'
     and pg_get_function_identity_arguments(p.oid) = 'p_confirmar boolean';

  if v_src is null then
    raise exception 'ABORTADO: mensalidade_reconciliar_pago_sem_lastro(boolean) nao encontrada';
  end if;

  if strpos(v_src, v_tro[1]) > 0 then
    raise notice 'guardas ja estao em 491 -- nada a fazer';
    return;
  end if;

  v_novo := v_src;

  for i in 1 .. array_length(v_anc, 1) loop
    v_a := v_anc[i];
    v_t := v_tro[i];
    v_n := (length(v_novo) - length(replace(v_novo, v_a, ''))) / length(v_a);
    if v_n <> 1 then
      raise exception 'ABORTADO: ancora % aparece % vezes, esperado exatamente 1', i, v_n;
    end if;
    v_novo := replace(v_novo, v_a, v_t);
  end loop;

  if strpos(v_novo, '489') > 0 then raise exception 'ABORTADO: sobrou "489" no corpo'; end if;
  if strpos(v_novo, '144') > 0 then raise exception 'ABORTADO: sobrou "144" no corpo'; end if;
  if strpos(v_novo, '829542.26') > 0 then raise exception 'ABORTADO: sobrou "829542.26" no corpo'; end if;
  if strpos(v_novo, 'dabc3737726912c348124edd876e874f') > 0 then raise exception 'ABORTADO: sobrou o hash de 489'; end if;

  execute v_novo;
end $$;

comment on function public.mensalidade_reconciliar_pago_sem_lastro(boolean) is
  'Saneamento do lote G2 (491 titulos PAGO com acordo ATIVO, hash 5178651c5f5af0d68e9757c1af5bc296). p_confirmar=false devolve a previa sem escrever. Grava proveniencia retroativa ACORDO_QUITADO com o _em do evento causal real e delega a decisao a titulo_reabrir_quitacao_por_acordo. Onze guardas de abertura e dez pos-condicoes; qualquer divergencia aborta a transacao inteira. CRIADA EM 01/10/2026, NAO EXECUTADA.';

commit;
