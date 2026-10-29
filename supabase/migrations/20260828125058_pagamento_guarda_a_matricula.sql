-- A matricula vinha no arquivo e era jogada fora.
--
-- A coluna B do extrato Santander e "2026002333 - Nome do Aluno". O parser
-- cortava no " - " e ficava so com o nome. Resultado medido em 28/08/2026:
-- 3.272 pagamentos do mes SEM cpf, SEM aluno_id, SEM matricula -- nenhum
-- identificador que casasse com a base. O unico casamento possivel era por
-- nome, e a base tem 109 nomes repetidos com CPFs diferentes.
--
-- O numero do titulo nao resolve: testado contra boleto do Prime, documento
-- do titulo no CRM, numero do acordo e matricula do CRM -- zero em todos. E a
-- matricula do borderô (3 a 5 digitos) tambem NAO e a do Prime (9 a 10):
-- 13.739 matriculas do CRM, zero casam com prime_contratos.registration.
--
-- A matricula do arquivo tem o mesmo formato da do Prime (10 digitos), entao
-- e ela que fecha a ponte pagamento -> Prime -> CPF -> aluno.
--
-- O gatilho le de `dados` para funcionar com qualquer uma das versoes da
-- funcao de importacao, sem reescrever nenhuma delas.

alter table public.pagamentos add column if not exists matricula text;

create index if not exists idx_pagamentos_matricula
  on public.pagamentos (matricula) where matricula is not null;

create or replace function public._pagamento_matricula_do_arquivo()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.matricula is null then
    new.matricula := nullif(trim(coalesce(new.dados->>'matricula','')), '');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pagamento_matricula on public.pagamentos;
create trigger trg_pagamento_matricula
before insert or update of dados on public.pagamentos
for each row execute function public._pagamento_matricula_do_arquivo();

comment on column public.pagamentos.matricula is
  'Matricula do aluno como vem na coluna B do extrato ("matricula - nome"). E a ponte para prime_contratos.registration -> cpf -> aluno. Nula nos pagamentos importados antes de 28/08/2026, quando o parser descartava o numero.';
