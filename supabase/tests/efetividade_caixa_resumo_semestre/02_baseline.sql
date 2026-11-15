-- Dados fixos. Valores e contagens são conhecidos pelo caso de teste.
insert into public.usuarios (email, perfil, ativo) values
  ('amanda.seibel@aelbra.com.br', 'gerencia', true),       -- gestão ativa
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
