-- DADOS DO CASO. Todos os identificadores são fictícios.
--
-- O desenho cobre, de propósito, os quatro recortes E as exclusões do ramo de
-- 2024/2025 -- inclusive a CTE `m166`, que é onde estava a referência ambígua
-- a `cpf`. Um baseline sem NENHUMA linha em `prime_portador_membro` deixaria
-- aquela CTE vazia e o defeito poderia passar despercebido.
\set ON_ERROR_STOP on

insert into public.alunos (id, cpf, nome, cpf_mascarado, situacao_academica, academico_atualizado_em) values
  ('a0000000-0000-4000-8000-000000000001','11111111111','ALUNO A1','111.***.***-11','ATIVO',      '2026-08-01'),
  ('a0000000-0000-4000-8000-000000000002','22222222222','ALUNO A2','222.***.***-22','ATIVO',      '2026-08-01'),
  ('b0000000-0000-4000-8000-000000000001','33333333333','ALUNO B1','333.***.***-33','EVADIDO',    '2026-08-01'),
  ('b0000000-0000-4000-8000-000000000002','44444444444','ALUNO B2','444.***.***-44','TRANCADO',   '2026-08-01'),
  ('c0000000-0000-4000-8000-000000000001','55555555555','ALUNO C1','555.***.***-55','FORMADO',    '2026-08-01'),
  ('c0000000-0000-4000-8000-000000000002','66666666666','ALUNO C2','666.***.***-66',null,          null),
  ('d0000000-0000-4000-8000-000000000001','77777777777','ALUNO D1','777.***.***-77','ATIVO',      '2026-08-01'),
  ('d0000000-0000-4000-8000-000000000002','88888888888','ALUNO D2','888.***.***-88','ATIVO',      '2026-08-01');

-- ---------------------------------------------------------------------------
-- 2026/1 -- vem da classificação. A2 tem saldo zero e fica de fora; A1 aparece
-- em DUAS linhas (mesmo CPF, aluno_id diferente) para provar o dedup por CPF.
-- ---------------------------------------------------------------------------
insert into public._c2026_1 (aluno_id, cpf, inadimplencia, em_validacao) values
  ('a0000000-0000-4000-8000-000000000001','11111111111', 500.00, 0),
  ('a0000000-0000-4000-8000-000000000001','11111111111',   0.00, 250.00),
  ('a0000000-0000-4000-8000-000000000002','22222222222',   0.00, 0);

-- ---------------------------------------------------------------------------
-- 2026/2 -- carteira do semestre. D1 tem dois títulos (dedup -> 1 aluno).
-- ---------------------------------------------------------------------------
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, situacao, status, vencimento, tipo_boleto, valor_em_aberto) values
  ('11111111-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','77777777777','900001','ABERTO','em_aberto','2026-08-10','Cursos de Graduacao', 300),
  ('11111111-0000-4000-8000-000000000002','d0000000-0000-4000-8000-000000000001','77777777777','900002','ABERTO','em_aberto','2026-09-10','Cursos de Graduacao', 300),
  ('11111111-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000002','88888888888','900003','ABERTO','em_aberto','2026-08-10','Cursos de Graduacao', 300);
insert into public.prime_titulo_semestre (boleto, semestre, carrier_id, coletado_em) values
  ('900001','2026/2',195,'2026-09-01'),
  ('900002','2026/2',195,'2026-09-01'),
  ('900003','2026/2',195,'2026-09-01');

-- ---------------------------------------------------------------------------
-- 2024 -- B1 entra. B2 é membro do portador 166 SEM acordo ativo e sai; é ele
-- que faz a CTE `m166` ter linha.
-- ---------------------------------------------------------------------------
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, situacao, status, vencimento, tipo_boleto, valor_em_aberto) values
  ('22222222-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','33333333333','800001','ABERTO','em_aberto','2024-03-10','Cursos de Graduacao', 1000),
  ('22222222-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000002','44444444444','800002','ABERTO','em_aberto','2024-04-10','Cursos de Graduacao', 1000);
insert into public.prime_titulo_semestre (boleto, semestre, carrier_id, coletado_em) values
  ('800001','2024/1',195,'2024-05-01'),
  ('800002','2024/1',195,'2024-05-01');
insert into public.prime_portador_membro (cpf, portador) values ('44444444444', 166);

-- ---------------------------------------------------------------------------
-- 2025 -- C1 entra. C2 tem caso CANCELADO e sai.
-- ---------------------------------------------------------------------------
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, situacao, status, vencimento, tipo_boleto, valor_em_aberto) values
  ('33333333-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','55555555555','700001','ABERTO','em_aberto','2025-09-10','Cursos de Graduacao', 800),
  ('33333333-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000002','66666666666','700002','ABERTO','em_aberto','2025-09-10','Cursos de Graduacao', 800);
insert into public.prime_titulo_semestre (boleto, semestre, carrier_id, coletado_em) values
  ('700001','2025/2',195,'2025-10-01'),
  ('700002','2025/2',195,'2025-10-01');
insert into public.casos (aluno_id, status_atual) values
  ('c0000000-0000-4000-8000-000000000002','CANCELADO');

-- ---------------------------------------------------------------------------
-- CONSULTAS AO PRIME já armazenadas
--   B1  -> COM_VINCULOS, dois vínculos com o MESMO status -> "Status identificado"
--   C1  -> COM_VINCULOS, dois status diferentes           -> "Múltiplas situações"
--   D1  -> SEM_RESULTADO                                  -> "Sem resultado na busca"
--   D2  -> só PAGINACAO_INCOMPLETA                        -> "Informação incompleta"
--   A1  -> nenhuma consulta                               -> "Ainda não consultados"
-- ---------------------------------------------------------------------------
insert into public.prime_academico_consulta (id, aluno_id, resultado, consultado_em, fonte) values
  ('cc000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','COM_VINCULOS',        '2026-09-28 10:00+00','students_search'),
  ('cc000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001','COM_VINCULOS',        '2026-09-28 10:00+00','students_search'),
  ('cc000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000001','SEM_RESULTADO',       '2026-09-28 10:00+00','students_search'),
  ('cc000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000002','PAGINACAO_INCOMPLETA','2026-09-28 10:00+00','students_search');

insert into public.prime_academico_vinculo (consulta_id, ordem, status, curso, campus, turno, registration) values
  ('cc000000-0000-4000-8000-000000000001',1,'EVADIDO','CURSO X','CANOAS','NOITE','990100001'),
  ('cc000000-0000-4000-8000-000000000001',2,'EVADIDO','CURSO Y','CANOAS','NOITE','990100001'),
  ('cc000000-0000-4000-8000-000000000002',1,'FORMADO','CURSO Z','CANOAS','MANHA','990100002'),
  ('cc000000-0000-4000-8000-000000000002',2,'TRANCADO','CURSO W','CANOAS','MANHA','990100002');
