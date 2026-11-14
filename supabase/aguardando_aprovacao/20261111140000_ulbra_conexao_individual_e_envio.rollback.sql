-- ROLLBACK da 20261111140000 — SOMENTE ANTES DE QUALQUER USO.
-- Remove as quatro tabelas criadas por esta migração, e só enquanto elas estiverem VAZIAS.
-- Se houver conexões, prévias ou envios, recusa: após uso real, não se apaga histórico.
-- Reversão com histórico = desativar (ULBRA_ENVIO_REAL e ULBRA_CONTRATO_PREVIA_CONFIRMADO
-- desligados, conexões revogadas pela função), preservando registros e auditoria.
drop function if exists public.ulbra_conferir_envio(text, text, text, text, text, jsonb);

lock table public.ulbra_envios, public.ulbra_envio_previas, public.ulbra_conexoes_operador, public.ulbra_conexoes_pedidos in access exclusive mode;

do $$
begin
  if exists (select 1 from public.ulbra_envios)
     or exists (select 1 from public.ulbra_envio_previas)
     or exists (select 1 from public.ulbra_conexoes_operador)
     or exists (select 1 from public.ulbra_conexoes_pedidos) then
    raise exception 'ROLLBACK_RECUSADO_HA_HISTORICO: não apagar; desativar em vez de reverter';
  end if;
end $$;

-- A ordem importa: ulbra_envios referencia ulbra_envio_previas.
drop table if exists public.ulbra_envios;
drop table if exists public.ulbra_envio_previas;
drop table if exists public.ulbra_conexoes_operador;
drop table if exists public.ulbra_conexoes_pedidos;
