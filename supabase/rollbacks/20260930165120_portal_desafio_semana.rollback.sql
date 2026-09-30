-- Rollback de 20260930180000_portal_desafio_semana.
--
-- Nao toca elogio, sugestao, playlist nem curtida: a migration so LIA essas
-- tabelas para contar, nunca escreveu nelas.
--
-- APAGA DESAFIO CADASTRADO: drop table leva junto os desafios que a gestao criou.
-- Por isso a checagem vem ANTES de qualquer DROP -- ou roda inteiro, ou nao roda.
--
-- Para desfazer com desafios cadastrados:
--
--   create table public._backup_portal_desafios_20260930 as
--     select * from public.portal_desafios;
--   select set_config('portal.rollback_desafios_confirmado', 'sim', false);
--   \i supabase/rollbacks/20260930180000_portal_desafio_semana.rollback.sql

do $$
declare
  v_n bigint := 0;
  v_ok text := coalesce(current_setting('portal.rollback_desafios_confirmado', true), '');
begin
  if to_regclass('public.portal_desafios') is null then
    raise notice 'portal_desafios nao existe; nada a desfazer.';
    return;
  end if;

  select count(*) into v_n from public.portal_desafios;

  if v_n > 0 and lower(v_ok) <> 'sim' then
    raise exception E'Rollback abortado: existem % desafios cadastrados e o DROP TABLE apagaria todos.\nGuarde um backup e confirme com:\n  select set_config(''portal.rollback_desafios_confirmado'', ''sim'', false);', v_n
      using errcode = 'PL007';
  end if;
end
$$;

drop function if exists public.portal_desafio_vigente();

drop policy if exists portal_desafios_leitura on public.portal_desafios;
drop policy if exists portal_desafios_gestao on public.portal_desafios;
drop index if exists public.portal_desafios_periodo_idx;
drop table if exists public.portal_desafios;
