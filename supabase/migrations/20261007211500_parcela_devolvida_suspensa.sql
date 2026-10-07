-- PARCELA DEVOLVIDA E SUSPENSA -- regra financeira aprovada pela gestao em
-- 07/10/2026.
--
--   1. `PAGO` so pode ser usado quando houve pagamento real.
--   2. Saldo que sai DEFINITIVAMENTE da responsabilidade da ReATIVA sem
--      pagamento -> parcela `DEVOLVIDA`.
--   3. Cobranca apenas SUSPENSA temporariamente -> parcela `SUSPENSA`.
--   4. Nenhum caso sem pagamento gera pagamento, baixa, honorario ou
--      recuperacao.
--
-- DEPENDE de 20261007210000_parcela_viva_fonte_unica.sql. Aplicar depois dela,
-- nunca antes: 46 dos 57 pontos que decidem "parcela cobravel" ja passaram a
-- chamar `parcela_viva()`, e esta migration muda a regra em UM lugar em vez de
-- 46. Os 6 pontos que divergem por `RENEGOCIADA` sao estendidos no lugar aqui.
--
-- A TABULACAO REGISTRA O MOTIVO; O STATUS DA PARCELA REGISTRA O EFEITO. Sao
-- dois eixos e esta migration mantem os dois separados:
--
--   tabulacao (por que)            -> status da parcela (efeito financeiro)
--   -----------------------------------------------------------------------
--   CANCELAMENTO_COBRANCA          -> DEVOLVIDA   (definitivo)
--   ANTECIPACAO_SEMESTRE           -> DEVOLVIDA   (definitivo)
--   ALEGA_FIES_CONFIRMADO          -> DEVOLVIDA   (definitivo)
--   ALEGA_CREDIES_CONFIRMADO       -> DEVOLVIDA   (definitivo)
--   ALEGA_FINANCIAMENTO_CONFIRMADO -> DEVOLVIDA   (definitivo)
--   SUSPENSAO_COBRANCA             -> SUSPENSA    (temporario, tem volta)
--
-- CORRIGE A ANTECIPACAO JA APLICADA. A migration 20261007193034 pos a parcela
-- como `PAGO`, o que viola a regra 1. Passa para `DEVOLVIDA`. NAO precisa de
-- backfill: medido em 07/10/2026, 0 alunos foram tabulados com
-- ANTECIPACAO_SEMESTRE e 0 parcelas tem `origem_baixa = 'ANTECIPACAO_SEMESTRE'`.
--
-- SEM BACKFILL, POR DETERMINACAO DA GESTAO. A regra vale para casos NOVOS. Os
-- 135 alunos que ja estao hoje em SUSPENSAO_COBRANCA (114) ou
-- CANCELAMENTO_COBRANCA (21) nao sao tocados -- e entre eles ha 10 parcelas
-- vivas, R$ 245.587,32, que seguem no saldo. Isso e uma DIVERGENCIA CONHECIDA
-- entre a regra e a base, nao um descuido: aplicar a regra ao historico exige
-- autorizacao separada.
--
-- ROLLBACK: supabase/rollbacks/20261007211500_parcela_devolvida_suspensa.rollback.sql

-- ---------------------------------------------------------------------------
-- 1. A REGRA, EM UM LUGAR
-- ---------------------------------------------------------------------------
-- DEVOLVIDA e SUSPENSA saem do cobravel. Os 46 pontos migrados na fundacao
-- recebem isto de graca. Continua faltando RENEGOCIADA de proposito -- ver
-- bloco 2.
create or replace function public.parcela_viva(p_status text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select upper(coalesce(p_status, '')) not in (
    -- pagamento real (regra 1: so aqui entra dinheiro)
    'PAGO', 'PAGA',
    -- saida por cancelamento/estorno
    'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO',
    -- regra 2: saiu definitivamente da nossa responsabilidade, SEM pagamento
    'DEVOLVIDA',
    -- regra 3: cobranca suspensa temporariamente, SEM pagamento
    'SUSPENSA'
  );
$function$;

comment on function public.parcela_viva(text) is
  'Fonte unica de "parcela ainda cobravel". DEVOLVIDA e SUSPENSA saem do cobravel sem serem pagamento (regra da gestao de 07/10/2026). Status desconhecido conta como VIVO de proposito. NAO inclui RENEGOCIADA: 6 parcelas reais, e 2 dos 57 pontos as tratavam como mortas -- divergencia preservada no lugar.';

-- ---------------------------------------------------------------------------
-- 2. OS 6 PONTOS QUE DIVERGEM POR RENEGOCIADA
-- ---------------------------------------------------------------------------
-- `conferencia_acordos_do_aluno`, `mensalidade_reconciliar_negociado_quitado`,
-- `mensalidade_reconciliar_pago_sem_lastro`, `titulo_reabrir_quitacao_por_acordo`,
-- `titulo_reavaliar` e `saldo_cobravel_aluno` excluem RENEGOCIADA, e por isso
-- classificam 6 parcelas reais diferente da canonica. Colapsa-las mudaria o
-- saldo dessas 6 sem ninguem ter pedido. Entao a lista e ESTENDIDA no lugar:
-- ganham DEVOLVIDA e SUSPENSA, mantem a propria regra de RENEGOCIADA.
do $renegociada$
declare
  r record;
  v_novo text;
  v_trocas int;
  v_total int := 0;
  v_fn int := 0;
begin
  for r in
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~* 'not\s+in\s*\([^)]*''PAGO''[^)]*''RENEGOCIADA''[^)]*\)'
     order by p.proname, p.oid
  loop
    -- Idempotencia: se DEVOLVIDA ja esta na lista, nada a fazer.
    select count(*) into v_trocas
      from regexp_matches(r.def,
        'not\s+in\s*\(([^)]*''PAGO''[^)]*''RENEGOCIADA''[^)]*)\)', 'gi')
     where (regexp_matches)[1] !~* 'DEVOLVIDA';

    if v_trocas = 0 then
      continue;
    end if;

    v_novo := regexp_replace(r.def,
      '(not\s+in\s*\([^)]*''PAGO''[^)]*''RENEGOCIADA'')(\s*\))',
      '\1,''DEVOLVIDA'',''SUSPENSA''\2', 'gi');

    if v_novo = r.def then
      raise exception 'devolvida/suspensa: patch de RENEGOCIADA em %() nao alterou nada. Abortado.', r.proname;
    end if;

    execute v_novo;
    v_total := v_total + v_trocas;
    v_fn := v_fn + 1;
    raise notice 'devolvida/suspensa: %() -- lista com RENEGOCIADA estendida (%)', r.proname, v_trocas;
  end loop;

  -- ESTRUTURAL, nao por contagem (mesma razao da fundacao: contagem fixa torna
  -- a migration intestavel). Nao pode sobrar lista com RENEGOCIADA sem
  -- DEVOLVIDA -- essa seria uma parcela devolvida que continua no saldo.
  select count(*) into v_total
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         lateral regexp_matches(pg_get_functiondef(p.oid),
           'not\s+in\s*\(([^)]*''PAGO''[^)]*''RENEGOCIADA''[^)]*)\)', 'gi') as x
   where n.nspname = 'public' and p.prokind = 'f' and x[1] !~* 'DEVOLVIDA';

  if v_total > 0 then
    raise exception 'devolvida/suspensa: sobraram % lista(s) com RENEGOCIADA sem DEVOLVIDA. Parcela devolvida seguiria no saldo -- abortado.', v_total;
  end if;

  raise notice 'devolvida/suspensa: % funcao(oes) com lista RENEGOCIADA estendida; 0 remanescente.', v_fn;
end
$renegociada$;

-- ---------------------------------------------------------------------------
-- 3. ONDE O EFEITO FICA REGISTRADO NA PARCELA
-- ---------------------------------------------------------------------------
-- `origem_baixa` NAO e reaproveitada. Ela significa "de onde veio a BAIXA", e
-- pela regra 1 baixa pressupoe pagamento. Guardar devolucao ali misturaria para
-- sempre as duas coisas no mesmo campo -- e e exatamente o que o relatorio de
-- baixa le. Colunas proprias, entao.
alter table public.parcelas
  add column if not exists efeito_sem_pagamento        text,
  add column if not exists efeito_sem_pagamento_origem text,
  add column if not exists efeito_sem_pagamento_por    text,
  add column if not exists efeito_sem_pagamento_em     timestamptz;

alter table public.parcelas drop constraint if exists parcelas_efeito_sem_pagamento_valido;
alter table public.parcelas add constraint parcelas_efeito_sem_pagamento_valido
  check (efeito_sem_pagamento is null or efeito_sem_pagamento in ('DEVOLVIDA','SUSPENSA'));

alter table public.parcelas drop constraint if exists parcelas_efeito_origem_valida;
alter table public.parcelas add constraint parcelas_efeito_origem_valida
  check (efeito_sem_pagamento_origem is null or efeito_sem_pagamento_origem = any (array[
    'CANCELAMENTO_COBRANCA','ANTECIPACAO_SEMESTRE',
    'ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO',
    'SUSPENSAO_COBRANCA']));

-- Coerencia: o status da parcela e o campo de efeito nao podem contar
-- historias diferentes.
--
-- VALIDADA, nao NOT VALID. A primeira versao era NOT VALID "por prudencia", e
-- o teste mostrou que isso a deixava sem efeito pratico no caminho que importa.
-- Validar e seguro e foi conferido: as 16.089 linhas existentes tem
-- `efeito_sem_pagamento` nulo e status em (PAGO, VENCIDA, A_VENCER, CANCELADA,
-- RENEGOCIADA), entao TODAS satisfazem a primeira clausula.
alter table public.parcelas drop constraint if exists parcelas_efeito_coerente_com_status;
alter table public.parcelas add constraint parcelas_efeito_coerente_com_status
  check (
    (upper(coalesce(status,'')) not in ('DEVOLVIDA','SUSPENSA') and efeito_sem_pagamento is null)
    or (upper(coalesce(status,'')) = 'DEVOLVIDA' and efeito_sem_pagamento = 'DEVOLVIDA')
    or (upper(coalesce(status,'')) = 'SUSPENSA'  and efeito_sem_pagamento = 'SUSPENSA')
  );

comment on column public.parcelas.efeito_sem_pagamento is
  'DEVOLVIDA (saiu definitivamente da responsabilidade da ReATIVA) ou SUSPENSA (cobranca suspensa temporariamente). Nulo = parcela normal. NUNCA e pagamento: nao gera baixa, honorario nem recuperacao.';
comment on column public.parcelas.efeito_sem_pagamento_origem is
  'Qual tabulacao causou o efeito. O motivo humano fica na tabulacao e na movimentacao do aluno; aqui fica a origem, para filtrar relatorio.';

-- `origem_baixa` volta a ser exclusiva de pagamento real (regra 1). O valor
-- ANTECIPACAO_SEMESTRE entrou em 07/10/2026 e nunca foi usado -- conferido: 0
-- linhas. Sai da lista.
alter table public.parcelas drop constraint if exists parcelas_origem_baixa_valida;
alter table public.parcelas add constraint parcelas_origem_baixa_valida
  check (origem_baixa is null or origem_baixa = any (array[
    'OPERADOR','ADM','GATILHO_IMPORTACAO','BAIXA_RELATORIO','IMPORTACAO_ACORDO','AUTOMACAO']));

-- O titulo do aluno sai da base nos casos DEFINITIVOS. Suspensao NAO entra:
-- a divida continua existindo, so nao se cobra agora.
alter table public.acordos_titulos drop constraint if exists acordos_titulos_origem_encerramento_valida;
alter table public.acordos_titulos add constraint acordos_titulos_origem_encerramento_valida
  check (origem_encerramento is null or origem_encerramento = any (array[
    'CONFERENCIA_PRIME_ADMINISTRATIVA',
    'CANCELAMENTO_COBRANCA','ANTECIPACAO_SEMESTRE',
    'ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO']));

-- ---------------------------------------------------------------------------
-- 4. ACORDO SO QUITA COM PAGAMENTO (regra 1 e 4)
-- ---------------------------------------------------------------------------
-- `_acordo_fecha_com_a_ultima_parcela` fecha o acordo como QUITADO quando nao
-- sobra parcela viva. Depois da fundacao, DEVOLVIDA e SUSPENSA deixam de ser
-- vivas -- e sem esta guarda um acordo inteiro devolvido viraria `QUITADO`,
-- afirmando recuperacao que nao houve. E o acordo QUITADO ainda dispara
-- `titulos_por_status_acordo` -> `titulo_reavaliar`, que carimbaria
-- `origem_liquidacao = 'ACORDO_QUITADO'` nas mensalidades. Seria a regra 4
-- violada em cascata.
do $quita$
declare
  v_def text;
  v_novo text;
begin
  select pg_get_functiondef(oid) into v_def
    from pg_proc where proname = '_acordo_fecha_com_a_ultima_parcela';

  if v_def is null then
    raise exception 'devolvida/suspensa: _acordo_fecha_com_a_ultima_parcela nao existe.';
  end if;

  if v_def ~* 'PAGAMENTO_REAL_OBRIGATORIO' then
    raise notice 'devolvida/suspensa: guarda de quitacao ja aplicada.';
    return;
  end if;

  -- A GUARDA CERTA E "NENHUMA DEVOLVIDA/SUSPENSA", nao "alguma PAGO".
  --
  -- A primeira versao deste patch exigia que ALGUMA parcela estivesse PAGO --
  -- e o teste de comportamento derrubou: acordo com 4 parcelas realmente pagas
  -- e 2 devolvidas passava a guarda e virava QUITADO, afirmando um acordo
  -- liquidado que nao foi. Pagamento parcial + devolucao do resto nao e
  -- quitacao.
  --
  -- O que preserva a semantica ANTERIOR exatamente: antes de DEVOLVIDA e
  -- SUSPENSA existirem, "nao sobra parcela viva" significava, por construcao,
  -- "todas PAGO ou CANCELADA". Entao a guarda e excluir os status novos.
  v_novo := regexp_replace(v_def,
    '(and\s+exists\s*\(\s*select\s+1\s+from\s+public\.parcelas\s+p\s+where\s+p\.acordo_id\s*=\s*a\.id\s*\))',
    '\1' || E'\n' ||
    '     -- PAGAMENTO_REAL_OBRIGATORIO (07/10/2026): acordo NAO vira QUITADO se' || E'\n' ||
    '     -- alguma parcela saiu sem pagamento. Sem isto, devolver ou suspender' || E'\n' ||
    '     -- parcela fecharia o acordo como quitado, e acordo QUITADO dispara' || E'\n' ||
    '     -- titulos_por_status_acordo -> titulo_reavaliar, que carimbaria' || E'\n' ||
    '     -- origem_liquidacao = ACORDO_QUITADO nas mensalidades: regra 4' || E'\n' ||
    '     -- violada em cascata.' || E'\n' ||
    '     and not exists (select 1 from public.parcelas p where p.acordo_id = a.id' || E'\n' ||
    '                      and upper(coalesce(p.status,'''')) in (''DEVOLVIDA'',''SUSPENSA''))',
    'i');

  if v_novo = v_def then
    raise exception 'devolvida/suspensa: nao encontrei a ancora em _acordo_fecha_com_a_ultima_parcela. O corpo em producao mudou -- reler antes de aplicar.';
  end if;

  execute v_novo;
  raise notice 'devolvida/suspensa: guarda de pagamento real aplicada em _acordo_fecha_com_a_ultima_parcela.';
end
$quita$;

-- ---------------------------------------------------------------------------
-- 5. ALERTA D-2 NAO COBRA PARCELA QUE SAIU
-- ---------------------------------------------------------------------------
-- O gatilho de resolucao do alerta D-2 so dispara para PAGO/CANCELADA/
-- ESTORNADA. Sem os status novos, a parcela sai do cobravel e o alerta FICA
-- ABERTO -- o operador seria lembrado de cobrar uma parcela devolvida.
-- O CHECK so existe onde o subsistema de alerta D-2 esta montado. Em producao
-- esta (conferido em 07/10/2026); a fixture de teste monta um subconjunto do
-- schema e nao tem a tabela. O `if` e estrutural e AVISA quando pula -- nao e
-- pulo silencioso.
do $alerta$
begin
  if to_regclass('public.acordo_alertas_parcela') is null then
    raise notice 'devolvida/suspensa: acordo_alertas_parcela nao existe neste banco; CHECK de resolucao nao aplicado.';
    return;
  end if;

  alter table public.acordo_alertas_parcela drop constraint if exists acordo_alertas_parcela_resolucao_check;
  alter table public.acordo_alertas_parcela add constraint acordo_alertas_parcela_resolucao_check
    check (resolucao = any (array['PAGA','ACORDO_QUITADO','ACORDO_CANCELADO','VENCIDA',
                                 'SUBSTITUIDA','BLOQUEADO','DEVOLVIDA','SUSPENSA']));
end
$alerta$;

-- A funcao e o gatilho entram SEMPRE: eles leem a tabela de alerta dentro de um
-- bloco `exception when others`, que e como o projeto ja protege esse caminho.
-- Entao ter o gatilho sem a tabela e inofensivo, e tendo a tabela o rotulo sai
-- certo -- em vez de a regra depender da ordem de montagem do schema.
create or replace function public.tg_acordo_alerta_resolve_parcela()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  begin
    update public.acordo_alertas_parcela set resolvido_em = now(),
           resolucao = case
             when upper(coalesce(new.status,'')) = 'PAGO' then 'PAGA'
             -- + 07/10/2026: nem devolucao nem suspensao e "SUBSTITUIDA".
             -- O rotulo tem de dizer o que de fato aconteceu.
             when upper(coalesce(new.status,'')) = 'DEVOLVIDA' then 'DEVOLVIDA'
             when upper(coalesce(new.status,'')) = 'SUSPENSA' then 'SUSPENSA'
             else 'SUBSTITUIDA' end
     where parcela_id = new.id and resolvido_em is null;
  exception when others then
    begin
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'ALERTA_D2_RESOLVE_FALHOU', 'parcelas', new.id, jsonb_build_object('erro', SQLERRM, 'sqlstate', SQLSTATE));
    exception when others then null;
    end;
  end;
  return null;
end; $function$;

drop trigger if exists trg_acordo_alerta_resolve_parcela on public.parcelas;
create trigger trg_acordo_alerta_resolve_parcela
  after update of status on public.parcelas
  for each row
  when (upper(coalesce(new.status,'')) = any (array['PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO','DEVOLVIDA','SUSPENSA'])
        and new.status is distinct from old.status)
  execute function public.tg_acordo_alerta_resolve_parcela();

-- ---------------------------------------------------------------------------
-- 6. CATALOGO: a tabulacao diz qual efeito aplicar
-- ---------------------------------------------------------------------------
-- `efeito_desfecho` nasceu em 07/10/2026 aceitando so 'ANTECIPACAO_SEMESTRE'.
-- Passa a nomear o EFEITO, nao o caso: uma tabulacao nova so precisa escolher
-- entre devolver e suspender.
-- ORDEM IMPORTA: a CHECK sai, o VALOR ANTIGO e migrado, e so entao a CHECK
-- nova entra. Na ordem inversa a linha que a migration 20261007143000 deixou
-- com `efeito_desfecho = 'ANTECIPACAO_SEMESTRE'` violaria a constraint nova e a
-- migration abortaria -- foi exatamente o que aconteceu na primeira execucao
-- deste arquivo contra a fixture.
alter table public.tabulacoes drop constraint if exists tabulacoes_efeito_desfecho_valido;

-- 'ANTECIPACAO_SEMESTRE' nomeava o CASO; agora o campo nomeia o EFEITO.
update public.tabulacoes
   set efeito_desfecho = 'DEVOLVE_PARCELA'
 where efeito_desfecho = 'ANTECIPACAO_SEMESTRE';

alter table public.tabulacoes add constraint tabulacoes_efeito_desfecho_valido
  check (efeito_desfecho is null or efeito_desfecho in ('DEVOLVE_PARCELA','SUSPENDE_PARCELA'));

comment on column public.tabulacoes.efeito_desfecho is
  'Efeito financeiro que o ato de tabular aplica. DEVOLVE_PARCELA = saldo sai definitivamente e parcela vira DEVOLVIDA. SUSPENDE_PARCELA = cobranca suspensa e parcela vira SUSPENSA. Nulo = tabulacao sem efeito financeiro.';

-- As tres confirmacoes de alegacao. A alegacao original (ALEGA_FIES etc.)
-- CONTINUA como esta: o operador registra que o aluno alegou, o caso vai para a
-- ADM apurar com a unidade. Estas tres sao o desfecho, quando a unidade
-- confirma -- e por isso somente gestao.
insert into public.tabulacoes
  (codigo, rotulo, ativa, ordem, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
   bloqueia_acionamento, sistema, somente_gestao, efeito_desfecho, criado_por)
values
  ('ALEGA_FIES_CONFIRMADO', 'FIES confirmado pela unidade', true, 550, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', true, false, true, 'DEVOLVE_PARCELA', 'gestao 07/10/2026'),
  ('ALEGA_CREDIES_CONFIRMADO', 'CREDIES confirmado pela unidade', true, 560, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', true, false, true, 'DEVOLVE_PARCELA', 'gestao 07/10/2026'),
  ('ALEGA_FINANCIAMENTO_CONFIRMADO', 'Financiamento confirmado pela unidade', true, 570, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', true, false, true, 'DEVOLVE_PARCELA', 'gestao 07/10/2026')
on conflict (codigo) do update
  set rotulo = excluded.rotulo, ativa = excluded.ativa, ordem = excluded.ordem,
      grupo = excluded.grupo, retorno_modo = excluded.retorno_modo,
      retorno_dias_uteis = excluded.retorno_dias_uteis, proxima_acao = excluded.proxima_acao,
      bloqueia_acionamento = excluded.bloqueia_acionamento,
      somente_gestao = excluded.somente_gestao,
      efeito_desfecho = excluded.efeito_desfecho,
      atualizado_em = now(), atualizado_por = 'gestao 07/10/2026';

-- As tres que ja existiam e passam a ter efeito.
update public.tabulacoes
   set efeito_desfecho = 'DEVOLVE_PARCELA',
       atualizado_por = 'gestao 07/10/2026', atualizado_em = now()
 where codigo in ('CANCELAMENTO_COBRANCA','ANTECIPACAO_SEMESTRE');

update public.tabulacoes
   set efeito_desfecho = 'SUSPENDE_PARCELA',
       atualizado_por = 'gestao 07/10/2026', atualizado_em = now()
 where codigo = 'SUSPENSAO_COBRANCA';

-- ESTRUTURAL: toda tabulacao que EXISTE entre as 6 da regra tem de ter o efeito
-- certo. Nao exijo que as 6 existam, porque a fixture de teste monta so um
-- subconjunto -- e exigir presenca transformaria asseguracao de regra em
-- asseguracao de inventario.
do $conf$
declare r record;
begin
  for r in
    select codigo, efeito_desfecho,
           case when codigo = 'SUSPENSAO_COBRANCA' then 'SUSPENDE_PARCELA' else 'DEVOLVE_PARCELA' end as esperado
      from public.tabulacoes
     where codigo in ('CANCELAMENTO_COBRANCA','ANTECIPACAO_SEMESTRE','SUSPENSAO_COBRANCA',
                      'ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO')
  loop
    if coalesce(r.efeito_desfecho,'') <> r.esperado then
      raise exception 'devolvida/suspensa: tabulacao % deveria ter efeito %, tem %.',
        r.codigo, r.esperado, coalesce(r.efeito_desfecho,'(nulo)');
    end if;
  end loop;

  -- E nenhuma OUTRA tabulacao pode ter ganhado efeito por acidente.
  if exists (select 1 from public.tabulacoes
              where efeito_desfecho is not null
                and codigo not in ('CANCELAMENTO_COBRANCA','ANTECIPACAO_SEMESTRE','SUSPENSAO_COBRANCA',
                                   'ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO')) then
    raise exception 'devolvida/suspensa: ha tabulacao com efeito_desfecho fora das 6 aprovadas pela gestao.';
  end if;
end
$conf$;

-- ---------------------------------------------------------------------------
-- 7. AUDITORIA
-- ---------------------------------------------------------------------------
-- Generaliza a tabela criada em 07/10/2026 para a antecipacao (0 linhas,
-- conferido). Renomear preserva policy, indice e grants em vez de recria-los.
do $aud$
begin
  if exists (select 1 from information_schema.tables
              where table_schema='public' and table_name='antecipacao_semestre_auditoria')
     and not exists (select 1 from information_schema.tables
              where table_schema='public' and table_name='parcela_efeito_sem_pagamento_auditoria') then
    if (select count(*) from public.antecipacao_semestre_auditoria) > 0 then
      raise exception 'devolvida/suspensa: antecipacao_semestre_auditoria tem linhas. Renomear perderia o contexto -- decidir antes.';
    end if;
    alter table public.antecipacao_semestre_auditoria
      rename to parcela_efeito_sem_pagamento_auditoria;
  end if;
end
$aud$;

create table if not exists public.parcela_efeito_sem_pagamento_auditoria (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid not null,
  motivo text not null,
  parcelas_quitadas_qtd int not null default 0,
  parcelas_quitadas_valor numeric not null default 0,
  titulos_encerrados_qtd int not null default 0,
  titulos_encerrados_valor numeric not null default 0,
  saldo_antes numeric,
  saldo_depois numeric,
  status_anterior text,
  executado_por text,
  executado_em timestamptz not null default now()
);

alter table public.parcela_efeito_sem_pagamento_auditoria
  add column if not exists efeito text,
  add column if not exists origem text,
  add column if not exists revertida_em timestamptz,
  add column if not exists revertida_por text;

comment on table public.parcela_efeito_sem_pagamento_auditoria is
  'Uma linha por aplicacao de efeito sem pagamento (DEVOLVIDA/SUSPENSA): quanto saiu de parcela, quanto saiu de titulo, saldo antes e depois, qual tabulacao causou e quem decidiu. Nenhum pagamento foi criado em nenhuma delas. revertida_em preenchido quando a suspensao e levantada.';

-- ---------------------------------------------------------------------------
-- 8. O MOTOR
-- ---------------------------------------------------------------------------
create or replace function public.parcela_efeito_sem_pagamento_aplicar(
  p_aluno_id uuid,
  p_motivo text,
  p_origem text,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_efeito_cat text;
  v_efeito  text;
  v_definitivo boolean;
  v_nome text; v_st_ant text;
  v_saldo_antes jsonb; v_saldo_depois jsonb;
  v_parc_qtd int := 0; v_parc_val numeric := 0;
  v_tit_qtd int := 0;  v_tit_val numeric := 0;
  v_ref text;
begin
  if p_aluno_id is null then
    raise exception 'aluno_id nulo.' using errcode = '22023';
  end if;

  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Aplicar devolução ou suspensão de parcela é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;

  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatório: registre o que a unidade confirmou e quando.'
      using errcode = '22023';
  end if;

  -- O EFEITO VEM DO CATALOGO, nunca do chamador. Assim nao existe caminho que
  -- devolva parcela por uma tabulacao que a gestao marcou como suspensao.
  select t.efeito_desfecho into v_efeito_cat
    from public.tabulacoes t
   where t.codigo = p_origem and t.ativa and t.efeito_desfecho is not null;

  if v_efeito_cat is null then
    raise exception 'Tabulação % não tem efeito financeiro no catálogo (tabulacoes.efeito_desfecho).', coalesce(p_origem,'(nula)')
      using errcode = '22023';
  end if;

  v_efeito := case v_efeito_cat when 'DEVOLVE_PARCELA' then 'DEVOLVIDA' else 'SUSPENSA' end;
  v_definitivo := (v_efeito_cat = 'DEVOLVE_PARCELA');

  select nome, coalesce(status_jornada, status_atual, '(sem status)')
    into v_nome, v_st_ant
    from public.alunos where id = p_aluno_id;

  if not exists (select 1 from public.alunos where id = p_aluno_id) then
    raise exception 'Aluno % não existe.', p_aluno_id using errcode = '22023';
  end if;

  v_saldo_antes := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);
  v_ref := lower(p_origem) || ':' || p_aluno_id::text;

  if p_dry_run then
    select count(*), coalesce(sum(coalesce(p.valor,0)),0)
      into v_parc_qtd, v_parc_val
      from public.parcelas p
      join public.acordos a on a.id = p.acordo_id
     where a.aluno_id = p_aluno_id
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and public.parcela_viva(p.status);

    if v_definitivo then
      select count(*), coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)),0)
        into v_tit_qtd, v_tit_val
        from public.acordos_titulos t
       where t.aluno_id = p_aluno_id
         and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
         and coalesce(lower(t.status),'') not in ('quitada')
         and t.origem_encerramento is null
         and not exists (
           select 1 from public.acordo_titulo_vinculo v
             join public.acordos a on a.id = v.acordo_id
            where v.titulo_id = t.id and coalesce(v.ativo, true)
              and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));
    end if;

    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'aluno_id', p_aluno_id,
      'origem', p_origem, 'efeito', v_efeito, 'definitivo', v_definitivo,
      'parcelas_afetadas_qtd', v_parc_qtd, 'parcelas_afetadas_valor', round(v_parc_val,2),
      'titulos_a_encerrar_qtd', v_tit_qtd, 'titulos_a_encerrar_valor', round(v_tit_val,2),
      'saldo_antes', (v_saldo_antes->>'total')::numeric);
  end if;

  perform set_config('parcela_efeito_sem_pagamento.aplicando', 'on', true);

  -- (a) A PARCELA. Nunca PAGO (regra 1). `pago_em`, `origem_baixa` e
  -- `honorarios` ficam INTOCADOS -- nao houve pagamento nem baixa.
  with q as (
    update public.parcelas p
       set status = v_efeito,
           efeito_sem_pagamento = v_efeito,
           efeito_sem_pagamento_origem = p_origem,
           efeito_sem_pagamento_por = coalesce(nullif(v_email,''), 'sistema'),
           efeito_sem_pagamento_em = now(),
           observacao = coalesce(p.observacao,'')
             || case when coalesce(p.observacao,'') = '' then '' else ' | ' end
             || case when v_definitivo
                     then 'DEVOLVIDA em ' else 'SUSPENSA em ' end
             || to_char(now(),'DD/MM/YYYY') || ' por ' || coalesce(nullif(v_email,''),'gestão')
             || ' (' || p_origem || '): ' || btrim(p_motivo)
             || '. Sem pagamento, sem baixa e sem honorário.',
           atualizado_em = now()
     where p.acordo_id in (
             select a.id from public.acordos a
              where a.aluno_id = p_aluno_id
                and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
       and public.parcela_viva(p.status)
    returning coalesce(p.valor,0) as valor)
  select count(*), coalesce(sum(valor),0) into v_parc_qtd, v_parc_val from q;

  -- (b) O TITULO DO ALUNO -- so no caso DEFINITIVO. Em suspensao a divida
  -- continua existindo: o aluno sai da cobranca, o titulo nao sai da base.
  if v_definitivo then
    with e as (
      update public.acordos_titulos t
         set situacao = 'CANCELADA',
             status   = 'cancelada',
             origem_encerramento     = p_origem,
             origem_encerramento_ref = v_ref,
             origem_encerramento_em  = now(),
             motivo_ajuste = coalesce(t.motivo_ajuste,'')
               || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
               || 'encerrado administrativamente (' || p_origem || ') em '
               || to_char(now(),'DD/MM/YYYY') || ' por ' || coalesce(nullif(v_email,''),'gestão')
               || ': ' || btrim(p_motivo)
               || '. Não foi pago a nós. Sem pagamento, acordo ou recuperação.',
             atualizado_em = now()
       where t.aluno_id = p_aluno_id
         and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
         and coalesce(lower(t.status),'') not in ('quitada')
         and t.origem_encerramento is null
         and not exists (
           select 1 from public.acordo_titulo_vinculo v
             join public.acordos a on a.id = v.acordo_id
            where v.titulo_id = t.id and coalesce(v.ativo, true)
              and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
      returning coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor)
    select count(*), coalesce(sum(valor),0) into v_tit_qtd, v_tit_val from e;
  end if;

  -- (c) MARCADOR OPERACIONAL. `quitado_em` e `origem_quitacao` seguem NULOS:
  -- nada disto e quitacao (regra 4).
  update public.alunos
     set status_atual = p_origem,
         status_jornada = p_origem,
         status_acionamento = p_origem,
         situacao_operacional = p_origem,
         valor_em_aberto = case when v_definitivo then 0 else valor_em_aberto end,
         fila_destino = null,
         proxima_acao = null,
         data_retorno = null,
         hora_retorno = null
   where id = p_aluno_id;

  update public.casos
     set status_atual = p_origem,
         status_jornada = p_origem,
         status_acionamento = p_origem,
         status_financeiro = p_origem,
         situacao_operacional = p_origem,
         total_em_aberto = case when v_definitivo then 0 else total_em_aberto end,
         nao_acionar = true,
         quitado_em = null,
         origem_quitacao = null,
         data_retorno = null,
         proxima_acao_automatica = null,
         caso_atualizado_por = coalesce(nullif(v_email,''), 'sistema'),
         caso_atualizado_em = now()
   where aluno_id = p_aluno_id;

  v_saldo_depois := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);

  insert into public.parcela_efeito_sem_pagamento_auditoria
    (aluno_id, motivo, efeito, origem,
     parcelas_quitadas_qtd, parcelas_quitadas_valor,
     titulos_encerrados_qtd, titulos_encerrados_valor,
     saldo_antes, saldo_depois, status_anterior, executado_por)
  values (p_aluno_id, btrim(p_motivo), v_efeito, p_origem,
          v_parc_qtd, round(v_parc_val,2), v_tit_qtd, round(v_tit_val,2),
          (v_saldo_antes->>'total')::numeric, (v_saldo_depois->>'total')::numeric,
          v_st_ant, coalesce(nullif(v_email,''), 'sistema'));

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (p_aluno_id::text, 'PARCELA_' || v_efeito,
    case when v_definitivo then 'Devolução' else 'Suspensão' end
      || ' aplicada por ' || p_origem || ': ' || v_parc_qtd || ' parcela(s) marcada(s) como '
      || v_efeito || ' (' || public.fmt_brl(round(v_parc_val,2)) || ')'
      || case when v_definitivo
              then ' e ' || v_tit_qtd || ' título(s) encerrado(s) administrativamente ('
                   || public.fmt_brl(round(v_tit_val,2)) || '), que deixam de contabilizar no saldo.'
              else '. A dívida continua existindo: a cobrança está suspensa, não encerrada.' end
      || ' Nenhum pagamento, baixa, honorário ou recuperação foi gerado. Motivo: ' || btrim(p_motivo),
    v_st_ant, p_origem,
    coalesce(v_nome, nullif(v_email,''), 'gestão'), coalesce(nullif(v_email,''),'sistema'), now(),
    round(v_parc_val + v_tit_val, 2));

  return jsonb_build_object(
    'ok', true, 'dry_run', false, 'aluno_id', p_aluno_id,
    'origem', p_origem, 'efeito', v_efeito, 'definitivo', v_definitivo,
    'parcelas_afetadas_qtd', v_parc_qtd, 'parcelas_afetadas_valor', round(v_parc_val,2),
    'titulos_encerrados_qtd', v_tit_qtd, 'titulos_encerrados_valor', round(v_tit_val,2),
    'saldo_antes', (v_saldo_antes->>'total')::numeric,
    'saldo_depois', (v_saldo_depois->>'total')::numeric);
end;
$function$;

comment on function public.parcela_efeito_sem_pagamento_aplicar(uuid, text, text, boolean) is
  'Aplica efeito financeiro SEM pagamento. O efeito (DEVOLVIDA/SUSPENSA) vem de tabulacoes.efeito_desfecho, nunca do chamador. NAO escreve PAGO, origem_baixa, honorarios, pagamento, baixa nem quitado_em. Somente gestao. p_dry_run = true (padrao) nao escreve nada.';

revoke all on function public.parcela_efeito_sem_pagamento_aplicar(uuid, text, text, boolean) from public, anon;
grant execute on function public.parcela_efeito_sem_pagamento_aplicar(uuid, text, text, boolean) to authenticated, service_role;

-- A antecipacao passa a ser um caso do motor geral. A funcao de 07/10/2026 e
-- aposentada -- 0 alunos, 0 parcelas, nenhum chamador no front.
drop function if exists public.antecipacao_semestre_aplicar(uuid, text, boolean);

-- ---------------------------------------------------------------------------
-- 9. A VOLTA DA SUSPENSAO
-- ---------------------------------------------------------------------------
-- SUSPENSA e temporaria por definicao. Sem caminho de volta ela seria
-- DEVOLVIDA com outro nome -- e hoje nao existe nenhuma funcao de reativar
-- suspensao no banco (conferido em 07/10/2026).
create or replace function public.suspensao_cobranca_reativar(
  p_aluno_id uuid,
  p_motivo text,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_qtd int := 0; v_val numeric := 0;
  v_nome text;
  v_recalc jsonb;
begin
  if p_aluno_id is null then
    raise exception 'aluno_id nulo.' using errcode = '22023';
  end if;
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Levantar suspensão de cobrança é decisão da gestão.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatório para levantar a suspensão.' using errcode = '22023';
  end if;

  select nome into v_nome from public.alunos where id = p_aluno_id;

  if p_dry_run then
    select count(*), coalesce(sum(coalesce(p.valor,0)),0) into v_qtd, v_val
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where a.aluno_id = p_aluno_id and upper(coalesce(p.status,'')) = 'SUSPENSA';
    return jsonb_build_object('ok', true, 'dry_run', true, 'aluno_id', p_aluno_id,
      'parcelas_a_reativar_qtd', v_qtd, 'parcelas_a_reativar_valor', round(v_val,2));
  end if;

  perform set_config('parcela_efeito_sem_pagamento.aplicando', 'on', true);

  -- Volta para A_VENCER ou VENCIDA conforme o vencimento -- a mesma regra do
  -- cron `atualizar_parcelas_vencidas`, para que o estado nao dependa de quando
  -- a suspensao foi levantada.
  with v as (
    update public.parcelas p
       set status = case when p.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
           efeito_sem_pagamento = null,
           efeito_sem_pagamento_origem = null,
           efeito_sem_pagamento_por = null,
           efeito_sem_pagamento_em = null,
           observacao = coalesce(p.observacao,'')
             || case when coalesce(p.observacao,'') = '' then '' else ' | ' end
             || 'suspensão levantada em ' || to_char(now(),'DD/MM/YYYY')
             || ' por ' || coalesce(nullif(v_email,''),'gestão') || ': ' || btrim(p_motivo),
           atualizado_em = now()
     where p.acordo_id in (select a.id from public.acordos a where a.aluno_id = p_aluno_id)
       and upper(coalesce(p.status,'')) = 'SUSPENSA'
    returning coalesce(p.valor,0) as valor)
  select count(*), coalesce(sum(valor),0) into v_qtd, v_val from v;

  -- O aluno volta para a fila. `nao_acionar` sai, o status volta a neutro e o
  -- motor decide situacao, criticidade e retorno -- em vez de a funcao chutar.
  update public.casos
     set nao_acionar = false,
         status_atual = 'CONTATAR',
         status_jornada = null,
         status_acionamento = null,
         status_financeiro = 'EM_ABERTO',
         situacao_operacional = null,
         caso_atualizado_por = coalesce(nullif(v_email,''), 'sistema'),
         caso_atualizado_em = now()
   where aluno_id = p_aluno_id;

  update public.alunos
     set status_atual = 'CONTATAR',
         status_jornada = null,
         status_acionamento = null,
         situacao_operacional = null
   where id = p_aluno_id;

  v_recalc := public.recalcular_situacao_aluno(p_aluno_id, 'suspensao_reativada');

  update public.parcela_efeito_sem_pagamento_auditoria
     set revertida_em = now(), revertida_por = coalesce(nullif(v_email,''), 'sistema')
   where aluno_id = p_aluno_id and efeito = 'SUSPENSA' and revertida_em is null;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (p_aluno_id::text, 'SUSPENSAO_LEVANTADA',
    'Suspensão de cobrança levantada: ' || v_qtd || ' parcela(s) voltaram a ser cobráveis ('
      || public.fmt_brl(round(v_val,2)) || '). Motivo: ' || btrim(p_motivo),
    coalesce(v_recalc->>'situacao','CONTATAR'),
    coalesce(v_nome, nullif(v_email,''), 'gestão'), coalesce(nullif(v_email,''),'sistema'), now(),
    round(v_val,2));

  return jsonb_build_object('ok', true, 'dry_run', false, 'aluno_id', p_aluno_id,
    'parcelas_reativadas_qtd', v_qtd, 'parcelas_reativadas_valor', round(v_val,2),
    'situacao', v_recalc->>'situacao');
end;
$function$;

comment on function public.suspensao_cobranca_reativar(uuid, text, boolean) is
  'Levanta a suspensao: parcelas SUSPENSA voltam para A_VENCER/VENCIDA pelo vencimento, o aluno volta para a fila e recalcular_situacao_aluno decide o resto. Somente gestao. p_dry_run = true (padrao) nao escreve nada.';

revoke all on function public.suspensao_cobranca_reativar(uuid, text, boolean) from public, anon;
grant execute on function public.suspensao_cobranca_reativar(uuid, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. TABULAR APLICA -- gatilho generico
-- ---------------------------------------------------------------------------
drop trigger if exists trg_tabulacao_antecipacao_semestre on public.alunos;
drop function if exists public.trg_tabulacao_antecipacao_semestre();

create or replace function public.trg_tabulacao_efeito_financeiro()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_efeito text;
begin
  if coalesce(current_setting('parcela_efeito_sem_pagamento.aplicando', true), '') = 'on' then
    return new;
  end if;

  if new.status_jornada is not distinct from old.status_jornada then
    return new;
  end if;

  select t.efeito_desfecho into v_efeito
    from public.tabulacoes t
   where t.codigo = new.status_jornada and t.ativa and t.efeito_desfecho is not null;

  if v_efeito is null then
    return new;
  end if;

  perform public.parcela_efeito_sem_pagamento_aplicar(
    new.id,
    'tabulação "' || new.status_jornada || '" registrada na ficha',
    new.status_jornada,
    false);

  return new;
end;
$$;

comment on function public.trg_tabulacao_efeito_financeiro() is
  'Ao tabular qualquer tabulacao com efeito_desfecho preenchido, aplica o efeito. Quem nao e gestao nunca chega aqui: _encerramento_so_gestao recusa antes.';

create trigger trg_tabulacao_efeito_financeiro
  after update of status_jornada on public.alunos
  for each row execute function public.trg_tabulacao_efeito_financeiro();

-- ---------------------------------------------------------------------------
-- 11. OS TRES CODIGOS NOVOS NAS FUNCOES DE GOVERNANCA
-- ---------------------------------------------------------------------------
-- Patches ancorados: a fundacao ja reescreveu parte destas funcoes, entao o
-- corpo valido e o que esta no banco AGORA, nao o que eu copiei antes.
do $gov$
declare
  v_def text; v_novo text;
  c_novos text := '''ALEGA_FIES_CONFIRMADO'',''ALEGA_CREDIES_CONFIRMADO'',''ALEGA_FINANCIAMENTO_CONFIRMADO''';
begin
  -- 11.1 operador nao tabula confirmacao de alegacao
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = '_encerramento_so_gestao';
  if v_def !~ 'ALEGA_FIES_CONFIRMADO' then
    v_novo := replace(v_def,
      'array[''CANCELAMENTO_COBRANCA'',''SUSPENSAO_COBRANCA'',''JURIDICO'',''ANTECIPACAO_SEMESTRE'']',
      'array[''CANCELAMENTO_COBRANCA'',''SUSPENSAO_COBRANCA'',''JURIDICO'',''ANTECIPACAO_SEMESTRE'','
        || c_novos || ']');
    if v_novo = v_def then
      raise exception 'devolvida/suspensa: ancora nao encontrada em _encerramento_so_gestao.';
    end if;
    execute v_novo;
    raise notice 'devolvida/suspensa: _encerramento_so_gestao -- +3 codigos.';
  end if;

  -- 11.2 o caso sai das filas e da contagem dos 500 (so com titulo zerado,
  --      como ja vale para PAGO/QUITADO/ANTECIPACAO)
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'caso_encerrado_operacional';
  if v_def !~ 'ALEGA FIES CONFIRMADO' then
    v_novo := replace(v_def,
      '''ANTECIPACAO SEMESTRE'']',
      '''ANTECIPACAO SEMESTRE'',''ALEGA FIES CONFIRMADO'',''ALEGA CREDIES CONFIRMADO'',''ALEGA FINANCIAMENTO CONFIRMADO'']');
    if v_novo = v_def then
      raise exception 'devolvida/suspensa: ancora nao encontrada em caso_encerrado_operacional.';
    end if;
    execute v_novo;
    raise notice 'devolvida/suspensa: caso_encerrado_operacional -- +3 codigos.';
  end if;

  -- 11.3 a quitacao automatica nao reescreve nenhum dos marcadores novos
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = '_talvez_quitar_aluno';
  if v_def !~ 'ALEGA_FIES_CONFIRMADO' then
    v_novo := replace(v_def,
      '''SUSPENSAO_COBRANCA'',''ANTECIPACAO_SEMESTRE'')',
      '''SUSPENSAO_COBRANCA'',''ANTECIPACAO_SEMESTRE'',' || c_novos || ')');
    if v_novo = v_def then
      raise exception 'devolvida/suspensa: ancora nao encontrada em _talvez_quitar_aluno.';
    end if;
    v_novo := replace(v_novo,
      'and coalesce(al.status_jornada,'''') = ''ANTECIPACAO_SEMESTRE'')',
      'and coalesce(al.status_jornada,'''') in (''ANTECIPACAO_SEMESTRE'',''CANCELAMENTO_COBRANCA'',''SUSPENSAO_COBRANCA'','
        || c_novos || '))');
    execute v_novo;
    raise notice 'devolvida/suspensa: _talvez_quitar_aluno -- +3 codigos e guarda ampliada.';
  end if;
end
$gov$;

-- ---------------------------------------------------------------------------
-- 12. ASSEGURACAO FINAL
-- ---------------------------------------------------------------------------
do $final$
declare v_n int;
begin
  -- a regra em um lugar so
  if public.parcela_viva('DEVOLVIDA') or public.parcela_viva('SUSPENSA') then
    raise exception 'devolvida/suspensa: parcela_viva ainda considera DEVOLVIDA/SUSPENSA como cobravel.';
  end if;
  if not public.parcela_viva('VENCIDA') or not public.parcela_viva('A_VENCER') then
    raise exception 'devolvida/suspensa: parcela_viva deixou de considerar VENCIDA/A_VENCER como cobravel.';
  end if;
  if public.parcela_viva('PAGO') then
    raise exception 'devolvida/suspensa: parcela_viva considera PAGO como cobravel.';
  end if;

  -- nenhum status novo foi gravado por esta migration (sem backfill)
  select count(*) into v_n from public.parcelas
   where upper(coalesce(status,'')) in ('DEVOLVIDA','SUSPENSA');
  if v_n <> 0 then
    raise exception 'devolvida/suspensa: esta migration gravou % parcela(s) com status novo. Deveria ser 0 (sem backfill).', v_n;
  end if;

  -- a antecipacao nao escreve mais PAGO
  if exists (select 1 from pg_proc where proname = 'antecipacao_semestre_aplicar') then
    raise exception 'devolvida/suspensa: antecipacao_semestre_aplicar ainda existe -- ela gravava PAGO.';
  end if;

  raise notice 'devolvida/suspensa: asseguracao final OK.';
end
$final$;
