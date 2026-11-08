-- Reabertura de pendencia: so a gestao reabre. A pendencia nao some.
\set ON_ERROR_STOP on

-- operador comum: negado
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_detalhe_reabrir('cz');
  perform public.afirmar(r->>'motivo' = 'ACESSO_NEGADO', 'operador nao reabre pendencia');
end $$;
reset role;

-- gestao: reabre. A conferencia do estado e feita como superusuario: a fila
-- e a pendencia nao tem leitura direta para authenticated (por design).
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_detalhe_reabrir('cz');
  perform public.afirmar((r->>'ok')::boolean, 'gestao reabre a pendencia');
end $$;
reset role;

do $$ declare n int; t int; rec int; begin
  select count(*) into n from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cz';
  perform public.afirmar(n = 1, 'pendencia reaberta volta a fila');
  select tentativas into t from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cz';
  perform public.afirmar(t = 0, 'reabertura zera as tentativas');
  select count(*) into rec from public.ulbra_detalhe_pendencias
   where ulbra_conversa_id = 'cz' and recuperada_em is not null;
  perform public.afirmar(rec = 1, 'a pendencia continua registrada, agora como recuperada');
end $$;

-- ALCANCE ESGOTADO: a pendencia guarda motivo e ponto de retomada, e a reabertura
-- devolve o ponto a fila (nunca se conclui "sem resposta" por truncamento).
select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T06:02:00+00:00',
  'conversas', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cw', 'ulbra_cliente_id', 'kw', 'cliente_nome', 'Aluno D',
    'canal', 'whatsapp', 'situacao', 'active', 'equipe', 'Reativa', 'responsavel_ulbra', null,
    'ultima_mensagem_em', '2026-11-08T06:02:00+00:00', 'ultima_mensagem_quem', 'operador',
    'ultima_mensagem_previa', 'ok', 'ultima_mensagem_cliente_em', null,
    'aluno_id', '00000000-0000-0000-0000-00000000000a', 'aluno_status', 'vinculado')),
  'detalhe_enfileirar', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cw', 'ulbra_cliente_id', 'kw', 'na_lista_em', '2026-11-08T06:02:00+00:00'))));

select public.ulbra_sync_gravar(jsonb_build_object(
  'ciclo', 'OK', 'chamadas', 1, 'dia', '2026-11-08', 'cursor', '2026-11-08T06:02:00+00:00',
  'detalhe_pendencias', jsonb_build_array(jsonb_build_object(
    'ulbra_conversa_id', 'cw', 'ulbra_cliente_id', 'kw', 'na_lista_em', '2026-11-08T06:02:00+00:00',
    'motivo', 'ALCANCE_ESGOTADO', 'antes_de', '2026-11-07T23:00:00+00:00'))));

do $$ declare mot text; ad timestamptz; begin
  select motivo, antes_de::timestamptz into mot, ad
    from public.ulbra_detalhe_pendencias where ulbra_conversa_id = 'cw';
  perform public.afirmar(mot = 'ALCANCE_ESGOTADO', 'a pendencia de alcance registra o motivo');
  perform public.afirmar(ad = '2026-11-07T23:00:00+00:00', 'a pendencia de alcance guarda o ponto de retomada');
end $$;

set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_detalhe_reabrir('cw');
  perform public.afirmar((r->>'ok')::boolean, 'gestao reabre a pendencia de alcance');
end $$;
reset role;

do $$ declare ad text; begin
  select antes_de into ad from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cw';
  perform public.afirmar(ad is not null and ad::timestamptz = '2026-11-07T23:00:00+00:00',
    'reabrir devolve a conversa a fila NO PONTO DE RETOMADA, nao do zero');
end $$;

select 'REABERTURA DE PENDENCIA: afirmacoes passaram' as resultado;
