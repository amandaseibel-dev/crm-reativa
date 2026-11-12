-- DADOS SINTÉTICOS. Domínio .teste.local; a gestão usa o e-mail fixo da função
-- (é o único real, e aqui é só uma linha de usuário numa base descartável).
insert into public.usuarios (email, perfil, ativo) values
  ('amanda.seibel@aelbra.com.br', 'gestao', true),
  ('diretoria.sintetica@teste.local', 'diretoria', true),
  ('operador.sintetico@teste.local', 'operador', true),
  ('outro.sintetico@teste.local', 'operador', true),
  ('inativo.sintetico@teste.local', 'operador', false);

insert into public.alunos (unidade) values ('CANOAS'), ('PORTO ALEGRE');

-- Mês corrente: 3 pagamentos válidos (450) + 1 retroativo que NÃO entra.
do $$
declare d date := date_trunc('month', current_date)::date;
begin
  insert into public.pagamentos (aluno_id, data_pagamento, operador_email, operador_nome, valor_pago, valor_honorario, retroativo)
  select (select id from public.alunos limit 1), d, 'operador.sintetico@teste.local', 'Operador Sintetico', 100, 10, false
  union all
  select (select id from public.alunos limit 1), d + 1, 'operador.sintetico@teste.local', 'Operador Sintetico', 50, 5, false
  union all
  select (select id from public.alunos offset 1 limit 1), d + 1, 'outro.sintetico@teste.local', 'Outro Sintetico', 300, 30, false
  union all
  select (select id from public.alunos limit 1), d, 'operador.sintetico@teste.local', 'Operador Sintetico', 999, 99, true;
end $$;
