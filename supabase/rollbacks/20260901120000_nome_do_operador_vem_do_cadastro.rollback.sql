-- Rollback de 20260901120000. Rodar DEPOIS de 20260901130000.rollback.sql
-- (as RPCs da Efetividade passam a chamar nome_do_operador()).
begin;

drop trigger if exists trg_nome_do_operador_no_caso on public.casos;
drop trigger if exists trg_nome_do_operador_no_aluno on public.alunos;
drop function if exists public._nome_do_operador_no_caso();
drop function if exists public._nome_do_operador_no_aluno();

-- devolve os nomes que estavam gravados antes do backfill
update public.casos c
   set operador_nome = b.operador_nome, operador = b.operador
  from public._backup_nome_operador_casos_20260901 b
 where b.id = c.id;

update public.alunos a
   set operador_nome = b.operador_nome,
       responsavel_atual_nome = b.responsavel_atual_nome
  from public._backup_nome_operador_alunos_20260901 b
 where b.id = a.id;

drop function if exists public.nome_do_operador(text);

commit;
