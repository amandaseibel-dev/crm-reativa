-- Acordo QUITADO continuava contando divida.
--
-- Amanda, 31/08: "se ja esta quitado ou cancelado nao devem ir para contagem" e
-- "so mensalidade e acordo em aberto".
--
-- `recalcular_situacao_aluno` somava as parcelas de todo acordo que nao fosse
-- CANCELADO -- o que inclui os QUITADOS. Enquanto todas as parcelas de um acordo
-- quitado estiverem PAGO, o efeito e zero e o defeito fica invisivel. Basta uma
-- parcela ficar para tras para o aluno seguir devendo um acordo que ja acabou.
--
-- Achado ao investigar o Leonel Thomas Bosa e a Maria Eduarda Teles Parreira,
-- que a Amanda apontou como "consta vencido mas so tem acordo em dia". Nos dois
-- a causa era outra (saldo desatualizado, ver abaixo), mas a conferencia
-- descobriu este terceiro caso:
--
--   Lucas Goncalves dos Santos -- acordo QUITADO em 30/07, uma parcela marcada
--   VENCIDA que nunca virou PAGO. R$ 1.844,42 cobrados de um acordo encerrado.
--
-- E O UNICO em toda a base -- conferido antes de mexer. Mesmo assim a correcao
-- e na REGRA, nao no dado dele: mexer na parcela afirmaria que aquela parcela
-- foi paga, o que nao esta provado. Excluir acordo QUITADO da contagem afirma
-- apenas o que a Amanda determinou -- acordo encerrado nao gera cobranca -- e
-- vale para todos os casos futuros, sem precisar de vigilancia.
--
-- A troca vale para as QUATRO ocorrencias do filtro dentro da funcao (saldo,
-- proxima parcela a vencer, parcela vencida mais antiga e o sinal de acordo).
-- Trocar so uma deixaria a tela discordando de si mesma.
--
-- SOBRE O SALDO DESATUALIZADO, que era o problema do Leonel e da Maria Eduarda:
-- criar acordo NAO dispara o recalculo do aluno. Ate a virada das 06:00, o saldo
-- segue somando as mensalidades que o acordo novo acabou de substituir. Os dois
-- foram recalculados na mao; o gatilho que fecha isso na origem fica para uma
-- migration propria.
--
-- Conferido depois de aplicar: 14.107 alunos recalculados, 0 erros. O Lucas foi
-- para saldo R$ 0,00.
--
-- DESFAZER: supabase/rollbacks/20260831150000_acordo_quitado_nao_conta_no_saldo.rollback.sql

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'recalcular_situacao_aluno';

  if v_def is null then
    raise exception 'recalcular_situacao_aluno nao existe -- migration fora de ordem';
  end if;

  if v_def like '%''CANCELADO'',''CANCELADA'',''QUITADO''%' then
    return; -- ja aplicada
  end if;

  v_novo := replace(v_def,
    'upper(coalesce(a.status,'''')) not in (''CANCELADO'',''CANCELADA'')',
    'upper(coalesce(a.status,'''')) not in (''CANCELADO'',''CANCELADA'',''QUITADO'')');

  if v_novo = v_def then
    raise exception 'o filtro de status do acordo nao casou -- nada alterado';
  end if;

  execute v_novo;
end $do$;

-- Sem isto a mudanca so aparece na virada das 06:00.
-- Executado em prod em 31/08: 14.107 alunos, 0 erros.
-- select public.recalcular_situacao_virada_diaria('regra_quitado_nao_conta_31_08');
