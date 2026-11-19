-- PREPARAÇÃO (postgres, SOMENTE banco descartável de CI).
-- Desenho de RLS e grants como medido em produção (15/11): INSERT por operador ativo para linha própria
-- ou gestão; SELECT autenticado; SEM policy de UPDATE nem de DELETE.
\set ON_ERROR_STOP on
alter table aluno_movimentacoes enable row level security;
create policy aluno_movimentacoes_insert on aluno_movimentacoes for insert to authenticated
  with check (app_usuario_ativo() and (usuario_e_gestao() or lower(coalesce(registrado_por_email,'')) = app_email()));
create policy aluno_movimentacoes_select on aluno_movimentacoes for select to authenticated using (true);
grant usage on schema public to authenticated;
grant select, insert, update, delete on aluno_movimentacoes to authenticated;
grant usage, select on sequence aluno_movimentacoes_id_seq to authenticated;
grant select, update on alunos to authenticated;
grant select on casos to authenticated;
grant execute on function app_email(), app_usuario_ativo(), usuario_e_gestao() to authenticated;

-- Helper de asserção: executa SQL e devolve o SQLSTATE esperado, ou aponta erro inesperado.
create or replace function esperar_erro(p_sql text, p_estado text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'SEM_ERRO';
exception when others then
  if sqlstate = p_estado then return 'OK:' || sqlstate; end if;
  return 'ERRO_INESPERADO:' || sqlstate || ':' || sqlerrm;
end $$;
grant execute on function esperar_erro(text, text) to authenticated;

-- Seed: aluno fictício com estado conhecido, caso e uma movimentação de operador (não-termo).
insert into alunos (id, status_jornada, status_atual, status_acionamento, data_ultimo_acionamento, data_retorno, proxima_acao)
  values ('a0000000-0000-0000-0000-000000000042','CONTATAR','CONTATAR','CONTATAR','2026-11-01T10:00:00Z','2026-11-20','RETORNAR');
insert into casos (aluno_id, data_ultimo_acionamento) values ('a0000000-0000-0000-0000-000000000042','2026-11-01');
insert into aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_em)
  values ('a0000000-0000-0000-0000-000000000042','OBSERVACAO_TESTE','observação prévia do operador','operador.teste@exemplo.local','2026-11-02T09:00:00Z');
