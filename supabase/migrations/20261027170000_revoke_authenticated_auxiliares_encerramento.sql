-- =============================================================================
-- RESTRINGE EXECUTE DE `authenticated` NAS QUATRO FUNCOES AUXILIARES
--
-- FECHA O ACESSO DIRETO AS QUATRO AUXILIARES. NAO ELIMINA a consulta de CPF.
--
-- Depois de 20261027160000 ter fechado o acesso ANONIMO, qualquer usuario
-- AUTENTICADO -- inclusive operador sem perfil de gestao -- ainda podia chamar
-- estas quatro com CPF ou uuid arbitrario e descobrir se aquele CPF estava sem
-- divida. Esta migration fecha ESSE caminho.
--
-- O QUE ELA NAO FECHA, e e preciso ler isto antes de concluir que o problema
-- acabou: os DOIS WRAPPERS publicos `caso_encerrado_operacional` -- o de 5 e o
-- de 7 argumentos -- MANTEM EXECUTE para `authenticated`, porque a operacao
-- inteira depende deles (39 funcoes, 1 view, o gatilho de `casos` e duas
-- funcoes de carteira). Eles sao `security definer`, recebem CPF por parametro
-- e NAO tem portao interno. Logo qualquer autenticado SEGUE podendo sondar CPF
-- por eles. Fechar isso e mudanca de CONTRATO, com 39 chamadores a migrar, e
-- esta registrada como pendencia na §3 de
-- docs/P1-PORTAO-INTERNO-ENCERRAMENTO-PROPOSTA.md.
--
-- ORDEM OBRIGATORIA: 20261027160000 PRIMEIRO.
-- `authenticated` alcanca as auxiliares POR PUBLIC, nao por concessao propria.
-- Medido em bancada (teste R4 de supabase/tests/revoke_execute_public_encerramento.test.js):
-- revogar `authenticated` enquanto PUBLIC tiver EXECUTE e INOCUO. Em producao o
-- pre-requisito ja existe, porque PUBLIC foi revogado em 27/10/2026 15:25 UTC;
-- em ambiente novo, NAO existe antes de 20261027160000 rodar.
--
-- CORPO DE FUNCAO: NENHUM e tocado. Zero `create or replace`, zero DML, zero
-- mudanca de privilegio padrao. O predicado de congelamento fica byte-identico,
-- logo nenhum caso congelado e liberado, nenhuma cobranca reabre, e nada de
-- saldo, acordo ou vinculo muda. Nao aciona a §10 da premissa de seguranca.
--
-- O PORTAO INTERNO FOI REPROVADO PELA GESTAO, e com razao: por um tempo esta
-- frente propos por portao de gestao DENTRO de `caso_encerramento_congelado`.
-- Ela e PREDICADO dentro de `casos_elegiveis_liberacao_fidelizacao` e de
-- `casos_reabrir_com_divida`, e `security definer` troca o contexto de
-- PRIVILEGIO, nao o JWT -- entao `usuario_e_gestao()` responderia pelo CHAMADOR.
-- A variante "devolve false" soltaria 8 casos / R$ 7.584,60 da carteira EM
-- SILENCIO; a variante 42501 derrubaria o reabridor. Nada disso esta aqui.
--
-- CENSO DOS CHAMADORES, medido em producao em 27/10/2026 (so leitura):
--   _caso_encerrado_operacional_regra  <- caso_encerrado_operacional (as duas assinaturas)
--   _caso_sem_saldo_conferido          <- _caso_encerrado_operacional_regra
--   _encerramento_congelado            <- _caso_encerrado_operacional_regra
--   caso_encerramento_congelado        <- casos_elegiveis_liberacao_fidelizacao
--                                         casos_reabrir_com_divida
-- TODOS `security definer` com owner `postgres`. ZERO views, ZERO gatilhos,
-- ZERO chamadores com direitos do invocador. No app: ZERO chamadas.
-- Logo nenhum consumidor legitimo depende do grant a `authenticated`.
--
-- O QUE CONTINUA ABERTO, por decisao consciente: as DUAS assinaturas publicas
-- de `caso_encerrado_operacional` mantem `authenticated`, porque a operacao
-- inteira depende delas -- 39 funcoes, 1 view, o gatilho de `casos` e duas
-- funcoes de carteira. Elas recebem CPF por parametro e nao tem portao, entao
-- operador autenticado ainda pode sondar CPF por elas. Fechar isso e mudanca de
-- CONTRATO, com 39 chamadores a migrar, e esta registrada como pendencia na §3
-- de docs/P1-PORTAO-INTERNO-ENCERRAMENTO-PROPOSTA.md.
--
-- ROLLBACK: supabase/rollbacks/20261027170000_revoke_authenticated_auxiliares_encerramento.rollback.sql
--
-- DUAS DEPENDENCIAS DECLARADAS, porque `revoke` NAO e idempotente:
--   1. O papel `authenticated` precisa EXISTIR, senao 42704. Em PGlite ele vem
--      de supabase/tests/fixtures/grupo_a_prod_20260918.sql.
--   2. O executor precisa ser o DONO ou ter grant option. Um `revoke` feito por
--      papel sem direito emite WARNING "no privileges could be revoked" e NAO
--      revoga nada -- falha silenciosa. O bloco de conferencia do fim pega isso.
--
-- ATOMICIDADE: sem `begin`/`commit`, como a maioria do repositorio. A guarda e
-- a conferencia so valem se o caminho de aplicacao envolver o arquivo numa
-- transacao -- `apply_migration` e `db push` o fazem.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- GUARDA: as quatro precisam existir, E PUBLIC precisa JA estar fechado.
--
-- A segunda metade e o que impede esta migration de parecer que fez algo quando
-- nao fez: sem 20261027160000, `authenticated` continua alcancando por PUBLIC.
-- -----------------------------------------------------------------------------

do $guarda$
declare
  v_faltam  text;
  v_publico text;
begin
  select string_agg(a.sig, ', ' order by a.sig) into v_faltam
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where to_regprocedure(a.sig) is null;

  if v_faltam is not null then
    raise exception
      'FUNCOES_AUSENTES: %. Aplique 20261026200000 antes desta migration.',
      v_faltam;
  end if;

  -- Olha as SEIS, e tanto PUBLIC quanto `anon`.
  --
  -- Antes olhava so PUBLIC e so as quatro auxiliares. Isso deixava um caminho
  -- UTIL-POREM-INCOMPLETO: num estado parcialmente aplicado -- possivel na
  -- aplicacao statement a statement, fora de `apply_migration`/`db push` --
  -- esta migration fechava as quatro e terminava VERDE com o caminho anonimo
  -- ainda aberto pelos wrappers `caso_encerrado_operacional`, que sao
  -- `security definer` e alcancam as auxiliares com os direitos do dono.
  -- Tambem nao olhava `anon`: uma concessao DIRETA a `anon` passava verde.
  select string_agg(a.sig, ', ' order by a.sig) into v_publico
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

  if v_publico is not null then
    raise exception
      'CAMINHO_ANONIMO_ABERTO: PUBLIC ou anon ainda executam %. Aplique 20261027160000 PRIMEIRO e confira que ela fechou as SEIS -- revogar `authenticated` enquanto existir caminho anonimo e inocuo, e terminar verde aqui esconderia a exposicao.',
      v_publico;
  end if;
end
$guarda$;

-- -----------------------------------------------------------------------------
-- A RESTRICAO
-- -----------------------------------------------------------------------------

revoke execute on function public._caso_sem_saldo_conferido(uuid, text)                                 from authenticated;
revoke execute on function public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text) from authenticated;
revoke execute on function public._encerramento_congelado(uuid,uuid,text,text,text,text,text)           from authenticated;
revoke execute on function public.caso_encerramento_congelado(uuid)                                     from authenticated;

-- -----------------------------------------------------------------------------
-- CONFERENCIA, NOS DOIS SENTIDOS
--
-- Por PRIVILEGIO EFETIVO (`has_function_privilege`), nunca por `aclexplode`
-- sobre `proacl`: `proacl` NULO e o estado PADRAO, que para funcao INCLUI
-- EXECUTE a PUBLIC, e `aclexplode` de um nulo devolve zero linhas.
-- -----------------------------------------------------------------------------

do $confere$
declare
  v_aberto  text;
  v_quebrou text;
begin
  -- (1) `authenticated` e PUBLIC NAO podem executar as quatro auxiliares
  select string_agg(a.sig, ', ' order by a.sig) into v_aberto
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where has_function_privilege('authenticated', to_regprocedure(a.sig), 'EXECUTE')
      or has_function_privilege('public',        to_regprocedure(a.sig), 'EXECUTE');

  if v_aberto is not null then
    raise exception
      'ACESSO_AINDA_ABERTO: authenticated ou PUBLIC seguem com EXECUTE em %. Verifique se o executor e dono ou tem grant option -- revoke sem direito emite WARNING e nao revoga.',
      v_aberto;
  end if;

  -- (2) `service_role` PRECISA manter, e as DUAS publicas tambem
  select string_agg(a.sig, ', ' order by a.sig) into v_quebrou
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where not has_function_privilege('service_role', to_regprocedure(a.sig), 'EXECUTE');

  if v_quebrou is not null then
    raise exception
      'SERVICE_ROLE_PERDIDO: service_role perdeu EXECUTE em %. A restricao foi alem do escopo.',
      v_quebrou;
  end if;

  if not has_function_privilege('authenticated',
         to_regprocedure('public.caso_encerrado_operacional(text,text,text,text,text)'), 'EXECUTE')
     or not has_function_privilege('authenticated',
         to_regprocedure('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'), 'EXECUTE') then
    raise exception
      'OPERACAO_QUEBRADA: authenticated perdeu EXECUTE numa das assinaturas PUBLICAS de caso_encerrado_operacional. A operacao inteira depende delas -- esta migration nao deveria toca-las.';
  end if;
end
$confere$;
