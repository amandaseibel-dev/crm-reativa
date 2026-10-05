-- G2 -- RECONGELA O LOTE HISTORICO EM 489. SO AS CONSTANTES DAS GUARDAS.
--
-- Em 03/10/2026 a previa de mensalidade_reconciliar_pago_sem_lastro(false)
-- abortou em G1: "489 titulos, esperado 491". A guarda fez o que foi desenhada
-- para fazer -- recusou trabalhar sobre populacao diferente da autorizada.
--
-- CAUSA, provada e benigna: os 2 titulos do acordo 3108 (documentos 4262103 de
-- R$ 797,31 e 4262104 de R$ 797,30) SAIRAM DO LOTE PORQUE O ALUNO PAGOU. A
-- ultima parcela do acordo foi paga em 01/10/2026 21:00 BRT, o gatilho
-- _acordo_fecha_com_a_ultima_parcela levou o acordo a QUITADO em 02/10 16:12
-- BRT, e hoje ele tem 3 parcelas com ZERO vivas. A quitacao dessas duas
-- mensalidades passou a ter LASTRO REAL: elas deixaram de ser "PAGO sem lastro"
-- e sairam pela porta certa. Ficam FORA do lote, por decisao da gestao.
--
-- A aritmetica fecha exatamente:
--   489 + 2 = 491
--   R$ 829.542,26 + R$ 1.594,61 = R$ 831.136,87
--
-- LOTE NOVO (recongelado em 03/10/2026):
--   489 titulos | 144 alunos | 144 acordos | R$ 829.542,26
--   hash do conjunto de ids: dabc3737726912c348124edd876e874f
--   489 vinculos vivos | 144 acordos com parcela viva
--
-- ESCOPO: troca SO as constantes das guardas e das mensagens. NAO toca o
-- criterio da populacao, a logica de saneamento, a regra futura nem qualquer
-- outra funcao. Feito por PATCH ANCORADO em 12 trechos, cada um conferido como
-- OCORRENCIA UNICA antes da troca; ao fim, nenhuma constante antiga pode
-- sobrar no corpo. Idempotencia pelo texto NOVO.
--
-- Os 12 trechos cobrem exatamente as 12 ocorrencias de "491", as 6 de "145",
-- as 2 de "831136.87" e a unica do hash que existem no corpo -- conferido em
-- producao antes de escrever este patch (prosrc md5 63472ca671633ab213af26d8ed971aa1,
-- 12.058 bytes).

do $$
declare
  v_src text; v_novo text; v_a text; v_t text; i int; v_n int;
  v_anc text[] := array[
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
  v_tro text[] := array[
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
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'mensalidade_reconciliar_pago_sem_lastro'
     and pg_get_function_identity_arguments(p.oid) = 'p_confirmar boolean';

  if v_src is null then
    raise exception 'ABORTADO: mensalidade_reconciliar_pago_sem_lastro(boolean) nao encontrada';
  end if;

  -- Idempotencia pelo texto NOVO: se a primeira troca ja esta no corpo, sai.
  if strpos(v_src, v_tro[1]) > 0 then
    raise notice 'lote ja esta recongelado em 489 -- nada a fazer';
    return;
  end if;

  v_novo := v_src;

  for i in 1 .. array_length(v_anc, 1) loop
    v_a := v_anc[i];
    v_t := v_tro[i];

    -- Contagem sem regex (escape de regex em string literal e o que ja quebrou
    -- antes neste projeto): comprimento antes menos comprimento sem o trecho.
    v_n := (length(v_novo) - length(replace(v_novo, v_a, ''))) / length(v_a);

    if v_n <> 1 then
      raise exception 'ABORTADO: ancora % aparece % vezes, esperado exatamente 1', i, v_n;
    end if;

    v_novo := replace(v_novo, v_a, v_t);
  end loop;

  -- Nenhuma constante do lote antigo pode sobrar. As 12 ancoras cobrem TODAS as
  -- ocorrencias; se sobrar alguma, o corpo divergiu do que foi auditado.
  if strpos(v_novo, '491') > 0 then
    raise exception 'ABORTADO: sobrou "491" no corpo';
  end if;
  if strpos(v_novo, '145') > 0 then
    raise exception 'ABORTADO: sobrou "145" no corpo';
  end if;
  if strpos(v_novo, '831136.87') > 0 then
    raise exception 'ABORTADO: sobrou "831136.87" no corpo';
  end if;
  if strpos(v_novo, '5178651c5f5af0d68e9757c1af5bc296') > 0 then
    raise exception 'ABORTADO: sobrou o hash antigo no corpo';
  end if;

  -- E as novas tem de estar todas presentes.
  if strpos(v_novo, '489') = 0 or strpos(v_novo, '144') = 0
     or strpos(v_novo, '829542.26') = 0
     or strpos(v_novo, 'dabc3737726912c348124edd876e874f') = 0 then
    raise exception 'ABORTADO: constante nova ausente apos as trocas';
  end if;

  execute v_novo;
end $$;

comment on function public.mensalidade_reconciliar_pago_sem_lastro(boolean) is
  'Saneamento do lote G2. LOTE RECONGELADO em 03/10/2026: 489 titulos / 144 alunos / 144 acordos / R$ 829.542,26, hash dabc3737726912c348124edd876e874f. Os 2 titulos do acordo 3108 sairam do lote porque o aluno PAGOU (ultima parcela em 01/10 21:00, acordo QUITADO em 02/10 16:12, zero parcela viva) -- a quitacao deles passou a ter lastro real. p_confirmar=false devolve a previa sem escrever. Grava proveniencia retroativa ACORDO_QUITADO com o _em do evento causal real e delega a decisao a titulo_reabrir_quitacao_por_acordo. Onze guardas de abertura e dez pos-condicoes; qualquer divergencia aborta a transacao inteira. NAO EXECUTADA com p_confirmar=true.'
