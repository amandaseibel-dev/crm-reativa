-- A FILA DO JOAO PARA DE MOSTRAR O MESMO NOME DUAS VEZES.
--
-- Amanda, 01/09/2026: "favor retirar os casos duplicados da fila do joao".
--
-- O QUE FOI MEDIDO ANTES: na fila do Joao (856 casos visiveis) NAO existe aluno
-- repetido -- nem por aluno_id, nem por CPF normalizado, nem por matricula.
-- O que existe sao tres pares que a TELA mostra com o mesmo nome, e cada um tem
-- uma causa diferente. Este arquivo trata os DOIS que sao seguros:
--
-- 1) "LEANDRO JUNIOR DE AGUIAR DUTRA" aparecia duas vezes porque o registro da
--    KETELLEN LAGUNA (CPF 042.038.020-59) esta com `nome_aluno` gravado com o
--    nome do Leandro. `alunos.nome`, `nome_normalizado`, `nome_referencia` e o
--    caso dela (13532) todos dizem "Ketellen Laguna" -- so `nome_aluno` diverge,
--    e a fila mostra justamente `nome_aluno` (PainelCarteira, coluna Nome).
--    Nao e duplicidade: sao duas pessoas, dois CPFs, dois telefones e duas
--    dividas reais (R$ 2.326,53 e R$ 2.068,03). E CORRECAO DE NOME, NAO EXCLUSAO.
--
-- 2) "ELIAS GOMES DA SILVA" aparecia duas vezes porque ha um cadastro manual
--    criado em 31/08/2026 as 21:37 (CPF 261.554.328-80, curso "Pedagogia") SEM
--    divida nenhuma: zero titulos, zero acordos, zero casos. O CPF nao bate com
--    o do Elias da carteira (147.389.736-06), entao nao da para fundir os dois
--    -- e tambem nao ha o que cobrar nele. Sai da fila como SEM_SALDO_EM_ABERTO,
--    o mesmo marcador ja usado para cadastro sem saldo em aberto. O registro
--    PERMANECE no banco, visivel na busca e na ficha.
--
-- O QUE NAO FOI TOCADO: "LETICIA MARTINI BITENCOURT" tambem aparece duas vezes,
-- mas sao dois CPFs, dois telefones, duas matriculas e duas dividas diferentes
-- (R$ 1.776,77 e R$ 1.525,06). Homonimas ou uma delas com CPF errado -- fundir
-- apagaria divida legitima. Fica para a gestao decidir.
--
-- DESFAZER: supabase/rollbacks/20260902090000_fila_joao_nome_trocado_e_cadastro_sem_divida.rollback.sql

-- Backup do estado exato de antes (o rollback le daqui, nao de valor escrito na mao).
create table if not exists public._backup_fila_joao_20260902 as
select id, nome, nome_aluno, status_atual, status_jornada, situacao_operacional,
       saldo_total, observacao, now() as salvo_em
from public.alunos
where id in ('38e4bcbe-7a41-48d6-9093-810576a4f158',   -- Ketellen Laguna
             'e0ad076c-b85e-4863-ac4b-09d58f0160c9');  -- cadastro Elias sem divida

alter table public._backup_fila_joao_20260902 enable row level security;
-- Tabela de backup: ninguem le pela API (padrao das demais _backup_*).
drop policy if exists _backup_fila_joao_20260902_deny on public._backup_fila_joao_20260902;
create policy _backup_fila_joao_20260902_deny on public._backup_fila_joao_20260902
  for all to public using (false) with check (false);

-- 1) Devolve o nome da Ketellen. `nome` ja esta certo; so `nome_aluno` diverge.
update public.alunos
   set nome_aluno = nome
 where id = '38e4bcbe-7a41-48d6-9093-810576a4f158'
   and nome = 'Ketellen Laguna'
   and nome_aluno = 'Leandro Junior de Aguiar Dutra';

-- 2) Cadastro sem divida sai da fila. Saldo zerado alem do status: a fila
--    esconde por QUALQUER um dos dois (status nao acionavel OU saldo < R$ 5),
--    e `saldo_total` nulo mantinha o caso na fila de proposito.
update public.alunos
   set status_atual = 'SEM_SALDO_EM_ABERTO',
       status_jornada = 'SEM_SALDO_EM_ABERTO',
       saldo_total = 0,
       observacao = concat_ws(' | ', nullif(observacao, ''),
         'Cadastro de 31/08/2026 sem divida (0 titulos, 0 acordos, 0 casos) e com CPF diferente do Elias da carteira. Fora da fila em 02/09/2026 a pedido da gestao.')
 where id = 'e0ad076c-b85e-4863-ac4b-09d58f0160c9'
   and status_atual = 'CONTATAR';
