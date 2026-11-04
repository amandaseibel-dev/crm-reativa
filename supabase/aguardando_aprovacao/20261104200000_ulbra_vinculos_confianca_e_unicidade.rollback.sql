-- ============================================================================
-- ROLLBACK de 20261104200000_ulbra_vinculos_confianca_e_unicidade
-- Artefato de 04/11/2026. NAO FOI EXECUTADO EM NENHUM AMBIENTE.
--
-- PITR NAO esta habilitado neste projeto (memoria
-- `pitr-nao-habilitado-rollback-nao-e-restore`), por isso a reversa e por
-- objeto nomeado, nunca por restore.
--
-- ----------------------------------------------------------------------------
-- O QUE ESTA REVERSA DEVOLVE, OBJETO POR OBJETO
--
-- Os SEIS pontos alterados pela migration sao todos NOVOS ou restauraveis --
-- nenhum `create or replace` sobre funcao preexistente, nenhuma policy
-- alterada --, entao revertê-los devolve o banco ao estado medido em
-- 04/11/2026:
--
--   1. ulbra_vinculos_confianca_check              volta a CHECK (IN ('alta','ambigua'))
--   2. ulbra_vinculos_alta_cpf_exige_origem_forte  removido (nao existia)
--   3. ulbra_vinculos_cliente_ativo_uniq           removido (nao existia)
--   4. trg_ulbra_vinculo_protege_historico         removido (nao existia)
--   5. _ulbra_vinculo_protege_historico()          removido (nao existia; o
--                                                  REVOKE de EXECUTE sai com
--                                                  ela, nao e item separado)
--   6. grants DELETE/TRUNCATE de authenticated     DEVOLVIDOS (ver abaixo)
--
-- NENHUMA linha de `ulbra_vinculos`, `alunos` ou `auditoria` e lida, escrita
-- ou apagada aqui.
--
-- AS DUAS TABELAS DE BACKUP **FICAM**, de proposito:
--   public.ulbra_vinculos_backup_20261104
--   public.ulbra_vinculos_estrutura_backup_20261104
-- Backup que a reversa destroi nao e backup -- e com o snapshot de estrutura
-- que se CONFERE, depois de rodar este arquivo, se o banco voltou ao estado
-- certo. Descarte e decisao da gestao, depois de a correcao estar estavel.
--
-- ----------------------------------------------------------------------------
-- CONSEQUENCIA DE EXECUTAR -- LEIA ANTES
--
-- 1. A tabela volta a aceitar N alunos ativos no MESMO cliente da Mensageria.
-- 2. `authenticated` volta a poder DELETE e TRUNCATE da tabela de vinculos.
-- 3. UPDATE volta a poder trocar `aluno_id`/`ulbra_cliente_id` de linha
--    existente e reabrir vinculo desvinculado, sem rastro.
-- 4. A `ulbra-consultar` corrigida PARA DE FUNCIONAR para vinculo novo: ela
--    grava `confianca = 'alta_cpf'`, que o CHECK antigo rejeita. Toda tentativa
--    responde VINCULO_NAO_GRAVADO (500). Falha FECHADO -- nenhum vinculo errado
--    e gravado --, mas a ficha para de vincular.
--
--    => Se a `ulbra-consultar` corrigida ja estiver em producao, reverter esta
--       migration exige reverter o deploy da funcao TAMBEM, e nessa ordem:
--       1) voltar a funcao   2) rodar este rollback.
--
-- ----------------------------------------------------------------------------
-- PRECISA DECISAO DA GESTAO ANTES DE RODAR: LINHAS 'alta_cpf' E 'reconfirmar'
--
-- Se a migration ficou em producao tempo suficiente para a `ulbra-consultar`
-- gravar vinculos com `confianca = 'alta_cpf'` -- ou para a gestao marcar
-- alguma linha como 'reconfirmar' --, o CHECK antigo (IN ('alta','ambigua'))
-- NAO ACEITA esses valores, e o ALTER TABLE da secao 3 FALHA -- por desenho.
--
-- Esta reversa NAO reclassifica essas linhas sozinha. Rebaixar 'alta_cpf' para
-- 'alta' apagaria a unica informacao que distingue um vinculo provado por CPF
-- de um palpite por telefone, e seria uma perda silenciosa de evidencia.
-- A secao 0 conta as linhas e PARA, dizendo quantas sao e o que decidir.
-- ============================================================================

begin;

set local lock_timeout = '3s';

-- ----------------------------------------------------------------------------
-- SECAO 0. GUARDA: a reversa nao destroi evidencia por conta propria
-- ----------------------------------------------------------------------------
do $guarda$
declare
  v_alta_cpf    integer;
  v_reconfirmar integer;
begin
  if to_regclass('public.ulbra_vinculos') is null then
    raise exception 'PRE-CONDICAO: public.ulbra_vinculos nao existe neste ambiente';
  end if;

  -- Os DOIS valores que a migration acrescentou ao CHECK, nao so um: linha
  -- 'reconfirmar' derruba o ADD CONSTRAINT da secao 3 exatamente como
  -- 'alta_cpf', e uma mensagem que so fala de 'alta_cpf' manda procurar o
  -- problema no lugar errado.
  select count(*) into v_alta_cpf
    from public.ulbra_vinculos where confianca = 'alta_cpf';
  select count(*) into v_reconfirmar
    from public.ulbra_vinculos where confianca = 'reconfirmar';

  if v_alta_cpf + v_reconfirmar > 0 then
    raise exception
      'ROLLBACK PARADO: % vinculo(s) ''alta_cpf'' e % ''reconfirmar''. O CHECK '
      'antigo (IN (''alta'',''ambigua'')) nao aceita esses valores, e esta '
      'reversa NAO rebaixa selo por conta propria -- rebaixar apagaria a prova '
      'de que o CPF confirmou, e e perda silenciosa de evidencia. '
      'DECISAO DA GESTAO, caso a caso: (a) manter a migration e nao reverter, '
      '(b) desvincular essas linhas (desvinculado_em/desvinculado_por) e '
      'reverter depois, ou (c) autorizar explicitamente o UPDATE para ''alta'' '
      'em migration propria, com auditoria. O retrato de antes esta em '
      'public.ulbra_vinculos_estrutura_backup_20261104.',
      v_alta_cpf, v_reconfirmar;
  end if;
end $guarda$;

-- ----------------------------------------------------------------------------
-- SECAO 1. PROTECAO DOS VINCULOS ANTIGOS -- sai primeiro
-- O trigger tem de cair antes dos grants voltarem: enquanto ele existe, DELETE
-- e proibido mesmo com grant, e a reversa ficaria pela metade sem avisar.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_ulbra_vinculo_protege_historico on public.ulbra_vinculos;
drop function if exists public._ulbra_vinculo_protege_historico();

grant delete, truncate on public.ulbra_vinculos to authenticated;
grant truncate on public.ulbra_vinculos to service_role;

-- ----------------------------------------------------------------------------
-- SECAO 2. UNICIDADE POR CLIENTE ATIVO
-- ----------------------------------------------------------------------------
drop index if exists public.ulbra_vinculos_cliente_ativo_uniq;

-- ----------------------------------------------------------------------------
-- SECAO 3. RESTRICAO DE CONFIANCA -- volta ao CHECK exato de 04/11/2026
-- ----------------------------------------------------------------------------
alter table public.ulbra_vinculos
  drop constraint if exists ulbra_vinculos_alta_cpf_exige_origem_forte;

alter table public.ulbra_vinculos
  drop constraint if exists ulbra_vinculos_confianca_check;

alter table public.ulbra_vinculos
  add constraint ulbra_vinculos_confianca_check
  check (confianca = any (array['alta'::text, 'ambigua'::text]));

-- ----------------------------------------------------------------------------
-- SECAO 4. PROVA DA REVERSA
-- Cada objeto removido tem assercao propria: o padrao e "sem a assercao
-- ninguem provava que saiu", e vale para os cinco, nao para alguns.
-- ----------------------------------------------------------------------------
do $prova$
begin
  if exists (
    select 1 from pg_trigger
     where tgname = 'trg_ulbra_vinculo_protege_historico' and not tgisinternal
  ) then
    raise exception 'PROVA DA REVERSA: sobrou o trigger trg_ulbra_vinculo_protege_historico';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = '_ulbra_vinculo_protege_historico'
  ) then
    raise exception 'PROVA DA REVERSA: sobrou a funcao _ulbra_vinculo_protege_historico';
  end if;

  if exists (select 1 from pg_class where relname = 'ulbra_vinculos_cliente_ativo_uniq') then
    raise exception 'PROVA DA REVERSA: sobrou o indice ulbra_vinculos_cliente_ativo_uniq';
  end if;

  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.ulbra_vinculos'::regclass
       and conname = 'ulbra_vinculos_alta_cpf_exige_origem_forte'
  ) then
    raise exception 'PROVA DA REVERSA: sobrou o CHECK de origem forte';
  end if;

  -- O CHECK de confianca tem de estar de volta na forma ANTIGA: aceitar
  -- 'alta' e recusar 'alta_cpf'.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ulbra_vinculos'::regclass
       and conname = 'ulbra_vinculos_confianca_check'
       and pg_get_constraintdef(oid) like '%alta%'
       and pg_get_constraintdef(oid) not like '%alta_cpf%'
  ) then
    raise exception 'PROVA DA REVERSA: o CHECK de confianca nao voltou a forma antiga';
  end if;

  -- Os grants voltaram
  if not has_table_privilege('authenticated','public.ulbra_vinculos','DELETE')
     or not has_table_privilege('authenticated','public.ulbra_vinculos','TRUNCATE') then
    raise exception 'PROVA DA REVERSA: os grants DELETE/TRUNCATE nao voltaram';
  end if;

  -- O que NAO era desta migration nao pode ter sido levado junto
  if not exists (select 1 from pg_class where relname = 'ulbra_vinculos_aluno_ativo_uniq') then
    raise exception 'ROLLBACK ERRADO: levou o indice preexistente ulbra_vinculos_aluno_ativo_uniq';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ulbra_vinculos'::regclass
       and conname = 'ulbra_vinculos_origem_check'
  ) then
    raise exception 'ROLLBACK ERRADO: levou o CHECK preexistente de origem';
  end if;
  if (select count(*) from pg_policies
       where schemaname='public' and tablename='ulbra_vinculos') <> 3 then
    raise exception 'ROLLBACK ERRADO: o numero de policies mudou (eram 3)';
  end if;

  -- O backup NAO pode ter sido levado: e o retrato contra o qual se confere
  -- se esta reversa devolveu o banco ao estado de 04/11/2026.
  if to_regclass('public.ulbra_vinculos_backup_20261104') is null
     or to_regclass('public.ulbra_vinculos_estrutura_backup_20261104') is null then
    raise exception
      'ROLLBACK ERRADO: a reversa levou uma tabela de backup. Backup que a '
      'reversa destroi nao e backup.';
  end if;
end $prova$;

commit;
