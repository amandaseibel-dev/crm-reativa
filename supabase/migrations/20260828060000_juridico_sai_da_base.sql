-- Aluno enviado ao juridico (ou com cobranca cancelada) deve sair da base operacional.
-- Problema: o status ficava so em alunos.status_atual. O gatilho casos_set_encerrado_operacional
-- le casos.status_atual, entao 30 dos 51 alunos no juridico seguiam contando na carteira.
-- Correcao: propagar o encerramento do aluno para o caso, agora e daqui pra frente.

-- 1) Backup do que sera alterado
create table if not exists public._backup_juridico_sai_da_base_20260828 as
select c.id as caso_id, c.aluno_id, c.nome, c.status_atual as caso_status_antes,
       c.encerrado_operacional as encerrado_antes, al.status_atual as aluno_status,
       c.saldo_total, now() as ajustado_em
from public.casos c
join public.alunos al on al.id = c.aluno_id
where upper(coalesce(al.status_atual,'')) in ('JURIDICO','CANCELAMENTO_COBRANCA')
  and not coalesce(c.encerrado_operacional, false);

-- 2) Backfill: leva o status do aluno para o caso (o gatilho existente encerra sozinho)
update public.casos c
   set status_atual = case upper(al.status_atual)
                        when 'JURIDICO' then 'JURIDICO'
                        else 'CANCELAMENTO COBRANCA' end
  from public.alunos al
 where al.id = c.aluno_id
   and upper(coalesce(al.status_atual,'')) in ('JURIDICO','CANCELAMENTO_COBRANCA')
   and not coalesce(c.encerrado_operacional, false);

-- 3) Daqui pra frente: quando a gestao marcar o aluno, o caso acompanha
create or replace function public.alunos_propaga_encerramento_para_caso()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if upper(coalesce(new.status_atual,'')) is distinct from upper(coalesce(old.status_atual,''))
     and upper(coalesce(new.status_atual,'')) in ('JURIDICO','CANCELAMENTO_COBRANCA') then
    update public.casos
       set status_atual = case upper(new.status_atual)
                            when 'JURIDICO' then 'JURIDICO'
                            else 'CANCELAMENTO COBRANCA' end
     where aluno_id = new.id
       and not coalesce(encerrado_operacional, false);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_aluno_encerramento_propaga on public.alunos;
create trigger trg_aluno_encerramento_propaga
after update of status_atual on public.alunos
for each row execute function public.alunos_propaga_encerramento_para_caso();
