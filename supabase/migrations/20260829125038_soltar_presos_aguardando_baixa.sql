-- Alunos presos em AGUARDANDO_BAIXA sem nada pendente voltam para cobranca.
--
-- A rejeicao de pagamento devolvia o OPERADOR e esquecia o STATUS: o aluno ficava
-- em AGUARDANDO_BAIXA para sempre. Como esse status esta em STATUS_NAO_ACIONAVEIS
-- na Carteira, o caso sumia da fila do operador -- invisivel, nao cobrado, e sem
-- nenhum caminho de volta.
--
-- Amanda descobriu pelo avesso: "baixei diversos ontem" e um caso nao saiu. Ao
-- puxar o fio, o que apareceu foi o contrario do esperado -- os que deviam sair
-- sairam (a Carteira ja filtra), e os que deviam VOLTAR nunca voltaram.
--
-- Medido em 29/08/2026: 480 casos abertos com aluno em AGUARDANDO_BAIXA e ZERO
-- solicitacao pendente. 304 com saldo VENCIDO somando R$ 906.949,69; 176 com
-- acordo em dia; nenhum sem saldo. No total da base eram 3.774 alunos nesse
-- status para apenas 476 solicitacoes abertas.
--
-- Volta para 'CONTATAR': acionavel e neutro, nao afirma nada sobre o passado. O
-- status anterior nao da para recuperar -- audit_log nao registra mudanca de
-- status_atual em alunos.
--
-- O acionamento nao se perde: trg_acionamento_nao_volta_para_nulo protege
-- data_ultimo_acionamento e a tabulacao (premissa 9).
--
-- Backup: public._backup_presos_aguardando_baixa_20260829. Desfazer e um UPDATE
-- a partir dela.

create table if not exists public._backup_presos_aguardando_baixa_20260829 (
  aluno_id uuid primary key,
  status_anterior text,
  status_jornada_anterior text,
  saldo_vencido numeric,
  saldo_total numeric,
  gravado_em timestamptz default now()
);
alter table public._backup_presos_aguardando_baixa_20260829 enable row level security;

insert into public._backup_presos_aguardando_baixa_20260829
  (aluno_id, status_anterior, status_jornada_anterior, saldo_vencido, saldo_total)
select al.id, al.status_atual, al.status_jornada, al.saldo_vencido, al.saldo_total
  from public.casos c
  join public.alunos al on al.id = c.aluno_id
 where not coalesce(c.encerrado_operacional,false)
   and not public.caso_encerrado_operacional(c.cpf, c.status_atual, c.status_acionamento,
                                             c.status_financeiro, c.status_jornada)
   and upper(coalesce(al.status_atual,'')) = 'AGUARDANDO_BAIXA'
   and not exists (
     select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = al.id::text
        and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))
on conflict (aluno_id) do nothing;

update public.alunos al
   set status_atual = 'CONTATAR',
       status_jornada = 'CONTATAR'
  from public._backup_presos_aguardando_baixa_20260829 b
 where al.id = b.aluno_id
   and upper(coalesce(al.status_atual,'')) = 'AGUARDANDO_BAIXA';

-- Resultado: 480 soltos, R$ 906.949,69 de saldo vencido de volta a cobranca.
