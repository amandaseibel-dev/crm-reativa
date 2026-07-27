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

rollback;
