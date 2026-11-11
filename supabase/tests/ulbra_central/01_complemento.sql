-- COMPLEMENTO do ambiente do recebimento para a Central do operador.
-- Roda como superusuario, DEPOIS do seed (02_dados.sql) e ANTES da migration.
-- Em producao `casos.data_ultimo_acionamento` ja existe (date); o ambiente de
-- teste do recebimento nao a tinha porque nada ali a lia.
\set ON_ERROR_STOP on

alter table public.casos add column if not exists data_ultimo_acionamento date;

-- A (op1): 12 dias sem acionamento -> PERDENDO. B (op2): 2 dias -> dentro do prazo.
update public.casos set data_ultimo_acionamento = (now() at time zone 'America/Sao_Paulo')::date - 12
 where aluno_id = '00000000-0000-0000-0000-00000000000a';
update public.casos set data_ultimo_acionamento = (now() at time zone 'America/Sao_Paulo')::date - 2
 where aluno_id = '00000000-0000-0000-0000-00000000000b';

-- Aluno D, de op1, cuja ultima mensagem e do OPERADOR: nao e resposta aguardando.
insert into public.alunos (id, nome) values ('00000000-0000-0000-0000-00000000000d', 'Aluno D');
insert into public.casos (aluno_id, operador_email, data_ultimo_acionamento)
values ('00000000-0000-0000-0000-00000000000d', 'OP1@x', (now() at time zone 'America/Sao_Paulo')::date - 9);

insert into public.ulbra_conversas
  (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, situacao, equipe,
   responsavel_ulbra, ultima_mensagem_em, ultima_mensagem_quem, ultima_mensagem_previa,
   ultima_mensagem_cliente_em, aluno_id, aluno_status)
values
  -- identidade NAO confirmada, com mensagem do cliente: nao pode sair para ninguem
  ('c4', 'k8', 'Contato Sem CPF', 'active', 'Reativa', null, '2026-11-08 02:00+00', 'cliente', 'segredo-c4',
   '2026-11-08 02:00+00', null, 'nao_confirmado'),
  ('c5', 'k5', 'Aluno D', 'active', 'Reativa', 'Atendente Ulbra', '2026-11-08 06:00+00', 'operador', 'ja respondi',
   '2026-11-08 01:00+00', '00000000-0000-0000-0000-00000000000d', 'vinculado');
