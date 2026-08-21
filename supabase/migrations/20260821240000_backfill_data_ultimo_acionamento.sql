-- Backfill: alunos que ja tiveram tabulacao (FINALIZACAO) mas estavam com
-- data_ultimo_acionamento NULL apareciam como "Nunca acionado" e ficavam fora
-- do card "Sem acionamento (risco de perder)". Preenche com a ultima
-- FINALIZACAO registrada em aluno_movimentacoes. Rollback em
-- _backup_alunos_dua_20260821 (RLS deny-all).
create table if not exists public._backup_alunos_dua_20260821 as
select a.id, a.data_ultimo_acionamento as dua_antes, u.ultima as dua_depois, now() as em
from public.alunos a
join (select aluno_id, max(registrado_em) ultima
      from public.aluno_movimentacoes
      where tipo in ('FINALIZACAO_ATENDIMENTO','FINALIZACAO') group by 1) u
  on u.aluno_id = a.id::text
where a.data_ultimo_acionamento is null;
alter table public._backup_alunos_dua_20260821 enable row level security;

update public.alunos a
set data_ultimo_acionamento = b.dua_depois
from public._backup_alunos_dua_20260821 b
where b.id = a.id and a.data_ultimo_acionamento is null;
