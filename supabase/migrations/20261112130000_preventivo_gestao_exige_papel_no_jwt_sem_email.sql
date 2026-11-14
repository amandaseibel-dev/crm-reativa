-- =============================================================================
-- PREVENTIVO — preventivo_e_gestao() não libera mais JWT de usuário sem e-mail
-- =============================================================================
-- FALHA: a função é SECURITY DEFINER, então `current_user` dentro dela é o DONO
-- (postgres). No ramo "sem e-mail" ela devolvia `current_user in (postgres, ...)`
-- = verdadeiro para QUALQUER chamador sem claim de e-mail, inclusive um
-- `authenticated` anônimo (login anônimo). Esse portão guarda a RLS de toda
-- tabela prev_*, todas as RPCs preventivo_* e a Edge prev-sincronizar (que
-- depois lê a chave da Prime).
--
-- CORREÇÃO MÍNIMA: só o ramo sem e-mail muda. Chamada interna legítima é
-- (a) sem JWT nenhum (cron/postgres) ou (b) JWT com role service_role. Um JWT
-- com role `authenticated` sem e-mail passa a ser barrado. O ramo com e-mail
-- (a gestão, perfil ativo) é idêntico ao anterior.
--
-- ATENÇÃO — DRIFT: o corpo VIVO em produção (lido em 12/11/2026) já inclui
-- Angela e Gustavo (migration 20261008180000, aplicada fora do repositório e
-- ainda não versionada na main). Esta versão PRESERVA os três e-mails; partir
-- do corpo de 28/09 removeria o acesso da diretoria.
--
-- CONSUMIDORES CONFERIDOS (nenhum depende do ramo antigo): policies
-- `prev_*_somente_gestao` e RPCs preventivo_* (chamadas por usuário com
-- e-mail), Edge prev-sincronizar (JWT do usuário), App.jsx (gate de rota).
-- Grants preservados por `create or replace`.
-- Reversão: supabase/rollbacks/20261112130000_preventivo_gestao_exige_papel_no_jwt_sem_email.rollback.sql
-- =============================================================================
create or replace function public.preventivo_e_gestao()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    -- sem e-mail: só chamada interna de sistema. JWT de usuário (role
    -- authenticated) sem e-mail NUNCA passa; anon nem chega aqui (sem EXECUTE).
    -- Duas travas independentes, ambas precisam valer: (1) o claim `role` do
    -- JWT, se houver, é service_role; (2) o PAPEL REAL da sessão (GUC `role`,
    -- que o SECURITY DEFINER não altera) não é authenticated/anon. Assim um
    -- usuário comum é barrado mesmo com JWT ausente, vazio ou sem claim `role`.
    return coalesce(auth.jwt() ->> 'role', '') in ('', 'service_role')
       and coalesce(nullif(current_setting('role', true), ''), 'none')
           not in ('authenticated', 'anon');
  end if;
  return em in (
           'amanda.seibel@aelbra.com.br',
           'angela.ferreira@aelbra.com.br', -- Angela (diretoria), 08/10/2026
           'gustavo.ene@aelbra.com.br'      -- Gustavo (diretoria), 08/10/2026
         )
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$$;
