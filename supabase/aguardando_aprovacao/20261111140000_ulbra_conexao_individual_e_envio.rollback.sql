-- ROLLBACK da 20261111140000 — SOMENTE ANTES DE QUALQUER USO.
-- Este arquivo abre a própria transação (begin ... commit): qualquer erro reverte tudo, com ou sem psql -1.
-- Não depende de flag de execução. Rodar só com psql -f <arquivo>.
-- Remove as quatro tabelas criadas por esta migração, e só enquanto elas estiverem VAZIAS.
-- Se houver conexões, prévias ou envios, recusa: após uso real, não se apaga histórico.
-- Reversão com histórico = desativar (ULBRA_ENVIO_REAL e ULBRA_CONTRATO_PREVIA_CONFIRMADO
-- desligados, conexões revogadas pela função), preservando registros e auditoria.
begin;

lock table public.ulbra_envios, public.ulbra_envio_previas, public.ulbra_conexoes_operador, public.ulbra_conexoes_pedidos in access exclusive mode;

-- Sem BYPASSRLS, a RLS sem política esconde as linhas: a checagem de histórico passaria com tabelas cheias.
do $$
begin
  if not coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) then
    raise exception 'ROLLBACK_RECUSADO: papel % sem BYPASSRLS; a RLS esconderia o histórico', current_user;
  end if;
end $$;

do $$
begin
  if exists (select 1 from public.ulbra_envios)
     or exists (select 1 from public.ulbra_envio_previas)
     or exists (select 1 from public.ulbra_conexoes_operador)
     or exists (select 1 from public.ulbra_conexoes_pedidos) then
    raise exception 'ROLLBACK_RECUSADO_HA_HISTORICO: não apagar; desativar em vez de reverter';
  end if;
end $$;

drop function if exists public.ulbra_conferir_envio(text, text, text, text, text, jsonb);

-- A ordem importa: ulbra_envios referencia ulbra_envio_previas.
drop table if exists public.ulbra_envios;
drop table if exists public.ulbra_envio_previas;
drop table if exists public.ulbra_conexoes_operador;
drop table if exists public.ulbra_conexoes_pedidos;

commit;
