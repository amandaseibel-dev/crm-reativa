-- OS 16 CADASTROS VAZIOS DA CARGA SAEM DA BASE ATIVA.
--
-- Amanda, 02/09/2026: "limpa os 16 vazios".
--
-- O QUE SAO: 16 registros criados em 29/06/2026 (15 pela carga
-- `sistema@reativaone`, 1 pela Rafaella) com NOME e mais NADA -- sem CPF, sem
-- telefone, sem matricula, sem saldo. Cada um tem um GEMEO de mesmo nome, esse
-- sim completo, com CPF, telefone, matricula e divida. E o mesmo padrao do
-- caso-fantasma ja corrigido na tabela `casos` em 28/08, que nunca foi limpo
-- em `alunos` -- e `alunos` e a tabela que alimenta a fila.
--
-- CONFERIDO ANTES, UM A UM: os 16 tem ZERO casos, ZERO acordos e ZERO
-- solicitacoes de confirmacao de pagamento. Nenhum tem responsavel. Nao ha
-- divida presa neles.
--
-- MAS DOIS RECEBERAM TRABALHO DE VERDADE -- e a prova de que a copia vazia
-- rouba o atendimento do cadastro certo:
--   * William Pacheco da Silva: a Rafaella ASSUMIU o atendimento em 10/07 e
--     finalizou como AGUARDANDO_BAIXA -- tudo na copia vazia.
--   * Adriana de Carvalho Chaves: a Amanda marcou QUITADO_MANUAL em 16/07,
--     tambem na copia.
-- Nesses dois o gemeo recebe uma observacao apontando para ca, para que o
-- historico nao se perca de vista.
--
-- ENCERRAR, NAO APAGAR. O registro fica no banco com todo o historico
-- (`aluno_movimentacoes`), continua achavel na busca e na ficha, e some
-- apenas da fila operacional. Apagar levaria junto o que a Rafaella e a Amanda
-- fizeram -- e e justamente esse rastro que explica o problema.
--
-- Os 13 que ainda estao como "Novo caso" viram SEM_SALDO_EM_ABERTO com saldo
-- zero (a fila esconde por qualquer um dos dois). Os 3 que ja estao fora
-- (2 ENCERRADO, 1 QUITADO_MANUAL) mantem o status: reescrever apagaria a
-- decisao de quem os encerrou.
--
-- DESFAZER: supabase/rollbacks/20260902100000_encerrar_cadastros_vazios_da_carga.rollback.sql

create table if not exists public._backup_cadastros_vazios_20260902 as
select id, nome, status_atual, status_jornada, saldo_total, observacao, now() as salvo_em
from public.alunos
where id in (
  'aad69626-b86b-4305-b120-c7b9fa1f1b14', -- Adriana de Carvalho Chaves
  '908c8070-599e-4590-9524-3960aee6e51b', -- Barbara da Silva Rodrigues
  '3ae22cf2-ab48-4764-b4c9-6a71d739be31', -- Carlos Eduardo Brito Rolim
  '71f8ce18-c4f9-485e-ad9f-fbf12871f38c', -- Fabiano Goggia Melleu Rocha Junior
  '309977cd-48a2-4280-a56d-c04880319e9d', -- Gabriela Gross Antunes Bowenschulte
  'bf1499d9-c70a-4477-8e98-51d0f6dedc65', -- Joao Victor de Souza Couto
  '88edb9d7-be14-4cbc-9d1b-53a16861db56', -- Joao Vitor Reetz de Souza
  'ab2c1e83-48e0-4427-99b9-a1e64b6ebf32', -- Jonathan Willhians Barbosa Francke
  '1e434e51-cd7c-4b0b-83b7-b9a803e48e69', -- Macaury Douglas Rabelo Carvalho
  '32eb0d89-6529-4b0f-8a5a-174056f2a088', -- Ricardo Lima de Oliveira
  '98cf6b29-1e95-4e00-b1ed-e2fabf7d3e4e', -- Samuel Silvino Soares Nunes
  '7b7c0565-893d-4f92-9869-08abb3919ae4', -- Taissa Braga Quiquio
  'd7520453-2063-4f1b-b1e8-42e693b23625', -- Tassiana Szulczewski
  '3e6eb785-fe2b-4c70-a30f-3eed906004ac', -- Ulisses Lucas
  'a231d9c0-35ed-46a9-887e-859b56346c0a', -- Vitoria Daiane Marocco
  '74e954eb-de5f-4332-b6eb-f7aa3580df2c', -- William Pacheco da Silva
  -- gemeos que recebem observacao (para o rollback devolver o texto original)
  '5a13b49f-8f43-4484-ab71-1a7ddf3a9b98', -- gemeo da Adriana
  '6c625417-5567-45b1-950c-50101d5c7d83'  -- gemeo do William
);

alter table public._backup_cadastros_vazios_20260902 enable row level security;
drop policy if exists _backup_cadastros_vazios_20260902_deny on public._backup_cadastros_vazios_20260902;
create policy _backup_cadastros_vazios_20260902_deny on public._backup_cadastros_vazios_20260902
  for all to public using (false) with check (false);

-- 1) Os 13 que ainda estavam na base ativa saem da fila.
update public.alunos
   set status_atual = 'SEM_SALDO_EM_ABERTO',
       status_jornada = 'SEM_SALDO_EM_ABERTO',
       saldo_total = 0
 where id in (select id from public._backup_cadastros_vazios_20260902)
   and status_atual = 'Novo caso';

-- 2) Todos os 16 dizem por que sairam e para onde olhar.
update public.alunos a
   set observacao = concat_ws(' | ', nullif(a.observacao, ''),
         'Cadastro vazio da carga de 29/06/2026 (sem CPF, telefone, matricula ou saldo). '
         || 'Encerrado em 02/09/2026: o cadastro completo desta pessoa e outro. Registro mantido pelo historico.')
 where a.id in (select id from public._backup_cadastros_vazios_20260902)
   and a.id not in ('5a13b49f-8f43-4484-ab71-1a7ddf3a9b98','6c625417-5567-45b1-950c-50101d5c7d83');

-- 3) Os dois gemeos que perderam atendimento para a copia ficam sabendo.
update public.alunos
   set observacao = concat_ws(' | ', nullif(observacao, ''),
         'Havia um cadastro vazio com este mesmo nome (encerrado em 02/09/2026) e o '
         || 'atendimento de 10/07/2026 da Rafaella foi registrado la, nao aqui.')
 where id = '6c625417-5567-45b1-950c-50101d5c7d83';

update public.alunos
   set observacao = concat_ws(' | ', nullif(observacao, ''),
         'Havia um cadastro vazio com este mesmo nome (encerrado em 02/09/2026) e a '
         || 'quitacao manual de 16/07/2026 foi registrada la, nao aqui.')
 where id = '5a13b49f-8f43-4484-ab71-1a7ddf3a9b98';
