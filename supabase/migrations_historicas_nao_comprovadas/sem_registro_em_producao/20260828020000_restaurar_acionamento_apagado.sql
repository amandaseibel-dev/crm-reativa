-- Restaurar o acionamento que a troca de dono apagou.
--
-- Par da migration 20260828010000, que fecha a torneira. Esta enxuga o chao.
--
-- A DATA NUNCA SE PERDEU: esta em `aluno_movimentacoes`. O que sumiu foi so o
-- campo `alunos.data_ultimo_acionamento`, zerado na troca de responsavel.
--
-- QUAIS TIPOS SAO ACIONAMENTO, e isso decidiu tudo. A primeira ideia era usar
-- "a ultima movimentacao do aluno" -- e teria sido um desastre. Olhando os
-- tipos dos 4.787 candidatos, os mais frequentes eram REDISTRIBUICAO_
-- SINCRONIZACAO (3.282) e CARGA_RETROATIVA (1.303): eventos de sistema, nao
-- contato com aluno. Restaurar por ali carimbaria data de redistribuicao como
-- se fosse ligacao.
--
-- Descobri os tipos certos EMPIRICAMENTE: entre os alunos que TEM acionamento,
-- quais movimentacoes caem no mesmo dia do campo. Tres respondem por quase tudo
-- e sao contato inequivoco:
--
--     FINALIZACAO_ATENDIMENTO      4.952 alunos  (tabulacao do operador)
--     ACAO_MASSIVA_EXTERNA         3.734
--     ACAO_MASSIVA_EXTERNA_EMAIL     519
--
-- Tipos como ZERADO_REAL_SEM_SALDO e QUITADO_MANUAL tambem coincidem por data,
-- mas nao sao acionamento -- ficaram de fora.
--
-- RESULTADO: 1.826 alunos com o acionamento de volta, o mais antigo de 02/07 e
-- o mais recente de 27/08. Destes, 1.047 tem dono -- gente que o operador
-- acionou e o sistema fez parecer que nunca tinha sido tocada.
--
-- 657 passam a ficar dentro do prazo de fidelizacao (acionados ha menos de 10
-- dias) e saem da redistribuicao -- que e o correto: foram mesmo acionados.
--
-- Reversivel por _backup_acionamento_restaurado_20260828, que guarda aluno e
-- data aplicada.

create table if not exists public._backup_acionamento_restaurado_20260828 (
  aluno_id uuid primary key,
  acionamento_restaurado timestamptz not null,
  tipo_origem text,
  restaurado_em timestamptz not null default now()
);

with acion as (
  select m.aluno_id, max(m.registrado_em) as quando
  from public.aluno_movimentacoes m
  where m.tipo in ('FINALIZACAO_ATENDIMENTO','ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')
  group by 1
),
alvo as (
  select a.aluno_id::uuid as aluno_id, a.quando
  from acion a join public.alunos al on al.id::text = a.aluno_id
  where al.data_ultimo_acionamento is null
)
insert into public._backup_acionamento_restaurado_20260828 (aluno_id, acionamento_restaurado, tipo_origem)
select aluno_id, quando, 'movimentacao' from alvo
on conflict (aluno_id) do nothing;

update public.alunos al
   set data_ultimo_acionamento = b.acionamento_restaurado
  from public._backup_acionamento_restaurado_20260828 b
 where al.id = b.aluno_id and al.data_ultimo_acionamento is null;
