-- Dados fixos. Valores e contagens são conhecidos pelo caso de teste.
insert into public.usuarios (email, perfil, ativo) values
  ('amanda.seibel@aelbra.com.br', 'gerencia', true),       -- gestão ativa
  ('cobranca04@aelbra.com.br',    'supervisor', true),     -- gestão ativa (2ª)
  ('operador@aelbra.com.br',      'operador', true),       -- operador comum, fora da gestão
  ('cobranca07@aelbra.com.br',    'administrativo', false), -- gestão INATIVA
  ('angela.ferreira@aelbra.com.br','diretoria', true);      -- diretoria ativa, fora da gestão
-- Caixa: 2026/2 tem 2 PROVADA+BAIXADO (60+40), 1 CHAVE_EXATA sem status (50),
-- e 1 INDETERMINADA (30) sem semestre. 2026/1 tem 1 PROVADA+BAIXADO (10).
insert into public.efetividade_caixa_origem (valor_pago, data_pagamento, confianca, status_conciliacao, semestre_origem) values
  (60, '2026-10-01', 'PROVADA', 'BAIXADO', '2026/2'),
  (40, '2026-10-02', 'PROVADA', 'BAIXADO', '2026/2'),
  (50, '2026-10-03', 'CHAVE_EXATA', null,  '2026/2'),
  (30, '2026-10-04', 'INDETERMINADA', 'BAIXADO', null),
  (10, '2026-09-01', 'PROVADA', 'BAIXADO', '2026/1');
-- Classificador 2026/2 (stub): 5 títulos, um por faixa.
create or replace function public.carteira_2026_2_classificar()
returns table(titulo_id uuid, valor_original numeric, saldo numeric, faixa text,
              acordo_id uuid, acordo_estado text)
language sql stable as $$
  select gen_random_uuid(), 1000::numeric, 600::numeric, 'SEM_NEGOCIACAO'::text, null::uuid, null::text
  union all select gen_random_uuid(), 500, 200, 'CONVERTIDO', gen_random_uuid(), 'regular'
  union all select gen_random_uuid(), 300, 100, 'EM_CONFERENCIA', null, null
  union all select gen_random_uuid(), 200,  50, 'ACADEMICO', null, null
  union all select gen_random_uuid(), 100,  40, 'CANCELADO', null, null
$$;

-- Negociado 2026/2 conhecido: um acordo com 100 pago e 100 a vencer (ratio 0,5); um título de 400
-- em 2026/2 sem série no Prime (cai no fallback por vencimento). Esperado: negociado 400, recebido 200,
-- saldo 200, 1 título, 1 CPF, 1 acordo.
insert into public.acordos (id, status) values ('00000000-0000-0000-0000-00000000a001', 'ATIVO');
insert into public.parcelas (acordo_id, status, valor, vencimento) values
  ('00000000-0000-0000-0000-00000000a001', 'PAGO', 100, '2026-08-01'),
  ('00000000-0000-0000-0000-00000000a001', 'A_VENCER', 100, '2026-12-01');
insert into public.acordos_titulos (id, aluno_id, cpf, documento, valor_original, situacao, tipo_boleto, vencimento, acordo_id) values
  ('00000000-0000-0000-0000-00000000b001', gen_random_uuid(), '11122233344', 'DOC-NEG-1', 400, 'ABERTO', null, '2026-08-10', '00000000-0000-0000-0000-00000000a001');
