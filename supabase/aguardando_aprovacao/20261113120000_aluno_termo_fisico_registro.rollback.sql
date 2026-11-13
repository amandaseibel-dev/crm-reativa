-- Rollback de 20261113120000_aluno_termo_fisico_registro.sql.
--
-- O QUE FAZ: remove as RPCs e renomeia a tabela para preservar o histórico.
-- As triggers de UPDATE/DELETE/TRUNCATE continuam na tabela renomeada, e o
-- acesso dos papéis da aplicação é retirado. Ninguém lê nem grava por aqui.
--
-- O QUE NÃO FAZ: não apaga dados. Apagar a tabela renomeada é um passo
-- separado, só depois de backup conferido pela gestão.
--
-- REINSTALAR (sem perder nem misturar registros):
--   1. confirmar que public.aluno_termo_fisico_eventos NÃO existe, ou está
--      vazia (select count(*) = 0);
--   2. reaplicar 20261113120000_aluno_termo_fisico_registro.sql (cria a
--      tabela nova vazia, com RLS, triggers e grants);
--   3. copiar o histórico, sem duplicar (id é uuid, chave primária):
--        insert into public.aluno_termo_fisico_eventos
--        select * from public.aluno_termo_fisico_eventos_descartada_20261113
--        on conflict (id) do nothing;
--   4. conferir: count(*) das duas tabelas iguais em todas as linhas;
--   5. manter a tabela descartada até a gestão decidir o descarte.
--   NUNCA renomear a descartada de volta com a tabela nova já populada.

drop function if exists public.termo_fisico_registrar(text, text, boolean);
drop function if exists public.termo_fisico_ler(text);

alter table if exists public.aluno_termo_fisico_eventos
  rename to aluno_termo_fisico_eventos_descartada_20261113;

-- Acesso zero para qualquer papel da aplicação na tabela renomeada.
revoke all on public.aluno_termo_fisico_eventos_descartada_20261113
  from public, anon, authenticated, service_role;

comment on table public.aluno_termo_fisico_eventos_descartada_20261113 is
  'Histórico do registro de termo físico, descartado por rollback de 20261113120000. Preservado para auditoria; sem acesso da aplicação.';

-- As notificações já enviadas (tipo TERMO_FISICO) não são removidas aqui.
