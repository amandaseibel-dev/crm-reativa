-- PROVAS DE RESPONSABILIDADE: ver nao e responder.
-- Aluno E (aluno com casos de DOIS operadores, op1 e op2; nenhum assumiu):
--   deve ser A_DEFINIR para os dois, sem aviso individual e fora do rodizio.
-- Aluno F (casos de op1 e op2, mas op2 assumiu no ReATIVA): ASSUMIDO com op2.
-- Aluno G (so caso de op1): CARTEIRA de op1.
\set ON_ERROR_STOP on

insert into public.alunos (id, nome) values
  ('00000000-0000-0000-0000-0000000000e1', 'Aluno E'),
  ('00000000-0000-0000-0000-0000000000f1', 'Aluno F'),
  ('00000000-0000-0000-0000-0000000000a9', 'Aluno G');
insert into public.casos (aluno_id, operador_email, data_ultimo_acionamento) values
  ('00000000-0000-0000-0000-0000000000e1', 'op1@x', (now() at time zone 'America/Sao_Paulo')::date - 3),
  ('00000000-0000-0000-0000-0000000000e1', 'op2@x', (now() at time zone 'America/Sao_Paulo')::date - 20),
  ('00000000-0000-0000-0000-0000000000f1', 'op1@x', (now() at time zone 'America/Sao_Paulo')::date - 1),
  ('00000000-0000-0000-0000-0000000000f1', 'op2@x', (now() at time zone 'America/Sao_Paulo')::date - 15),
  ('00000000-0000-0000-0000-0000000000a9', 'op1@x', (now() at time zone 'America/Sao_Paulo')::date - 2);

-- conversas com resposta do aluno para E, F e G
insert into public.ulbra_conversas
  (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, situacao, equipe, responsavel_ulbra,
   ultima_mensagem_em, ultima_mensagem_quem, ultima_mensagem_previa, ultima_mensagem_cliente_em, aluno_id, aluno_status)
values
  ('ce', 'ke', 'Aluno E', 'active', 'Reativa', 'Olga Oliveira', '2026-11-08 01:00+00', 'cliente', 'quero parcelar',
   '2026-11-08 01:00+00', '00000000-0000-0000-0000-0000000000e1', 'vinculado'),
  ('cf', 'kf', 'Aluno F', 'active', 'Reativa', null, '2026-11-08 01:10+00', 'cliente', 'boleto?',
   '2026-11-08 01:10+00', '00000000-0000-0000-0000-0000000000f1', 'vinculado'),
  ('cg', 'kg', 'Aluno G', 'active', 'Reativa', null, '2026-11-08 01:20+00', 'cliente', 'oi',
   '2026-11-08 01:20+00', '00000000-0000-0000-0000-0000000000a9', 'vinculado');

-- F: op2 ASSUMIU no ReATIVA (aceite identificado, uma pessoa)
insert into public.ulbra_atendimentos
  (ulbra_atendimento_id, ulbra_cliente_id, cliente_nome, equipe, situacao, entrou_em,
   aluno_id, aluno_status, destino_email, destino_motivo, responsavel_email, assumido_em)
values
  ('xf', 'kf', 'Aluno F', 'Reativa', 'accepted', '2026-11-08 01:05+00',
   '00000000-0000-0000-0000-0000000000f1', 'vinculado', 'op1@x', 'CARTEIRA', 'op2@x', '2026-11-08 01:06+00');

-- o mesmo atendimento de E com destino CARTEIRA gravado pela coleta (primeiro caso
-- encontrado = op1): NAO pode virar "de op1" nem ser usado como verdade
insert into public.ulbra_atendimentos
  (ulbra_atendimento_id, ulbra_cliente_id, cliente_nome, equipe, situacao, entrou_em,
   aluno_id, aluno_status, destino_email, destino_motivo)
values
  ('xe', 'ke', 'Aluno E', 'Reativa', 'waiting', '2026-11-08 01:07+00',
   '00000000-0000-0000-0000-0000000000e1', 'vinculado', 'op1@x', 'CARTEIRA');

set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; e jsonb; begin
  r := public.ulbra_central_operador();
  -- op1 PODE VER E e F e G (tem caso), mas NAO e responsavel por E
  select x into e from jsonb_array_elements(r->'respostas') x where x->>'conversa_id' = 'ce';
  perform public.afirmar(e is not null, 'op1 ve a conversa de E: ver nao e responder');
  perform public.afirmar(e->>'responsabilidade' = 'A_DEFINIR', 'E com dois operadores e A_DEFINIR');
  perform public.afirmar(e->'responsavel_reativa' = 'null'::jsonb and (e->>'responsavel_e_outro')::boolean = false,
    'E: nenhum responsavel e exibido para op1 (nem por ordem, nem por nome)');
  perform public.afirmar((e->>'notificar')::boolean = false and (e->>'minha')::boolean = false,
    'E: nenhum aviso individual para op1');
  perform public.afirmar((e->>'divergencia')::boolean = true, 'E: divergencia aparece para quem ja tem acesso');
  perform public.afirmar(e->'operadores_com_caso' = 'null'::jsonb, 'op1 nao recebe a lista de operadores com caso do aluno');

  -- F: ASSUMIDO por op2; op1 ve, mas NAO e o responsavel
  select x into e from jsonb_array_elements(r->'respostas') x where x->>'conversa_id' = 'cf';
  perform public.afirmar(e->>'responsabilidade' = 'ASSUMIDO', 'F com aceite de op2 e ASSUMIDO');
  perform public.afirmar((e->>'responsavel_e_outro')::boolean = true and (e->>'responsavel_definido')::boolean = true
                     and e->'responsavel_reativa' = 'null'::jsonb,
    'F: op1 ve que HA responsavel e que nao e ele, sem receber o e-mail alheio');
  perform public.afirmar((e->>'notificar')::boolean = false, 'F: op1 nao recebe aviso de atendimento de outro');

  -- G: CARTEIRA de op1 -> op1 e o responsavel e recebe aviso
  select x into e from jsonb_array_elements(r->'respostas') x where x->>'conversa_id' = 'cg';
  perform public.afirmar(e->>'responsabilidade' = 'CARTEIRA' and (e->>'minha')::boolean = true
                     and (e->>'notificar')::boolean = true, 'G: caso unico de op1 = responsabilidade dele, com aviso');
  -- prioridade: o que e dele vem antes do que so ve
  perform public.afirmar(r->'respostas'->0->>'conversa_id' = 'cg', 'a conversa de responsabilidade propria vem primeiro');
  -- nenhum aluno de op2 que op1 nao ve
  perform public.afirmar(position('Aluno B' in r::text) = 0 and position('Aluno E' in r::text) > 0,
    'op1 ve E (tem caso) mas nao ve B (so de op2)');
  -- data de acionamento sai como data, sem hora
  perform public.afirmar(e->>'ultimo_acionamento' ~ '^\d{4}-\d{2}-\d{2}$', 'data de acionamento sai como data pura, sem hora inventada');
end $$;
reset role;

set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare r jsonb; e jsonb; begin
  r := public.ulbra_central_operador();
  select x into e from jsonb_array_elements(r->'respostas') x where x->>'conversa_id' = 'cf';
  perform public.afirmar((e->>'minha')::boolean = true and (e->>'notificar')::boolean = true,
    'op2 e o responsavel comprovado de F e recebe o aviso');
  select x into e from jsonb_array_elements(r->'respostas') x where x->>'conversa_id' = 'ce';
  perform public.afirmar((e->>'notificar')::boolean = false and (e->>'responsabilidade')::text = 'A_DEFINIR',
    'op2 ve E como A_DEFINIR, sem aviso individual');
  perform public.afirmar(r->'totais'->>'respostas_a_definir' = '1' or (r->'totais'->>'respostas_a_definir')::int >= 1,
    'totais dizem quantas estao a definir');
end $$;
reset role;

-- gestao ve a lista de operadores com caso e a responsabilidade de cada um
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; e jsonb; begin
  r := public.ulbra_central_operador();
  select x into e from jsonb_array_elements(r->'respostas') x where x->>'conversa_id' = 'ce';
  perform public.afirmar(e->'operadores_com_caso' @> '["op1@x","op2@x"]'::jsonb,
    'gestao ve os dois operadores com caso de E, para decidir');
  perform public.afirmar(e->>'responsabilidade' = 'A_DEFINIR', 'gestao ve E como a definir, sem escolher');
end $$;
reset role;
