-- Quem ja quitou pelo extrato sai do relatorio de jan-jun.
--
-- Amanda, 31/08: "retire o [que] entrou de pagamento pelo extrato Santander e
-- atualize" e, escolhendo entre os dois cortes medidos, "tire 91 casos".
--
-- O DEFEITO. O relatorio ja excluia quem tem confirmacao pendente, quem tem
-- mensalidade vinculada a acordo e quem negociou pela Prime -- mas nao olhava o
-- DINHEIRO QUE ENTROU. Resultado: 203 pessoas que pagaram R$ 417.210,58 desde
-- julho seguiam contando como divida aberta de jan-jun.
--
-- A REGRA ESCOLHIDA. Sai quem pagou pelo menos o que deve no recorte -- nao quem
-- pagou qualquer coisa. A diferenca entre os dois cortes sao 111 pessoas que
-- pagaram PARTE: no corte largo elas sumiriam inteiras, ainda devendo o resto.
--
--   sem corte                            1.926 CPFs   R$ 7.171.446,21
--   corte largo (pagou qualquer valor)   1.724 CPFs   R$ 6.710.354,55   -202
--   ESCOLHIDO (pagou >= o que deve)      1.835 CPFs   R$ 7.004.322,81    -91
--
-- Coerente com a premissa da casa: "pago so com saldo zerado". Quem pagou parte
-- continua no relatorio com o que ainda deve, que e a verdade.
--
-- POR QUE NAO O CORTE LARGO: e o mesmo formato de exclusao que, na manha do
-- mesmo dia, escondeu R$ 7,9 milhoes da fila de conferencia -- tirar a pessoa
-- inteira por causa de um sinal parcial.
--
-- JANELA 01/07/2026 em diante, que e desde quando `pagamentos` tem o extrato.
-- Junho ainda nao foi importado; quando for, esta conta melhora sozinha -- e por
-- isso junho e hoje o mes mais inflado do relatorio.
--
-- ATENCAO AO HISTORICO: isto muda a REGUA. O numero do dia deixa de ser
-- diretamente comparavel com os anteriores da serie. Tentei marcar a captura
-- como 'captura_regua_nova' e a tabela recusou -- o CHECK de `origem` so aceita
-- 'captura' e 'reconstruido'. Fica registrado aqui.
--
-- DESFAZER: supabase/rollbacks/20260831260000_relatorio_2026_1_tira_quem_ja_quitou_pelo_extrato.rollback.sql

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='_relatorio_2026_1_eleg';

  if v_def is null then
    raise exception '_relatorio_2026_1_eleg nao existe -- migration fora de ordem';
  end if;
  if v_def like '%JA QUITOU PELO EXTRATO%' then return; end if;

  v_novo := replace(v_def,
'    AND NOT (
          EXISTS (SELECT 1 FROM public.prime_portador_membro pm',
'    -- JA QUITOU PELO EXTRATO: o que entrou desde 01/07 cobre o que ele deve no
    -- recorte de jan-jun. Quem pagou PARTE continua aqui, com o que falta.
    AND coalesce((SELECT sum(pg.valor_pago) FROM public.pagamentos pg
                   WHERE pg.aluno_id = t.aluno_id
                     AND pg.data_pagamento >= date ''2026-07-01''), 0)
        < (SELECT coalesce(sum(coalesce(t2.saldo_corrigido, t2.valor_em_aberto, t2.valor_original, 0)),0)
             FROM public.acordos_titulos t2
            WHERE t2.aluno_id = t.aluno_id
              AND t2.vencimento between date ''2026-01-01'' and date ''2026-06-30''
              AND upper(coalesce(t2.situacao,'''')) = ''ABERTO''
              AND lower(coalesce(t2.status,'''')) = ''em_aberto''
              AND coalesce(t2.saldo_corrigido, t2.valor_em_aberto, t2.valor_original, 0) > 0)
    AND NOT (
          EXISTS (SELECT 1 FROM public.prime_portador_membro pm');

  if v_novo = v_def then raise exception 'o marcador do corte da Prime nao casou -- nada alterado'; end if;
  execute v_novo;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='_relatorio_2026_1_eleg';
  if v_def not like '%JA QUITOU PELO EXTRATO%' then
    raise exception 'o corte nao ficou na funcao -- verifique';
  end if;
end $do$;
