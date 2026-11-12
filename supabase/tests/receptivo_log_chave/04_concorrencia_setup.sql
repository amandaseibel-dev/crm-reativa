-- Fixture da corrida (duas conexoes). Conversas ficticias.
insert into public.whatsapp_conversas (id, telefone_e164, responsavel_email, responsavel_desde) values
  ('00000000-0000-0000-0000-00000000f001','5551930000001','op_a@test.local', timestamptz '2026-11-13 10:00:00-03'),
  ('00000000-0000-0000-0000-00000000f002','5551930000002','op_a@test.local', timestamptz '2026-11-13 10:00:00-03'),
  ('00000000-0000-0000-0000-00000000f003','5551930000003','op_a@test.local', timestamptz '2026-11-13 10:00:00-03');
