-- CENÁRIO DA CONFERÊNCIA POR ARQUIVO
-- -----------------------------------------------------------------------------
-- Complemento da bancada `fluxo_incremental_prod_20261021.sql`, que já traz
-- `pagamentos`, `parcelas`, `fila_pagamento_sem_vinculo`, `auth.jwt()` e
-- `usuario_e_gestao()`. Aqui entra só o que falta para a view da conferência:
-- as colunas de arquivo e de evidência, duas tabelas, e um cenário pequeno.
--
-- POR QUE UM CENÁRIO SINTÉTICO, e o que ele NÃO prova: ele prova que o
-- CLASSIFICADOR particiona sem duplicar e sem resíduo, e que os dois fenômenos
-- medidos em produção são tratados. NÃO prova que a produção tem estes números
-- -- as medições de 23/10/2026 estão no cabeçalho da migration, com as
-- consultas que as produziram.
--
-- OS DOIS FENÔMENOS REPRODUZIDOS DE PROPÓSITO, porque são os que fariam a tela
-- mentir se fossem ignorados:
--   * P2 -- pagamento BAIXADO que TAMBÉM tem linha na fila, já resolvida. Em
--     produção são 246. Tem de continuar contando como baixa registrada e NÃO
--     aparecer como pendência.
--   * P7 -- pagamento do arquivo B cuja linha de fila aponta para o arquivo A.
--     Em produção são 115. Para o arquivo A ele é "pendência histórica
--     relacionada", destacada e FORA das contagens.

-- -----------------------------------------------------------------------------
-- O que falta na bancada base
-- -----------------------------------------------------------------------------
alter table public.pagamentos add column if not exists importacao_id uuid;
alter table public.pagamentos add column if not exists valor_honorario numeric;
alter table public.pagamentos add column if not exists aluno_nome text;
alter table public.pagamentos add column if not exists matricula text;
alter table public.pagamentos add column if not exists titulo_numero text;
alter table public.pagamentos add column if not exists numero_parcela_completo text;
alter table public.pagamentos add column if not exists operador_email text;
alter table public.pagamentos add column if not exists operador_nome text;

-- A EVIDÊNCIA da baixa registrada. `origem_baixa_ref` é TEXT em produção, e o
-- cast no join (`p.id::text`) existe por causa disso -- não por preferência.
alter table public.parcelas add column if not exists origem_baixa text;
alter table public.parcelas add column if not exists origem_baixa_ref text;
alter table public.parcelas add column if not exists origem_baixa_em timestamptz;

-- A fila da bancada base e reduzida: falta o que liga a linha ao ARQUIVO e as
-- sugestoes que governam a categoria ACIONAVEL_ADMINISTRATIVO da triagem.
alter table public.fila_pagamento_sem_vinculo add column if not exists importacao_id uuid;
alter table public.fila_pagamento_sem_vinculo add column if not exists arquivo_nome text;
alter table public.fila_pagamento_sem_vinculo add column if not exists sugestoes jsonb;
alter table public.fila_pagamento_sem_vinculo add column if not exists valor_honorario numeric;

-- A migration da #737 RECUSA aplicar sem este indice, e com razao: e ele que
-- garante uma linha de fila por pagamento. Em producao ele existe -- medido:
-- zero pagamentos com duas linhas. A bancada base nao o traz.
create unique index if not exists uq_fila_pagamento_sem_vinculo_pagamento
  on public.fila_pagamento_sem_vinculo (pagamento_id);

create table if not exists public.importacoes (
  id uuid primary key,
  tipo text, referencia text, arquivo_nome text, usuario text,
  qtd_registros integer default 0, status text,
  created_at timestamp without time zone default now(),
  retroativo boolean default false, mes_referencia text, dia_pagamento date
);

create table if not exists public.pagamento_suspeita_duplicidade (
  id uuid primary key default gen_random_uuid(),
  pagamento_id uuid,
  detectado_em timestamptz default now()
);

-- `auth.role()` é usada pelo portão das duas funções. A bancada base traz
-- `auth.jwt()`, não esta.
create or replace function auth.role() returns text
  language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

-- -----------------------------------------------------------------------------
-- O CENÁRIO
-- -----------------------------------------------------------------------------
-- Três arquivos. Valores distintos de propósito: assim a soma por categoria é
-- verificável sem ambiguidade (100+200 = 300 só pode ser P1+P2).
insert into public.importacoes (id, tipo, arquivo_nome, usuario, qtd_registros, status, created_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'PROJECAO_DIARIA', 'arquivo-A.xlsx', 'amanda.seibel@aelbra.com.br', 6, 'CONCLUIDO', '2026-10-23 12:00:00'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'PROJECAO_DIARIA', 'arquivo-B.xlsx', 'amanda.seibel@aelbra.com.br', 1, 'CONCLUIDO', '2026-10-22 12:00:00'),
  -- Arquivo sem NENHUM pagamento: em produção são 230. Tem de aparecer na
  -- lista com zero, senão a gestão não distingue "importou zero" de "não está".
  ('cccccccc-0000-0000-0000-00000000000c', 'PROJECAO_DIARIA', 'arquivo-C-vazio.xlsx', 'amanda.seibel@aelbra.com.br', 0, 'CONCLUIDO', '2026-10-21 12:00:00')
on conflict (id) do nothing;

insert into public.pagamentos
  (id, importacao_id, data_pagamento, valor_pago, valor_honorario, aluno_nome, matricula,
   titulo_numero, numero_parcela_completo, operador_nome, status_conciliacao, origem_vinculo, created_at)
values
  -- P1 BAIXA_REGISTRADA_CRM simples
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-20', 100, 10,
   'ALUNO UM', '2026000001', '50001', '50001510001', 'MARIA', 'BAIXADO', 'BOLETO_EXATO', now()),
  -- P2 BAIXA_REGISTRADA_CRM com linha de fila JÁ RESOLVIDA (os 246)
  ('22222222-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-20', 200, 20,
   'ALUNO DOIS', '2026000002', '50002', '50002510001', 'MARIA', 'BAIXADO', 'BOLETO_EXATO', now()),
  -- P3 DIVERGENCIA: acordo cancelado -> CONFERENCIA_HUMANA na triagem
  ('33333333-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-20', 300, 30,
   'ALUNO TRES', '2026000003', '50003', '50003510001', 'JOAO', 'REVISAO', null, now()),
  -- P4 SEM_VINCULO: acordo nao esta no CRM -> AGUARDANDO_INFORMACAO_ACORDO
  ('44444444-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-20', 400, 40,
   'ALUNO QUATRO', '2026000004', '50004', '50004510001', 'JOAO', 'AGUARDANDO_ACORDO', null, now()),
  -- P5 BAIXA_PENDENTE: tem sugestao de aluno -> ACIONAVEL_ADMINISTRATIVO
  ('55555555-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-20', 500, 50,
   'ALUNO CINCO', '2026000005', '50005', '50005510001', 'LUANA', 'PARCELA_JA_PAGA', null, now()),
  -- P6 FORA_DA_JANELA (status nulo) e com suspeita de duplicidade -- em
  -- producao as 9 suspeitas sao TODAS pre-14/09, exatamente assim
  ('66666666-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-08-15', 600, 60,
   'ALUNO SEIS', '2026000006', '50006', '50006510001', 'LUANA', null, null, now()),
  -- P7 pertence ao arquivo B, mas a linha de fila dele aponta para o A (os 115)
  ('77777777-0000-0000-0000-000000000007', 'bbbbbbbb-0000-0000-0000-00000000000b', '2026-10-19', 700, 70,
   'ALUNO SETE', '2026000007', '50007', '50007510001', 'DIEGO', 'REVISAO', null, now())
on conflict (id) do nothing;

-- A EVIDÊNCIA: parcela apontando para o pagamento. Uma por pagamento -- em
-- producao o apontamento e 1 PARA 1 ESTRITO (1.322 refs, 1.322 distintas).
insert into public.parcelas (id, acordo_id, numero, valor, vencimento, status, origem_baixa, origem_baixa_ref, origem_baixa_em)
values
  ('aa111111-0000-0000-0000-000000000001', null, 1, 100, '2026-10-10', 'PAGO',
   'GATILHO_IMPORTACAO', '11111111-0000-0000-0000-000000000001', '2026-10-20 10:00:00'),
  ('aa222222-0000-0000-0000-000000000002', null, 1, 200, '2026-10-10', 'PAGO',
   'GATILHO_IMPORTACAO', '22222222-0000-0000-0000-000000000002', '2026-10-20 10:00:00')
on conflict (id) do nothing;

-- A FILA. `motivo` é o que governa a categoria da triagem da #737, então o
-- texto aqui segue os padrões que ela reconhece.
-- `id` da fila e bigserial na bancada (e em producao), nao uuid.
insert into public.fila_pagamento_sem_vinculo
  (id, pagamento_id, importacao_id, arquivo_nome, boleto, data_pagamento, valor_pago,
   motivo, sugestoes, decisao, conclusao, consulta_portador_em, detectado_em)
values
  -- P2: fila JÁ RESOLVIDA (tem conclusao). Nao pode virar pendencia.
  (2, '22222222-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-00000000000a', 'arquivo-A.xlsx', '50002510001', '2026-10-20', 200,
   'resolvido pelo vinculo exato', '[]'::jsonb, null, 'RESOLVIDO', now(), now()),
  -- P3: acordo CANCELADO -> CONFERENCIA_HUMANA -> DIVERGENCIA
  (3, '33333333-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-00000000000a', 'arquivo-A.xlsx', '50003510001', '2026-10-20', 300,
   'o acordo esta CANCELADO, nao ATIVO', '[]'::jsonb, null, null, now(), now()),
  -- P4: acordo nao esta no CRM -> AGUARDANDO_INFORMACAO_ACORDO -> SEM_VINCULO.
  -- `consulta_portador_em` preenchido de proposito: sem isso o ramo de
  -- `etapa_desligada` poderia capturar a linha antes e virar BLOQUEADO.
  (4, '44444444-0000-0000-0000-000000000004',
   'aaaaaaaa-0000-0000-0000-00000000000a', 'arquivo-A.xlsx', '50004510001', '2026-10-20', 400,
   'o acordo nao esta no CRM', '[]'::jsonb, null, null, now(), now()),
  -- P5: tem sugestao -> ACIONAVEL_ADMINISTRATIVO -> BAIXA_PENDENTE
  (5, '55555555-0000-0000-0000-000000000005',
   'aaaaaaaa-0000-0000-0000-00000000000a', 'arquivo-A.xlsx', '50005510001', '2026-10-20', 500,
   'aluno nao identificado pelo boleto',
   '[{"aluno_id":"00000000-0000-0000-0000-000000000009","nome":"ALUNO SUGERIDO"}]'::jsonb,
   null, null, now(), now()),
  -- P7: a linha aponta para o ARQUIVO A, mas o pagamento e do B (os 115)
  (7, '77777777-0000-0000-0000-000000000007',
   'aaaaaaaa-0000-0000-0000-00000000000a', 'arquivo-A.xlsx', '50007510001', '2026-10-19', 700,
   'o acordo esta CANCELADO, nao ATIVO', '[]'::jsonb, null, null, now(), now())
on conflict (id) do nothing;

insert into public.pagamento_suspeita_duplicidade (id, pagamento_id)
values ('dd666666-0000-0000-0000-000000000006', '66666666-0000-0000-0000-000000000006')
on conflict (id) do nothing;
