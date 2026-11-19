-- Usuarios e parametros de TESTE, carregados em cada banco descartavel do CI.
-- Nao e producao: e o elenco minimo que os cenarios usam.
insert into public.usuarios (nome, email, perfil, ativo, recebe_novos_casos) values
  ('Amanda', 'amanda.seibel@aelbra.com.br', 'gerencia', true, true),
  ('Fernanda', 'cobranca04@aelbra.com.br', 'supervisor', true, true),
  ('Luana', 'cobranca05@aelbra.com.br', 'operador', true, true),
  ('Mauricio', 'cobranca06@aelbra.com.br', 'operador', true, true),
  ('Diego', 'cobranca13@aelbra.com.br', 'operador', true, true),
  ('Olga', 'cobranca03@aelbra.com.br', 'operador', false, false),
  ('Carteira Geral', 'carteira.geral@reativa.local', 'carteira', false, true)
on conflict (email) do nothing;
insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '700'::jsonb)
on conflict (chave) do nothing;
