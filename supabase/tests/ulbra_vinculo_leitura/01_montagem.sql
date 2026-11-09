-- Alunos com responsavel: A e C sao do op1; B e D sao do op2.
insert into public.alunos (id, nome, responsavel_atual_email) values
  ('00000000-0000-0000-0000-00000000000a', 'Aluno A (op1, vinculo confirmado)', 'op1@x'),
  ('00000000-0000-0000-0000-00000000000b', 'Aluno B (op2, vinculo confirmado)', 'op2@x'),
  ('00000000-0000-0000-0000-00000000000c', 'Aluno C (op1, sem vinculo)', 'op1@x'),
  ('00000000-0000-0000-0000-00000000000d', 'Aluno D (op2, sem vinculo)', 'op2@x'),
  ('00000000-0000-0000-0000-00000000000e', 'Aluno E (op1, vinculo SO TELEFONE)', 'op1@x');
insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca) values
  ('00000000-0000-0000-0000-00000000000a', '777', 'alta_cpf'),
  ('00000000-0000-0000-0000-00000000000b', '999', 'alta_cpf'),
  ('00000000-0000-0000-0000-00000000000e', '555', 'alta');
