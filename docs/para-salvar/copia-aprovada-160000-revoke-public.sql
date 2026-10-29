-- =============================================================================
-- REVOGA EXECUTE DE PUBLIC EM SEIS FUNCOES DO ENCERRAMENTO
--
-- CONTENCAO EMERGENCIAL JA APLICADA EM PRODUCAO EM 27/10/2026, 15:25 UTC
-- (12:25 America/Sao_Paulo), por `execute_sql`, FORA DE MIGRATION, com
-- autorizacao expressa da gestao e executora unica -- para CINCO das seis.
--
-- A SEXTA, caso_encerrado_operacional(text,text,text,text,text), JA ESTAVA sem
-- PUBLIC em producao antes de tudo (medido). Ela entra aqui porque e CAMINHO
-- EQUIVALENTE: `security definer`, sem portao interno, recebe CPF por parametro
-- e delega para _caso_encerrado_operacional_regra. Em producao o statement dela
-- e no-op; em ambiente novo, e o que impede o oraculo de reabrir por ela.
--
-- Em producao esta migration e NO-OP INTEIRA. Ela existe para que a propriedade
-- sobreviva em ambiente novo e na futura baseline.
--
-- NAO reaplicar em producao esperando efeito. Se um dia for aplicada la, a
-- versao que o historico gravar tera a data da aplicacao, e NAO a data em que o
-- acesso foi fechado. A data real da contencao e a de cima.
--
-- Evidencia: docs/seguranca/RELATORIO-P0-REVOKE-ENCERRAMENTO-2026-10-27.md
-- Rascunhos recusados pelo ledger: docs/rascunhos-nao-incorporados/LEIA-ME-RASCUNHOS.md
--
-- ESCOPO: so privilegio. Zero DML, zero `create or replace`, zero mudanca de
-- privilegio padrao, nenhuma outra funcao tocada. Nao aciona a §10 da premissa
-- de seguranca, que trata de `create or replace` restaurando grants.
--
-- DUAS DEPENDENCIAS DECLARADAS, porque `revoke` NAO e idempotente:
--   1. Os papeis `anon`, `authenticated` e `service_role` precisam EXISTIR.
--      `revoke ... from anon` num banco sem esse papel aborta com 42704. Em
--      PGlite eles vem de supabase/tests/fixtures/grupo_a_prod_20260918.sql.
--   2. O executor precisa ser o DONO ou ter grant option. Um `revoke` feito por
--      papel sem direito emite WARNING "no privileges could be revoked" e NAO
--      revoga nada -- falha silenciosa. O bloco de conferencia do fim e o que
--      pega isso.
--
-- ATOMICIDADE: este arquivo NAO traz `begin`/`commit`, seguindo a maioria do
-- repositorio (578 de 676 migrations). A guarda e a conferencia so valem se o
-- caminho de aplicacao envolver o arquivo numa transacao -- `apply_migration` e
-- `db push` o fazem. Aplicado statement a statement, a conferencia pode
-- reprovar DEPOIS de revogacoes parciais ja efetivadas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- GUARDA: falha fechado se alguma das seis nao existir.
-- -----------------------------------------------------------------------------

do $guarda$
declare
  v_faltam text;
begin
  select string_agg(a.sig, ', ' order by a.sig) into v_faltam
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where to_regprocedure(a.sig) is null;

  if v_faltam is not null then
    raise exception
      'FUNCOES_AUSENTES: %. Aplique 20261026200000 antes desta migration.',
      v_faltam;
  end if;
end
$guarda$;

-- -----------------------------------------------------------------------------
-- A REVOGACAO
-- -----------------------------------------------------------------------------

revoke execute on function public._caso_sem_saldo_conferido(uuid, text)
  from public, anon;
revoke execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerrado_operacional(text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerramento_congelado(uuid)
  from public, anon;

-- -----------------------------------------------------------------------------
-- CONFERENCIA, NOS DOIS SENTIDOS
--
-- Por PRIVILEGIO EFETIVO (`has_function_privilege`), nunca por `aclexplode`
-- sobre `proacl`: `proacl` NULO e o estado PADRAO, que para funcao INCLUI
-- EXECUTE a PUBLIC, e `aclexplode` de um nulo devolve zero linhas -- diria
-- "sem PUBLIC" num caso em que PUBLIC executa.
-- -----------------------------------------------------------------------------

do $confere$
declare
  v_aberto text;
  v_quebrou text;
begin
  -- (1) PUBLIC e anon NAO podem executar nenhuma das seis
  select string_agg(a.sig, ', ' order by a.sig) into v_aberto
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where has_function_privilege('public', to_regprocedure(a.sig), 'EXECUTE')
      or has_function_privilege('anon',   to_regprocedure(a.sig), 'EXECUTE');

  if v_aberto is not null then
    raise exception
      'ACESSO_AINDA_ABERTO: PUBLIC ou anon seguem com EXECUTE em %. Se nenhum erro apareceu antes, verifique se o executor e dono ou tem grant option -- revoke sem direito emite WARNING e nao revoga.',
      v_aberto;
  end if;

  -- (2) `service_role` PRECISA manter EXECUTE nas seis
  select string_agg(a.sig, ', ' order by a.sig) into v_quebrou
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where not has_function_privilege('service_role', to_regprocedure(a.sig), 'EXECUTE');

  if v_quebrou is not null then
    raise exception
      'SERVICE_ROLE_PERDIDO: service_role perdeu EXECUTE em %. A revogacao foi alem do escopo.',
      v_quebrou;
  end if;

  -- (3) `authenticated` PRECISA manter EXECUTE nas DUAS PUBLICAS, e so nelas.
  --
  -- NAO se exige `authenticated` nas quatro auxiliares: a migration seguinte,
  -- 20261027170000, as revoga DE PROPOSITO. Exigir aqui faria esta migration
  -- abortar com mensagem enganosa se fosse reaplicada depois daquela -- medido
  -- em bancada em 27/10/2026, antes de publicar.
  if not has_function_privilege('authenticated',
         to_regprocedure('public.caso_encerrado_operacional(text,text,text,text,text)'), 'EXECUTE')
     or not has_function_privilege('authenticated',
         to_regprocedure('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'), 'EXECUTE') then
    raise exception
      'OPERACAO_QUEBRADA: authenticated perdeu EXECUTE numa das assinaturas PUBLICAS de caso_encerrado_operacional. A operacao inteira depende delas.';
  end if;
end
$confere$;
