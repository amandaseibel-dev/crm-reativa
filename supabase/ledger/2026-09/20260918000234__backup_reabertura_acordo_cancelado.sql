-- AUDITORIA DO "ANTES" da reabertura de 18/09/2026.
-- Guarda o estado de cada caso e de cada aluno tocado ANTES de qualquer troca
-- de status para 'Em cobrança'. Sem isto, o status anterior se perde.
create table if not exists public._backup_reabertura_acordo_cancelado_20260918 as
select c.id as caso_id, c.aluno_id, c.cpf_limpo, c.nome,
       c.operador_email, c.operador_nome,
       c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada,
       c.situacao_operacional, c.nao_acionar, c.encerrado_operacional,
       c.caso_atualizado_por, c.caso_atualizado_em,
       a.status_atual  as aluno_status_atual,
       a.status_jornada as aluno_status_jornada,
       a.status_acionamento as aluno_status_acionamento,
       a.responsavel_atual_email, a.responsavel_atual_nome,
       a.saldo_total as aluno_saldo_total,
       now() as capturado_em
  from public.casos c
  join public.alunos a on a.id = c.aluno_id
 where c.status_acionamento = 'CANCELADO'
    or upper(coalesce(c.status_atual,'')) ~ 'COBRAN.A CANCELADA';

-- Backup e dado sensivel: deny-all, como as demais tabelas de backup.
alter table public._backup_reabertura_acordo_cancelado_20260918 enable row level security;
