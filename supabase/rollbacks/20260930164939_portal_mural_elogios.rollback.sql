-- Rollback de 20260930170000_portal_mural_elogios.
--
-- Nao apaga elogio nenhum: a migration so LIA elogios_atendimento, nunca escreveu.
--
-- APAGA CURTIDA DE ELOGIO: voltar o CHECK de alvo_tipo para aceitar so 'playlist'
-- e impossivel com curtidas de elogio gravadas. Entao a checagem vem ANTES de
-- qualquer alteracao: ou o rollback roda inteiro, ou nao roda nada.
--
-- Para desfazer mesmo assim, a gestao decide explicitamente:
--
--   create table public._backup_portal_curtidas_elogio_20260930 as
--     select * from public.portal_curtidas where alvo_tipo = 'elogio';
--   select set_config('portal.rollback_curtidas_elogio_confirmado', 'sim', false);
--   \i supabase/rollbacks/20260930170000_portal_mural_elogios.rollback.sql

do $$
declare
  v_n bigint := 0;
  v_ok text := coalesce(current_setting('portal.rollback_curtidas_elogio_confirmado', true), '');
begin
  if to_regclass('public.portal_curtidas') is null then
    raise notice 'portal_curtidas nao existe; nada a reverter no CHECK.';
    return;
  end if;

  select count(*) into v_n from public.portal_curtidas where alvo_tipo = 'elogio';

  if v_n > 0 and lower(v_ok) <> 'sim' then
    raise exception E'Rollback abortado: existem % curtidas de elogio e voltar o CHECK as apagaria.\nGuarde um backup e confirme com:\n  select set_config(''portal.rollback_curtidas_elogio_confirmado'', ''sim'', false);', v_n
      using errcode = 'PL006';
  end if;
end
$$;

drop function if exists public.portal_mural_elogios(integer);
drop function if exists public.portal_curtidas_totais(text);

delete from public.portal_curtidas where alvo_tipo = 'elogio';

alter table public.portal_curtidas
  drop constraint if exists portal_curtidas_alvo_tipo_check;
alter table public.portal_curtidas
  add constraint portal_curtidas_alvo_tipo_check
  check (alvo_tipo in ('playlist'));
