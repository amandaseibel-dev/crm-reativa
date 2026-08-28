update public.alunos al set unidade = b.unidade_antes
  from public._backup_unidade_aluno_20260828 b where al.id = b.id;
drop function if exists public.unidade_curta_do_prime(text);
