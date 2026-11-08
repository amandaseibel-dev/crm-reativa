-- Espelho e atendimentos simulados, inseridos como superusuario (antes de
-- qualquer papel de aplicacao). Nada aqui vem da ULBRA.
insert into public.ulbra_conversas
  (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, situacao, equipe,
   responsavel_ulbra, ultima_mensagem_em, ultima_mensagem_quem, ultima_mensagem_previa,
   ultima_mensagem_cliente_em, aluno_id, aluno_status)
values
  ('c1', 'k1', 'Aluno A', 'active', 'Reativa', null, '2026-11-08 05:00+00', 'cliente', 'oi',
   '2026-11-08 05:00+00', '00000000-0000-0000-0000-00000000000a', 'vinculado'),
  ('c2', 'k2', 'Aluno B', 'active', 'Reativa', null, '2026-11-08 04:00+00', 'cliente', 'oi',
   '2026-11-08 04:00+00', '00000000-0000-0000-0000-00000000000b', 'vinculado'),
  ('c3', 'k3', 'Aluno C', 'active', 'Reativa', null, '2026-11-08 03:00+00', 'cliente', 'oi',
   '2026-11-08 03:00+00', '00000000-0000-0000-0000-00000000000c', 'vinculado');

insert into public.ulbra_atendimentos
  (ulbra_atendimento_id, ulbra_cliente_id, cliente_nome, equipe, situacao,
   entrou_em, aluno_id, aluno_status, destino_email, destino_motivo)
values
  ('x1', 'k1', 'Aluno A', 'Reativa', 'waiting', '2026-11-08 05:10+00',
   '00000000-0000-0000-0000-00000000000a', 'vinculado', 'op1@x', 'RODIZIO'),
  ('x2', 'k2', 'Aluno B', 'Reativa', 'waiting', '2026-11-08 05:11+00',
   '00000000-0000-0000-0000-00000000000b', 'vinculado', 'op2@x', 'CARTEIRA'),
  ('x3', 'k9', 'Sem vinculo', 'Reativa', 'waiting', '2026-11-08 05:12+00',
   null, 'nao_confirmado', null, 'CONFERENCIA'),
  ('x4', 'k3', 'Aluno C', 'Reativa', 'waiting', '2026-11-08 05:13+00',
   '00000000-0000-0000-0000-00000000000c', 'vinculado', 'op2@x', 'RODIZIO');
