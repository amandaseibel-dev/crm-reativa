-- Montagem: tabela de vinculos (stub do que existe em producao) e 3 alunos.
\set ON_ERROR_STOP on
create table public.ulbra_vinculos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid references public.alunos (id),
  ulbra_cliente_id text not null,
  confianca text not null,
  desvinculado_em timestamptz
);
insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca) values
  ('00000000-0000-0000-0000-00000000000a', '777', 'alta_cpf'),
  ('00000000-0000-0000-0000-00000000000b', '888', 'alta');
