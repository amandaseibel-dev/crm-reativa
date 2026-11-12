-- NOTA DE VERSIONAMENTO (12/11/2026): esta migration JÁ ESTÁ APLICADA EM
-- PRODUÇÃO desde 08/10/2026 e é versionada aqui só para o repositório refletir
-- o banco. NÃO REAPLICAR. O ledger de produção a registrou como
-- `20261008172859` (o apply_migration gera a própria versão); o arquivo usa
-- essa versão para casar com o ledger. Corpo idêntico ao vivo, conferido por
-- leitura em 12/11/2026.
--
-- PREVENTIVO: o portao passa a aceitar Angela e Gustavo (diretoria).
--
-- Ate aqui `preventivo_e_gestao()` era um e-mail unico, escrito na mao dentro
-- da funcao. O modulo tem DUAS abas -- Remessas e Resultados -- e as duas
-- precisavam ser liberadas para a diretoria acompanhar o preventivo sem pedir
-- extracao para a gestao. Como a aba e o portao sao a mesma coisa aqui, liberar
-- "as duas abas" E liberar o modulo: nao existe terceira aba a reter.
--
-- AS REGRAS, e por que cada uma:
--
--   ALLOWLIST, NAO PERFIL. O perfil de Angela e Gustavo continua `diretoria`.
--   Trocar para `gerencia` teria dado de brinde fila, base, financeiro
--   operacional, usuarios e configuracoes -- tudo que DIRETORIA_ROTAS existe
--   para NAO dar. O acesso entra por e-mail, aqui e no espelho do frontend
--   (`EMAILS_PREVENTIVO`, em src/App.jsx).
--
--   PORTAO DE MODULO, NAO DE GESTAO. `preventivo_e_gestao()` e usada SOMENTE
--   pelo Preventivo (11 policies das 11 tabelas `prev_` e o corpo de cada RPC
--   do modulo). Nenhuma outra tela a consulta, e `usuario_e_gestao()`,
--   `usuario_e_gestao_fila()` e `calibragem_e_gestao()` NAO sao tocadas. Logo
--   os dois nao se tornam gestao em lugar nenhum.
--
--   ESCRITA INCLUIDA, DE PROPOSITO. O portao e um booleano unico: nao separa
--   leitura de escrita. Entao as acoes das duas abas vem com ele -- criar
--   periodo, previa de lote, confirmar lote, registrar acao externa (Remessas)
--   e definir custo (Resultados). Decisao da Amanda em 08/10/2026, com o
--   alcance declarado. Quem quiser leitura pura depois precisa de um SEGUNDO
--   portao (ex. `preventivo_pode_ler`) e das 11 policies reescritas -- nao
--   cabe nesta funcao.
--
--   O `ativo` CONTINUA VALENDO, para os tres. Sair da empresa (ou ser
--   desativado em `usuarios`) fecha o Preventivo no mesmo instante, sem
--   migration. Por isso o `exists` ficou FORA do `in (...)`, valendo para o
--   e-mail que entrou, qualquer um dos tres.
--
--   SEM `REVOKE` DE `authenticated`. Portao INTERNO por e-mail do JWT, como em
--   `app_pode_borderos_importacoes()` (27/07). Revogar derrubaria a propria
--   tela da gestao -- erro ja cometido em 12/09, ver
--   `restringir-a-gestao-e-portao-interno-nunca-revoke-de-authenticated`.
--
--   NADA DE DADO MUDA. Nenhuma tabela, coluna, policy, RPC ou linha e alterada
--   por esta migration: ela troca o corpo de UMA funcao de autorizacao. O
--   caminho interno (service_role/cron) fica identico.
--
-- Reversao em
-- `supabase/rollbacks/20261008180000_preventivo_portao_angela_e_gustavo.rollback.sql`.
-- =============================================================================

begin;

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
    -- sem usuário final: só chamada interna de sistema (Edge Function com
    -- service_role, cron). Nunca `anon`.
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;
  return em in (
           'amanda.seibel@aelbra.com.br',
           'angela.ferreira@aelbra.com.br', -- Angela (diretoria), 08/10/2026
           'gustavo.ene@aelbra.com.br'      -- Gustavo (diretoria), 08/10/2026
         )
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$$;

comment on function public.preventivo_e_gestao() is
  'Preventivo: verdadeiro para a Amanda da gestão (amanda.seibel@aelbra.com.br) e para a diretoria liberada em 08/10/2026 (angela.ferreira@aelbra.com.br, gustavo.ene@aelbra.com.br), em todos os casos somente se o cadastro estiver ativo em public.usuarios; ou para chamada interna de sistema. Amanda ADM e demais perfis NÃO passam. Portão exclusivo do módulo Preventivo (11 tabelas prev_ + RPCs do módulo): não concede gestão em nenhuma outra tela. Espelho no frontend: EMAILS_PREVENTIVO em src/App.jsx.';

-- §10 do PREMISSA_SEGURANCA: `create or replace` pode restaurar grants padrão.
-- Reconfirmados aqui, iguais aos de 28/09 -- `public` fora, `anon` nunca.
revoke all on function public.preventivo_e_gestao() from public;
grant execute on function public.preventivo_e_gestao() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- TRAVAS: a migration não passa se o portão não ficar exatamente como descrito.
-- -----------------------------------------------------------------------------
do $trava$
declare
  v_em text;
  v_ok boolean;
begin
  -- 1. Os três e-mails ativos passam.
  foreach v_em in array array[
    'amanda.seibel@aelbra.com.br',
    'angela.ferreira@aelbra.com.br',
    'gustavo.ene@aelbra.com.br'
  ] loop
    if not exists (select 1 from public.usuarios u where lower(u.email) = v_em and u.ativo is true) then
      raise exception 'TRAVA: % não está ativo em public.usuarios -- portão não deve citar quem não tem cadastro', v_em;
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','authenticated','email',v_em)::text, true);
    if not public.preventivo_e_gestao() then
      raise exception 'TRAVA: % deveria passar no portão do Preventivo', v_em;
    end if;
  end loop;

  -- 2. Quem não está na lista continua fora -- inclusive Amanda ADM e Fernanda,
  --    que são gestão em outras telas e NÃO podem herdar o Preventivo.
  foreach v_em in array array[
    'cobranca07@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca01@aelbra.com.br'
  ] loop
    perform set_config('request.jwt.claims',
      json_build_object('role','authenticated','email',v_em)::text, true);
    if public.preventivo_e_gestao() then
      raise exception 'TRAVA: % NÃO deveria passar no portão do Preventivo', v_em;
    end if;
  end loop;

  -- 3. JWT sem e-mail e e-mail inexistente não passam pelo caminho de usuário.
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","email":"ninguem@exemplo.com"}', true);
  if public.preventivo_e_gestao() then
    raise exception 'TRAVA: e-mail sem cadastro passou no portão';
  end if;

  perform set_config('request.jwt.claims', '', true);
  select public.preventivo_e_gestao() into v_ok;
  if v_ok is null then
    raise exception 'TRAVA: portão retornou nulo sem JWT';
  end if;

  -- 4. Os grants continuam como o projeto exige.
  if has_function_privilege('anon', 'public.preventivo_e_gestao()', 'execute') then
    raise exception 'TRAVA: anon ficou com execute no portão do Preventivo';
  end if;
  if not has_function_privilege('authenticated', 'public.preventivo_e_gestao()', 'execute') then
    raise exception 'TRAVA: authenticated perdeu execute -- a tela da gestão cairia';
  end if;

  raise notice 'OK: portão do Preventivo com 3 e-mails, grants e exclusões conferidos.';
end;
$trava$;

commit;
