-- PROVA DA FILA DE DETALHES: dedupe, falha com retentativa, leitura que
-- conclui, e desistencia. Nada aqui chama a ULBRA: o payload e montado a mao.
\set ON_ERROR_STOP on

-- ciclo A: a conversa cy entra na fila DUAS vezes no mesmo payload (dedupe)
select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T06:00:00+00:00',
  'topo_processado', '2026-11-08T06:00:00+00:00', 'piso_pendente', null,
  'conversas', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cy', 'ulbra_cliente_id', 'ky', 'cliente_nome', 'Aluno B',
    'canal', 'whatsapp', 'situacao', 'active', 'equipe', 'Reativa', 'responsavel_ulbra', 'op2@x',
    'ultima_mensagem_em', '2026-11-08T06:00:00+00:00', 'ultima_mensagem_quem', 'operador',
    'ultima_mensagem_previa', 'ok', 'ultima_mensagem_cliente_em', null,
    'aluno_id', '00000000-0000-0000-0000-00000000000b', 'aluno_status', 'vinculado')),
  'detalhe_enfileirar', jsonb_build_array(
    jsonb_build_object('ulbra_conversa_id', 'cy', 'ulbra_cliente_id', 'ky', 'na_lista_em', '2026-11-08T06:00:00+00:00'),
    jsonb_build_object('ulbra_conversa_id', 'cy', 'ulbra_cliente_id', 'ky', 'na_lista_em', '2026-11-08T06:00:00+00:00'))));

do $$ declare n int; begin
  select count(*) into n from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cy';
  perform public.afirmar(n = 1, 'a conversa entra na fila uma vez so, mesmo enfileirada duas vezes');
end $$;

-- ciclo B: a leitura de detalhe FALHA. Uma tentativa a mais, continua na fila.
select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T06:00:00+00:00',
  'detalhe_falhas', jsonb_build_array('cy')));

do $$ declare t int; begin
  select tentativas into t from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cy';
  perform public.afirmar(t = 1, 'falha de detalhe conta uma tentativa e a conversa segue na fila');
end $$;

-- ciclo C: a leitura CONCLUI e o cliente aparece em 05:30. Sai da fila; o espelho sobe.
select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T06:00:00+00:00',
  'detalhe_concluidas', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cy', 'ultima_mensagem_cliente_em', '2026-11-08T05:30:00+00:00'))));

do $$ declare n int; d timestamptz; begin
  select count(*) into n from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cy';
  perform public.afirmar(n = 0, 'conversa lida sai da fila');
  select ultima_mensagem_cliente_em into d from public.ulbra_conversas where ulbra_conversa_id = 'cy';
  perform public.afirmar(d = '2026-11-08T05:30:00+00:00', 'a data do cliente do detalhe chega ao espelho');
end $$;

-- ciclo D: a conversa cz esgota as tentativas. NAO some: vira PENDENCIA e alerta.
select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T06:01:00+00:00',
  'conversas', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cz', 'ulbra_cliente_id', 'kz', 'cliente_nome', 'Aluno C',
    'canal', 'whatsapp', 'situacao', 'active', 'equipe', 'Reativa', 'responsavel_ulbra', null,
    'ultima_mensagem_em', '2026-11-08T06:01:00+00:00', 'ultima_mensagem_quem', 'operador',
    'ultima_mensagem_previa', 'ok', 'ultima_mensagem_cliente_em', null,
    'aluno_id', '00000000-0000-0000-0000-00000000000c', 'aluno_status', 'vinculado')),
  'detalhe_enfileirar', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cz', 'ulbra_cliente_id', 'kz', 'na_lista_em', '2026-11-08T06:01:00+00:00'))));

select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T06:01:00+00:00',
  'detalhe_pendencias', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cz', 'ulbra_cliente_id', 'kz', 'na_lista_em', '2026-11-08T06:01:00+00:00'))));

do $$ declare n int; p int; alerta text; begin
  select count(*) into n from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cz';
  perform public.afirmar(n = 0, 'conversa esgotada sai da fila ativa');
  select count(*) into p from public.ulbra_detalhe_pendencias where ulbra_conversa_id = 'cz' and recuperada_em is null;
  perform public.afirmar(p = 1, 'conversa esgotada NAO some: fica como pendencia aberta');
  select alerta_gestao into alerta from public.ulbra_sync_estado where id;
  perform public.afirmar(alerta like 'PENDENCIA:%', 'a gestao recebe alerta com a contagem de pendencias');
end $$;

select 'FILA DE DETALHES: afirmacoes passaram' as resultado;
