-- ANTES DA v2 — mede o comportamento da REGRA ATUAL nos mesmos cenários.
--
-- Pré-condição: 01_ambiente.sql. A migration v2 NÃO foi aplicada ainda.
-- Objetivo: produzir a coluna "regra atual" do comparativo. Este arquivo
-- NÃO asserta nada — ele registra. As asserções estão em 03_casos_v2.sql.

\set ON_ERROR_STOP on

do $antes$
declare
  v_canal  uuid;
  v_c1 uuid; v_c2 uuid; v_c3 uuid; v_c4 uuid; v_c5 uuid; v_c6 uuid;
  v_op1 text := 'op1_cont_v2@test.local';
  v_op2 text := 'op2_cont_v2@test.local';
begin
  v_canal := public._t_canal('_cont_v2_antes');

  -- C1: operador já enviou (seria RESPOSTA na época), aluno respondeu há 40h
  v_c1 := public._t_conversa(v_canal, '5551900100001');
  perform public._t_msg(v_c1, 'ENTRADA', 48);
  perform public._t_msg(v_c1, 'SAIDA',   46, v_op1);
  perform public._t_msg(v_c1, 'ENTRADA', 40);

  -- C2: operador já enviou, aluno respondeu há 80h (negociação esfriada)
  v_c2 := public._t_conversa(v_canal, '5551900100002');
  perform public._t_msg(v_c2, 'ENTRADA', 80);
  perform public._t_msg(v_c2, 'SAIDA',   79, v_op1);

  -- C3: operador NUNCA enviou, aluno respondeu há 40h
  v_c3 := public._t_conversa(v_canal, '5551900100003');
  perform public._t_msg(v_c3, 'ENTRADA', 40);

  -- C4: operador já enviou, aluno NUNCA respondeu
  v_c4 := public._t_conversa(v_canal, '5551900100004', 'NOVO');
  perform public._t_msg(v_c4, 'SAIDA', 45, v_op1);

  -- C5: conversa atendida por DOIS operadores; mede pelo op2 (nunca enviou)
  v_c5 := public._t_conversa(v_canal, '5551900100005');
  perform public._t_msg(v_c5, 'ENTRADA', 44);
  perform public._t_msg(v_c5, 'SAIDA',   43, v_op1);

  -- C6: conversa arquivada, aluno respondeu há 40h
  v_c6 := public._t_conversa(v_canal, '5551900100006', 'EM_ATENDIMENTO', now() - interval '5 hours');
  perform public._t_msg(v_c6, 'ENTRADA', 44);
  perform public._t_msg(v_c6, 'SAIDA',   43, v_op1);

  insert into _cont_v2_resultado (fase, n, caso, esperado, obtido, ok, detalhe) values
    ('ANTES', 1, 'operador ja enviou, aluno respondeu ha 40h',        'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c1, v_op1), null, 'o caso que a Amanda relatou'),
    ('ANTES', 2, 'operador ja enviou, aluno respondeu ha 80h',        'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c2, v_op1), null, 'negociacao esfriada'),
    ('ANTES', 3, 'operador NUNCA enviou, aluno respondeu ha 40h',     'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c3, v_op1), null, 'abordagem legitima'),
    ('ANTES', 4, 'operador ja enviou, aluno NUNCA respondeu',         'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c4, v_op1), null, 'follow-up frio'),
    ('ANTES', 5, 'conversa de outro operador, medida pelo op2',       'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c5, v_op2), null, 'identidade do operador'),
    ('ANTES', 6, 'conversa ARQUIVADA, aluno respondeu ha 40h',        'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c6, v_op1), null, 'arquivada');

  update _cont_v2_resultado set ok = (obtido = esperado) where fase = 'ANTES';
end $antes$;

-- Limpa o estado para a fase DEPOIS não herdar abordagens nem conversas
delete from public.whatsapp_abordagens;
delete from public.whatsapp_mensagens;
delete from public.whatsapp_conversas;
delete from public.whatsapp_canais where sessao_chave = '_cont_v2_antes';

select fase, n, caso, esperado, obtido, ok from _cont_v2_resultado where fase = 'ANTES' order by n;

do $conf$
declare v_falhas integer;
begin
  select count(*) into v_falhas from _cont_v2_resultado where fase='ANTES' and ok is not true;
  if v_falhas > 0 then
    raise exception 'baseline inesperada: % casos nao retornaram NOVA_ABORDAGEM na regra atual', v_falhas
      using errcode = '22023';
  end if;
  raise notice 'baseline confirmada: a regra atual conta TODOS os 6 cenarios como NOVA_ABORDAGEM';
end $conf$;
