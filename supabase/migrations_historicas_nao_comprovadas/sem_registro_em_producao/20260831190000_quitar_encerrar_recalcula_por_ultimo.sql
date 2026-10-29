-- "Quitei e continua la": o quitar recalculava no MEIO e gravava saldo velho.
--
-- Amanda, 31/08: "maria renata portal consul, quitei e continua la".
--
-- O QUE ACONTECIA. `quitar_e_encerrar_caso` zera o aluno e depois vai atualizando
-- parcelas, acordos e titulos. Cada um desses updates dispara recalculo POR
-- GATILHO -- e o gatilho da parcela roda ANTES de os titulos serem quitados.
-- Resultado: o recalculo do meio grava um saldo que ja nasce velho, e nada
-- recalcula depois, porque `acordos_titulos` nao tem gatilho de recalculo.
--
-- Na Maria Renata Portal Consul, o relogio conta a historia:
--   14:26:02.716  parcela -> PAGO      -> gatilho recalcula (titulos ainda ABERTO)
--   14:26:03.346  titulos -> PAGO      -> nao recalcula nada
-- Saldo gravado: R$ 4.845,84 (= os dois titulos), num caso quitado e encerrado.
--
-- Mesma familia do defeito corrigido em 20260831170000, na baixa. La o recalculo
-- vinha antes do abatimento; aqui vem no meio da quitacao. A licao e a mesma:
-- QUEM MEXE NA DIVIDA TEM DE RECALCULAR POR ULTIMO.
--
-- Envolto em `exception when others` para que uma falha no recalculo nunca
-- desfaca a quitacao -- o pior caso volta a ser saldo velho ate as 06:00.
--
-- Corrigido tambem o acumulado: recalculo geral, 14.089 alunos, 0 erros.
--
-- DESFAZER: supabase/rollbacks/20260831190000_quitar_encerrar_recalcula_por_ultimo.rollback.sql

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='quitar_e_encerrar_caso';

  if v_def is null then
    raise exception 'quitar_e_encerrar_caso nao existe -- migration fora de ordem';
  end if;
  if v_def like '%recalcular_situacao_aluno%' then return; end if;

  v_novo := replace(v_def,
'  return jsonb_build_object(''ok'', true, ''casos_quitados'', v_casos,',
'  -- RECALCULO POR ULTIMO. Ver o cabecalho da migration.
  begin perform public.recalcular_situacao_aluno(p_aluno_id, ''quitar_encerrar''); exception when others then null; end;

  return jsonb_build_object(''ok'', true, ''casos_quitados'', v_casos,');

  if v_novo = v_def then raise exception 'nao casou -- nada alterado'; end if;
  execute v_novo;
end $do$;
