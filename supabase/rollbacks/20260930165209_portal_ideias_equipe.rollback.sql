-- Rollback de 20260930190000_portal_ideias_equipe.
--
-- Nao toca sugestoes: a migration so LEU a tabela, nunca escreveu nela. Nenhuma
-- sugestao e apagada, nenhum status e alterado, nenhum visivel_equipe e mexido.
--
-- APAGA CURTIDA DE IDEIA: voltar o CHECK de alvo_tipo e impossivel com curtidas
-- de ideia gravadas. A checagem vem ANTES de qualquer alteracao.
--
-- Para desfazer com curtidas de ideia:
--
--   create table public._backup_portal_curtidas_ideia_20260930 as
--     select * from public.portal_curtidas where alvo_tipo = 'ideia';
--   select set_config('portal.rollback_curtidas_ideia_confirmado', 'sim', false);
--   \i supabase/rollbacks/20260930190000_portal_ideias_equipe.rollback.sql

do $$
declare
  v_n bigint := 0;
  v_ok text := coalesce(current_setting('portal.rollback_curtidas_ideia_confirmado', true), '');
begin
  if to_regclass('public.portal_curtidas') is null then
    raise notice 'portal_curtidas nao existe; nada a reverter no CHECK.';
    return;
  end if;

  select count(*) into v_n from public.portal_curtidas where alvo_tipo = 'ideia';

  if v_n > 0 and lower(v_ok) <> 'sim' then
    raise exception E'Rollback abortado: existem % curtidas de ideia e voltar o CHECK as apagaria.\nGuarde um backup e confirme com:\n  select set_config(''portal.rollback_curtidas_ideia_confirmado'', ''sim'', false);', v_n
      using errcode = 'PL008';
  end if;
end
$$;

drop function if exists public.portal_ideias_equipe(text, integer);

delete from public.portal_curtidas where alvo_tipo = 'ideia';

-- Volta ao dominio do B (playlist + elogio). Se o B tambem for revertido, o
-- rollback dele estreita para playlist.
alter table public.portal_curtidas
  drop constraint if exists portal_curtidas_alvo_tipo_check;
alter table public.portal_curtidas
  add constraint portal_curtidas_alvo_tipo_check
  check (alvo_tipo in ('playlist', 'elogio'));
