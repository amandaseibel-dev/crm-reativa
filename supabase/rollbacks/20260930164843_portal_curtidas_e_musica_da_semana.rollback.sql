-- Rollback de 20260930160000_portal_curtidas_e_musica_da_semana.
--
-- APAGA DADO: `drop table public.portal_curtidas` leva junto todas as curtidas
-- registradas. Nao ha como preservar historico e ao mesmo tempo desfazer a
-- tabela que o guarda.
--
-- Por isso este rollback se recusa a rodar as cegas quando existem curtidas.
-- Para desfazer mesmo assim, a gestao decide explicitamente:
--
--   select set_config('portal.rollback_curtidas_confirmado', 'sim', false);
--   \i supabase/rollbacks/20260930160000_portal_curtidas_e_musica_da_semana.rollback.sql
--
-- Antes disso vale guardar o que existe:
--
--   create table public._backup_portal_curtidas_20260930 as
--     select * from public.portal_curtidas;
--
-- A checagem vem ANTES de qualquer DROP: ou o rollback roda inteiro, ou nao roda
-- nada e a base fica como estava.

do $$
declare
  v_curtidas bigint := 0;
  v_confirmado text := coalesce(current_setting('portal.rollback_curtidas_confirmado', true), '');
begin
  if to_regclass('public.portal_curtidas') is null then
    raise notice 'portal_curtidas nao existe; nada a desfazer na tabela.';
    return;
  end if;

  select count(*) into v_curtidas from public.portal_curtidas;

  if v_curtidas > 0 and lower(v_confirmado) <> 'sim' then
    raise exception E'Rollback abortado: existem % curtidas registradas e o DROP TABLE apagaria todas.\nGuarde um backup e confirme com:\n  select set_config(''portal.rollback_curtidas_confirmado'', ''sim'', false);', v_curtidas
      using errcode = 'PL005';
  end if;
end
$$;

drop function if exists public.portal_musica_da_semana(date);
drop function if exists public.portal_curtidas_da_semana(text, date);
drop function if exists public.portal_semana_sp(timestamptz);

-- As policies e os indices caem junto com a tabela; os DROPs explicitos existem
-- para o caso de a tabela ja ter sido removida a mao.
drop policy if exists portal_curtidas_leitura on public.portal_curtidas;
drop policy if exists portal_curtidas_inserir_propria on public.portal_curtidas;
drop policy if exists portal_curtidas_remover_propria on public.portal_curtidas;
drop index if exists public.portal_curtidas_uma_por_pessoa_idx;
drop index if exists public.portal_curtidas_tipo_data_idx;
drop table if exists public.portal_curtidas;
