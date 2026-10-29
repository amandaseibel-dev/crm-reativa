-- Tirar da carteira o caso que nao deve nada.
--
-- Amanda, 27/08/2026: "esse casos sem saldo precisa tirar"; e depois, sobre o
-- metodo: "alunos sem saldo pode tirar, deixa so na aba de confirmacao para
-- futura conferencia mas nao conta na carteira".
--
-- A tela contava 807 casos com saldo zero como carteira ativa. Dois grupos:
--     644 com situacao AGUARDANDO_CONFIRMACAO
--     163 marcados como QUITADO
--
-- E dos 163, CENTO E QUARENTA E OITO nao tinham `quitado_em` preenchido: o
-- status dizia QUITADO e o campo que a carteira usa para excluir estava vazio.
-- A tela le o campo, nao o texto.
--
-- O QUE ME FEZ NAO TIRAR OS 807. Conferi cada um pela funcao canonica
-- (aluno_saldo_pendente_detalhe) antes de mexer, e o resultado mudou a acao:
--
--     dos 644 aguardando confirmacao, 513 TEM saldo -- R$ 1.632.882,21.
--     Zero pelas duas fontes: so 131.
--
-- Ou seja: tirar os 807 teria apagado R$ 1,6 milhao de divida real da carteira.
-- O `saldo_total` da propria tela esta errado para esses 513 -- e outro defeito,
-- ainda por corrigir.
--
-- SAIRAM 288: os 157 QUITADO e os 131 AGUARDANDO_CONFIRMACAO que estao zerados
-- pelas DUAS fontes.
--
-- COMO SAIRAM, e isso importa: marcar `quitado_em` dispararia
-- fechar_confirmacao_ao_quitar_caso e fecharia a confirmacao junto -- o oposto
-- do que ela pediu. Usei status_atual = 'SEM_SALDO_EM_ABERTO', que
-- caso_encerrado_operacional ja trata como encerrado e que nenhum gatilho de
-- quitacao observa. O caso sai da carteira; a fila de confirmacao nao e tocada.
--
-- (Conferido depois: nenhum dos 288 tinha confirmacao aberta. A view dizia
-- "aguardando confirmacao" para 131 deles, mas a fila real nao tinha nada --
-- ja estavam resolvidos.)
--
-- EFEITO: carteira de 14.224 para 13.936 casos; saldo praticamente parado
-- (R$ 46.211.544,19 -> R$ 46.209.091,84), que e a prova de que saiu so o que
-- nao devia nada.
--
-- Estado anterior em _backup_carteira_saldo_zero_20260827.

create table if not exists public._backup_carteira_saldo_zero_20260827 (
  caso_id uuid primary key,
  aluno_id uuid,
  situacao_antes text,
  quitado_em_antes timestamptz,
  origem_antes text,
  status_atual_antes text,
  status_jornada_antes text,
  retirado_em timestamptz default now()
);

with alvo as (
  select v.caso_id, v.aluno_id, v.situacao_operacional
  from public.vw_saude_carteira v
  where not v.encerrado and coalesce(v.saldo_total,0) <= 0.005
    and v.situacao_operacional in ('QUITADO','AGUARDANDO_CONFIRMACAO')
),
conferido as (
  -- Fonte canonica, nao o saldo da propria tela.
  select a.* from alvo a
  where coalesce((public.aluno_saldo_pendente_detalhe(a.aluno_id)->>'total')::numeric, 1) <= 0.005
)
insert into public._backup_carteira_saldo_zero_20260827
  (caso_id, aluno_id, situacao_antes, quitado_em_antes, origem_antes, status_atual_antes, status_jornada_antes)
select c.caso_id, c.aluno_id, c.situacao_operacional, ca.quitado_em, ca.origem_quitacao,
       ca.status_atual, ca.status_jornada
from conferido c join public.casos ca on ca.id = c.caso_id
on conflict (caso_id) do nothing;

update public.casos c
   set status_atual = 'SEM_SALDO_EM_ABERTO'
  from public._backup_carteira_saldo_zero_20260827 b
 where c.id = b.caso_id
   and coalesce(c.status_atual,'') <> 'SEM_SALDO_EM_ABERTO';
