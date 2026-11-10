-- Stub fiel de ulbra_vinculos (colunas, índice único de cliente ativo e o gatilho
-- que proíbe apagar, mudar aluno e reabrir). Usado só no job de concorrência.
create table public.ulbra_vinculos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid not null references public.alunos(id),
  ulbra_cliente_id text not null,
  telefone_e164 text,
  confianca text not null check (confianca in ('alta_cpf','alta','reconfirmar')),
  origem text not null,
  vinculado_por text,
  vinculado_em timestamptz not null default now(),
  desvinculado_em timestamptz,
  desvinculado_por text
);
create unique index ulbra_vinculos_cliente_ativo_uniq on public.ulbra_vinculos (ulbra_cliente_id) where desvinculado_em is null;
create or replace function public._ulbra_vinculo_protege_historico() returns trigger language plpgsql as $f$
begin
  if tg_op = 'DELETE' then raise exception 'ULBRA_VINCULO_DELETE_PROIBIDO'; end if;
  if new.aluno_id is distinct from old.aluno_id then raise exception 'ULBRA_VINCULO_IMUTAVEL'; end if;
  if new.ulbra_cliente_id is distinct from old.ulbra_cliente_id then raise exception 'ULBRA_VINCULO_IMUTAVEL'; end if;
  if old.desvinculado_em is not null and new.desvinculado_em is null then raise exception 'ULBRA_VINCULO_NAO_REABRE'; end if;
  return new;
end $f$;
create trigger trg_ulbra_vinculo_protege_historico before delete or update on public.ulbra_vinculos
  for each row execute function public._ulbra_vinculo_protege_historico();
insert into public.alunos (id, nome) values ('11111111-1111-1111-1111-111111111111', 'A');
