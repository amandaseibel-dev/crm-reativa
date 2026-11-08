-- PROVA DE COMPORTAMENTO: resposta do cliente seguida de operador/bot ANTES da
-- sincronizacao. A lista mostra so a ultima mensagem; a data do cliente tem
-- que sobreviver ao ciclo seguinte, senao a resposta some do aviso.
\set ON_ERROR_STOP on

-- ciclo 1: o cliente responde 05:00 (a lista mostra o cliente por ultimo)
select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T05:00:00+00:00',
  'topo_processado', '2026-11-08T05:00:00+00:00', 'piso_pendente', null,
  'conversas', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cx', 'ulbra_cliente_id', 'kx', 'cliente_nome', 'Aluno A',
    'canal', 'whatsapp', 'situacao', 'active', 'equipe', 'Reativa', 'responsavel_ulbra', null,
    'ultima_mensagem_em', '2026-11-08T05:00:00+00:00', 'ultima_mensagem_quem', 'cliente',
    'ultima_mensagem_previa', 'oi', 'ultima_mensagem_cliente_em', '2026-11-08T05:00:00+00:00',
    'aluno_id', '00000000-0000-0000-0000-00000000000a', 'aluno_status', 'vinculado'))));

-- ciclo 2: o operador respondeu 05:05 e a lista agora mostra o OPERADOR.
-- O payload do ciclo traz ultima_mensagem_cliente_em = null (a lista nao prova
-- nada sobre o cliente). A gravacao NAO pode apagar a data ja provada.
select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T05:05:00+00:00',
  'topo_processado', '2026-11-08T05:05:00+00:00', 'piso_pendente', null,
  'conversas', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cx', 'ulbra_cliente_id', 'kx', 'cliente_nome', 'Aluno A',
    'canal', 'whatsapp', 'situacao', 'active', 'equipe', 'Reativa', 'responsavel_ulbra', 'op1@x',
    'ultima_mensagem_em', '2026-11-08T05:05:00+00:00', 'ultima_mensagem_quem', 'operador',
    'ultima_mensagem_previa', 'ok', 'ultima_mensagem_cliente_em', null,
    'aluno_id', '00000000-0000-0000-0000-00000000000a', 'aluno_status', 'vinculado'))));

do $$ declare d timestamptz; begin
  select ultima_mensagem_cliente_em into d from public.ulbra_conversas where ulbra_conversa_id = 'cx';
  perform public.afirmar(d = '2026-11-08T05:00:00+00:00',
    'resposta do cliente (05:00) sobrevive ao operador responder depois (05:05)');
end $$;

-- e quem NAO leu continua vendo como nao lida; quem leu, nao
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_conversa_marcar_lida('cx');
  perform public.afirmar((r->>'ok')::boolean, 'op1 marca cx como lida');
end $$;
reset role;

do $$ declare nao_lida_para_responsavel boolean; begin
  -- responsavel ainda nao leu: a conversa segue nao lida para ele
  select not exists (select 1 from public.ulbra_leitura_usuario
                      where ulbra_conversa_id = 'cx' and usuario_email = 'op2@x')
    into nao_lida_para_responsavel;
  perform public.afirmar(nao_lida_para_responsavel,
    'a leitura do op1 nao zera a resposta para quem ainda nao leu');
end $$;

select 'RESPOSTA SEGUIDA DE OPERADOR: afirmacoes passaram' as resultado;
