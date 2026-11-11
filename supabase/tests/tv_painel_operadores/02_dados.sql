-- DADOS SIMULADOS, todos ancorados no "hoje" de Brasília.
\set ON_ERROR_STOP on
-- tabela comum (não temp): cada arquivo roda numa sessão psql própria
create table public.teste_hoje as select (now() at time zone 'America/Sao_Paulo')::date d;
grant select on public.teste_hoje to authenticated;

insert into public.usuarios (email, nome) values
  ('cobranca05@aelbra.com.br', 'João Silva'),
  ('cobranca06@aelbra.com.br', 'Rafaella Souza'),
  ('cobranca08@aelbra.com.br', 'Luana Lima'),
  ('cobranca10@aelbra.com.br', 'Mauricio Reis'),
  ('cobranca11@aelbra.com.br', 'Allan Costa'),
  ('cobranca12@aelbra.com.br', 'Oculto Teste'),
  ('externo@aelbra.com.br',    'Fora Da Lista');
insert into public.tv_equipe_oculta (email, nome) values ('cobranca12@aelbra.com.br', 'Oculto Teste');
insert into public.metas_projecao (mes_referencia, meta_honorario) select to_char(d, 'YYYY-MM'), 122400 from public.teste_hoje h;

-- Pagamentos de HOJE (centavos de propósito)
insert into public.pagamentos (data_pagamento, valor_pago, valor_honorario, retroativo, operador_email)
select h.d, v.pago, v.hon, v.retro, v.op from public.teste_hoje h, (values
  (1000.10, 100.01, false, 'cobranca05@aelbra.com.br'),
  (2000.20, 200.02, false, 'cobranca05@aelbra.com.br'),
  ( 500.00,   0.00, false, 'cobranca05@aelbra.com.br'),
  (40000.00, 2907.12, false, 'cobranca06@aelbra.com.br'),
  ( 100.00,  10.00, true,  'cobranca06@aelbra.com.br'),   -- retroativo: mês sim, hoje não
  (13667.21, 1012.39, false, 'cobranca08@aelbra.com.br'),
  (  50.00,   5.00, false, ' COBRANCA08@aelbra.com.br '), -- e-mail sujo: mesmo operador
  (  10.00,   1.00, false, 'cobranca10@aelbra.com.br'),
  (  10.00,   1.00, false, 'cobranca10@aelbra.com.br'),
  (  10.00,   1.00, false, 'cobranca10@aelbra.com.br'),
  (  10.00,   1.00, false, 'cobranca10@aelbra.com.br'),
  (99999.00, 9999.00, false, 'externo@aelbra.com.br')     -- soma no total, fora dos rankings
) as v(pago, hon, retro, op);

-- João: 20 pagamentos pequenos (honorário 100 cada). No ACUMULADO ele passa a
-- Luana; no MAIOR PAGAMENTO ÚNICO continua atrás dela. É isso que separa o
-- pódio (acumulado) do top honorários (pagamento único) no teste.
insert into public.pagamentos (data_pagamento, valor_pago, valor_honorario, operador_email)
select h.d, 1000.00, 100.00, 'cobranca05@aelbra.com.br' from public.teste_hoje h, generate_series(1, 20);

-- Pagamento de ONTEM: nunca entra em "hoje"; no mês só se ontem for do mesmo mês.
insert into public.pagamentos (data_pagamento, valor_pago, valor_honorario, operador_email)
select h.d - 1, 10.00, 1.00, 'cobranca10@aelbra.com.br' from public.teste_hoje h;

-- Acordos. Fronteira do fuso: 00:30 de hoje em SP entra; 23:30 de ontem em SP
-- (que já é "hoje" em UTC) NÃO entra.
insert into public.acordos (criado_em, status, operador_responsavel_email, duplicado_de)
select (h.d + v.hora) at time zone 'America/Sao_Paulo', v.st, v.op, v.dup from public.teste_hoje h, (values
  (time '10:00', 'ATIVO',     'cobranca11@aelbra.com.br', null::uuid),
  (time '11:00', 'ATIVO',     'cobranca11@aelbra.com.br', null),
  (time '12:00', 'QUITADO',   'COBRANCA11@aelbra.com.br', null),
  (time '13:00', 'CANCELADO', 'cobranca11@aelbra.com.br', null),
  (time '13:30', 'cancelado', 'cobranca11@aelbra.com.br', null),
  (time '14:00', 'ATIVO',     'cobranca11@aelbra.com.br', gen_random_uuid()),
  (time '00:30', 'ATIVO',     'cobranca05@aelbra.com.br', null),
  (time '15:00', 'ATIVO',     'cobranca05@aelbra.com.br', null),
  (time '16:00', 'ATIVO',     'cobranca10@aelbra.com.br', null),
  (time '09:00', 'ATIVO',     null, null),
  (time '09:10', 'ATIVO',     '  ', null),
  (time '09:00', 'ATIVO',     'cobranca12@aelbra.com.br', null),
  (time '09:05', 'ATIVO',     'cobranca12@aelbra.com.br', null),
  (time '09:06', 'ATIVO',     'cobranca12@aelbra.com.br', null),
  (time '09:07', 'ATIVO',     'cobranca12@aelbra.com.br', null)
) as v(hora, st, op, dup);
insert into public.acordos (criado_em, status, operador_responsavel_email)
select ((h.d - 1) + time '23:30') at time zone 'America/Sao_Paulo', 'ATIVO', 'cobranca05@aelbra.com.br' from public.teste_hoje h;
