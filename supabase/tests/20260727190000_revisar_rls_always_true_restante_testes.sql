-- ============================================================================
-- TESTES POR PERFIL (executar em ROLLBACK) — RLS always_true escrita restante
-- Branch: security/revisar-rls-always-true-restante
--
-- Avalia os predicados EXATOS das policies de escrita corrigidas para cada
-- perfil, simulando o e-mail do JWT (request.jwt.claims). NÃO grava dados
-- (somente SELECT dos booleanos) e encerra em ROLLBACK.
--
-- Rodar DEPOIS de aplicar a migration na mesma transação, OU isoladamente
-- (os predicados dependem apenas dos helpers app_usuario_ativo/usuario_e_gestao/
--  app_email/app_pode_borderos_importacoes, já existentes).
--
-- RESULTADO ESPERADO:
--   anon / não-cadastrado / inativo .... TUDO negado (ativo=false)
--   operador dono ...................... escreve o PRÓPRIO registro; nega de 3º;
--                                        nega importações/conferência; log=ok
--   operador terceiro .................. nega registros de outro dono; log=ok
--   gestão / Amanda .................... libera tudo (importações só Amanda)
-- ============================================================================

begin;

create or replace function pg_temp.t(claim text) returns table(
  ativo bool, gestao bool,
  lp_update_owner bool,   -- links_pagamento (row operador=cobranca05)
  lp_update_other bool,   -- links_pagamento (row operador=cobranca99, não dono)
  sf_update_owner bool,   -- solicitacoes_financeiro (row operador=cobranca06)
  importacoes_wr bool,    -- importacoes (Amanda-only)
  conferencia_wr bool,    -- conferencia_pagamentos (gestão)
  floor_log bool          -- histórico (usuário ativo)
) language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when claim is null then '' else json_build_object('email',claim)::text end, true);
  ativo := public.app_usuario_ativo();
  gestao := public.usuario_e_gestao();
  lp_update_owner := ativo and (gestao or lower('cobranca05@aelbra.com.br')=public.app_email());
  lp_update_other := ativo and (gestao or lower('cobranca99@aelbra.com.br')=public.app_email());
  sf_update_owner := ativo and (gestao or lower('cobranca06@aelbra.com.br')=public.app_email());
  importacoes_wr := ativo and public.app_pode_borderos_importacoes();
  conferencia_wr := ativo and gestao;
  floor_log := ativo;
  return next;
end $$;

select p.nome as perfil, x.*
from (values
  (1,'anon (sem jwt)', null),
  (2,'operador dono LP (cobranca05)', 'cobranca05@aelbra.com.br'),
  (3,'operador dono SF (cobranca06)', 'cobranca06@aelbra.com.br'),
  (4,'operador terceiro (cobranca13)', 'cobranca13@aelbra.com.br'),
  (5,'gestao/Amanda', 'amanda.seibel@aelbra.com.br'),
  (6,'email nao-cadastrado', 'ninguem@exemplo.com')
) p(ord,nome,claim), lateral pg_temp.t(p.claim) x
order by p.ord;

-- ---------------------------------------------------------------------------
-- TIER C — titularidade por acordo (app_owns_acordo) e autor do log.
--   Requer a migration aplicada (helpers app_owns_acordo/app_matches_nome).
--   Ajuste os UUIDs (:owned = acordo do operador; :orph = acordo órfão sem
--   responsável) para dados reais antes de rodar.
--   RESULTADO ESPERADO (helper ESTRITO):
--     app_owns_acordo: TRUE só p/ dono; FALSE p/ órfão, inexistente e NULL.
--     dono do acordo ..... parcela/vínculo=OK(owned), NEG(órfão); log próprio=OK,
--                          log vazio/3º=NEG.
--     operador terceiro .. parcela/vínculo=NEG; log vazio/3º=NEG.
--     gestão ............. parcela/vínculo OK inclusive órfão; log qualquer=OK.
--     anon/não-cadastrado. tudo NEG.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.c(claim text, owned uuid, orph uuid) returns table(
  o_ativo bool, owns_owned bool, owns_orphan bool, owns_missing bool, owns_null bool,
  parc_owned bool, parc_orphan bool, log_self bool, log_empty bool, log_other bool
) language plpgsql as $$
declare av bool; g bool;
begin
  perform set_config('request.jwt.claims',
    case when claim is null then '' else json_build_object('email',claim)::text end, true);
  av := public.app_usuario_ativo(); g := public.usuario_e_gestao();
  o_ativo := av;
  owns_owned  := public.app_owns_acordo(owned);
  owns_orphan := public.app_owns_acordo(orph);
  owns_missing:= public.app_owns_acordo('00000000-0000-0000-0000-000000000000');
  owns_null   := public.app_owns_acordo(null);
  parc_owned  := av and (g or public.app_owns_acordo(owned));
  parc_orphan := av and (g or public.app_owns_acordo(orph));         -- órfão: só gestão
  log_self    := av and (g or lower(coalesce(public.app_email(),'')) = public.app_email());
  log_empty   := av and (g or lower(coalesce(''::text,'')) = public.app_email());   -- vazio: NEG
  log_other   := av and (g or lower('terceiro@aelbra.com.br') = public.app_email()); -- 3º: NEG
  return next;
end $$;

-- Troque os UUIDs por dados reais antes de rodar.
select p.nome as perfil, x.*
from (values
  (1,'anon', null),
  (2,'operador dono do acordo', 'cobranca10@aelbra.com.br'),
  (3,'operador terceiro', 'cobranca13@aelbra.com.br'),
  (4,'gestao/Amanda', 'amanda.seibel@aelbra.com.br'),
  (5,'nao-cadastrado', 'ninguem@exemplo.com')
) p(ord,nome,claim),
  lateral pg_temp.c(p.claim,
    '233cdf80-5363-4d6a-b12e-d182cb7860e4'::uuid,
    'd353a79e-04d5-47ef-8c52-b60ab59281e8'::uuid) x
order by p.ord;

-- Invariantes (devem retornar 0 / lista vazia):
select
  (select count(*) from pg_policies where schemaname='public'
     and ((qual='true') or (with_check='true')) and roles::text like '%authenticated%' and cmd<>'SELECT') as writes_always_true,
  (select coalesce(json_agg(tablename||'.'||policyname),'[]') from pg_policies
     where schemaname='public' and cmd<>'SELECT' and roles::text like '%authenticated%'
     and (coalesce(qual,'')||' '||coalesce(with_check,'')) like '%app_usuario_ativo%'
     and (coalesce(qual,'')||' '||coalesce(with_check,'')) not like '%usuario_e_gestao%'
     and (coalesce(qual,'')||' '||coalesce(with_check,'')) not like '%app_owns_acordo%'
     and (coalesce(qual,'')||' '||coalesce(with_check,'')) not like '%app_matches_nome%'
     and (coalesce(qual,'')||' '||coalesce(with_check,'')) not like '%app_email%'
     and (coalesce(qual,'')||' '||coalesce(with_check,'')) not like '%app_pode_borderos%') as writes_somente_ativo;

rollback;
