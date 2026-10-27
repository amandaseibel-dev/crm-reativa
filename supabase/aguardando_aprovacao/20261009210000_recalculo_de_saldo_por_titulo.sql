-- NAO APLICAR sem autorizacao expressa da Amanda.
--
-- CORRECAO ESTRUTURAL: aluno SEM CASO nunca teve o saldo recalculado.
--
-- O DEFEITO, medido em producao em 09/10/2026
-- ------------------------------------------
-- 485 alunos tem titulo cobravel em aberto e `alunos.saldo_total` NULO --
-- R$ 692.047,04 de divida que existe em `acordos_titulos` e nao aparece no
-- campo que a carteira, as filas e os indicadores leem. Outros 22 estao com
-- saldo ZERO carregando R$ 70.179,08. Treze desses 485 sao os alunos do
-- bordero 723 (R$ 79.856,84) que motivaram esta frente.
--
-- A CAUSA, em duas metades da mesma coisa: NADA recalcula o saldo de um aluno
-- que nao tem caso.
--
--   1. `acordos_titulos` NAO tem gatilho de recalculo. Todas as outras tabelas
--      financeiras tem: `acordos` (trg_recalc_acordo), `parcelas`
--      (trg_recalc_parcela), `baixas_pagamento` (trg_recalc_baixa),
--      `solicitacoes_confirmacao_pagamento` (trg_recalc_conf), `termos_acordo`
--      (trg_recalc_termo_ins/upd), `acordo_titulo_vinculo`
--      (trg_recalc_vinculo_ins/upd). O bordero grava mensalidade em
--      `acordos_titulos` -- e so ali --, entao nenhum gatilho dispara.
--
--   2. `recalcular_situacao_virada_diaria` varre `from public.casos c`. Quem
--      nao tem caso nao esta na varredura, e por isso a virada do dia seguinte
--      tambem nao corrige. (Um dos 14 CPFs do bordero tem saldo calculado:
--      foi trabalhada e algum outro evento disparou o recalculo. Os outros 13
--      ficaram como estavam.)
--
-- `recalcular_situacao_aluno` JA SABE somar titulo -- o bloco `v_tit_val` le
-- `acordos_titulos` pela regra canonica (ABERTO/NEGOCIADO, status <> quitada,
-- tipo_boleto <> 'Acordo', sem vinculo a acordo vivo, nao superado por acordo).
-- Nao ha regra nova aqui: o que falta e CHAMAR a funcao.
--
-- ASSINATURA CONFERIDA EM PRODUCAO em 27/10/2026 (consulta de catalogo,
-- autorizada): `recalcular_situacao_aluno(p_aluno_id uuid, p_lote text)
-- returns jsonb` -- exatamente a chamada do dreno. `usuario_e_gestao()` e
-- `app_pode_borderos_importacoes()` tambem existem. Nenhum dos objetos criados
-- aqui existe ainda (tabela e os tres gatilhos ausentes).
--
-- POR QUE UMA FILA, E NAO O RECALCULO DIRETO NO GATILHO
-- ----------------------------------------------------
-- `recalcular_situacao_aluno` faz varias consultas por aluno. Um bordero tem
-- 2.155 linhas (723) e grava em lotes de 500: recalcular dentro do gatilho
-- seria ate 500 execucoes da funcao dentro de UMA instrucao, com risco real de
-- estourar o tempo da requisicao do navegador e derrubar uma importacao
-- financeira pela metade. Entao o gatilho e de INSTRUCAO (nao de linha), usa
-- tabela de transicao e faz UMA escrita barata: enfileira os aluno_id
-- distintos. O recalculo acontece depois, em lote controlado, por
-- `recalculo_saldo_pendente_processar`.
--
-- A fila e duravel: se o processamento nao rodar, o pendente fica registrado e
-- e processado na proxima chamada. Nada se perde em silencio.
--
-- NAO TOCA EM DIVIDA. Nem esta migration nem a funcao de recalculo escrevem em
-- `acordos_titulos`, `acordos`, `parcelas`, `pagamentos`, `baixas_pagamento`,
-- `aluno_movimentacoes` ou `solicitacoes_*`. `recalcular_situacao_aluno`
-- escreve em `casos` e `alunos`: criticidade, situacao_operacional,
-- proxima_acao, saldo_vencido, saldo_total, data_retorno, retorno_origem.
-- Responsavel, titulo, pagamento e historico ficam intactos.
--
-- ============================================================================
-- REVISAO DO GUARDIAO EM 27/10/2026 -- esta versao responde a seis apontamentos
-- ============================================================================
-- A versao anterior foi REPROVADA. O que mudou, item por item:
--
--  1. ROLLBACK (§13) -- nao existia. Agora existe, por objeto nomeado, em
--     20261009210000_recalculo_de_saldo_por_titulo.rollback.sql. PITR NAO esta
--     habilitado no projeto: rollback nunca e restore, e sim backup + SQL por
--     id (memoria `pitr-nao-habilitado-rollback-nao-e-restore`). Aqui nao ha
--     dado a salvar -- a fila nasce vazia e o recalculo nao grava divida --,
--     entao a reversa e DDL pura e o rollback diz isso explicitamente.
--
--  2. FOME DE FILA (head-of-line starvation) -- era o defeito mais grave.
--     O dreno ordenava so por `enfileirado_em asc`, entao um aluno que falha
--     FICA NA FRENTE e volta em toda passada. Como `Borderos.jsx` roda ate 10
--     voltas de 500 e le apenas `restantes`, isso dava ate 5.000 execucoes de
--     `recalcular_situacao_aluno` repetindo o MESMO trabalho que falha, com
--     `restantes` que nunca zera -- a assinatura dos incidentes
--     `incidente-saturacao-supabase-kill-switch` e
--     `job38-fluxo-pagamentos-derruba-banco`.
--     Agora: colunas `tentativas`, `ultimo_erro`, `ultima_tentativa`;
--     `order by tentativas asc, enfileirado_em asc`; a falha INCREMENTA
--     `tentativas` e registra o erro; e o dreno so olha `tentativas < teto`.
--     Quem bate o teto SAI da fila de trabalho mas FICA na tabela, contado em
--     `desistidos` -- visivel, nao perdido, nao reprocessado.
--
--  3. FALHA SILENCIOSA DO GATILHO -- era `exception when others then null`,
--     sem contador, sem auditoria, sem rastro. Agora o `exception` registra
--     em `public.auditoria` (acao RECALCULO_FILA_ENFILEIRAR_FALHOU) com o
--     SQLSTATE e a mensagem. O fail-soft CONTINUA -- gravar a divida e mais
--     importante que o campo derivado --, mas deixa de ser cegueira. O insert
--     de auditoria vai em bloco aninhado proprio: se ELE falhar, engole, para
--     que em nenhuma hipotese o gatilho derrube a escrita do titulo.
--
--  4. TRANSACAO E PROVA -- o arquivo nao tinha `begin;`/`commit;` nem bloco
--     `do $prova$`, ao contrario de 20261027120000 e do que o §10 do checklist
--     pede. Agora tem os dois, e a prova confere: a tabela, as tres colunas
--     novas, os tres gatilhos, as duas funcoes, a RLS ligada, a ausencia de
--     policy, e que `anon` nao tem EXECUTE em nada.
--
--  5. PERMISSOES E RLS -- mantidas como estavam, e agora PROVADAS.
--     `force row level security` + zero policy e DELIBERADO: e deny-all para
--     todo papel sem BYPASSRLS. MEDIDO EM PRODUCAO em 27/10/2026: o dono de
--     `acordos_titulos` e `postgres`, e `postgres` tem `rolbypassrls = true`
--     (como `service_role` e `supabase_admin`); `anon` e `authenticated` tem
--     `false`. Como o gatilho e o dreno sao SECURITY DEFINER, rodam como
--     `postgres` e atravessam a RLS -- a fila NAO nasce inerte. O `revoke`
--     passou a incluir `public` por simetria com o resto do repositorio,
--     embora para TABELA a ACL default do schema public nao conceda a PUBLIC
--     (so a anon/authenticated/service_role/postgres) -- para FUNCAO e o
--     contrario, e por isso os revokes de funcao sempre citam `public`.
--
--  6. `set statement_timeout` NA ASSINATURA NAO REARMA o relogio da instrucao
--     em curso -- memoria `proconfig-statement-timeout-nao-rearma`. Era falsa
--     seguranca. Foi RETIRADO da assinatura e o teto real passou a ser o do
--     chamador, somado ao teto de trabalho por chamada (`p_limite`, max 5000)
--     e ao teto de tentativas. Esta escrito aqui para ninguem reintroduzir.
--
-- O QUE ESTA MIGRATION NAO FAZ: nao altera titulo, acordo, parcela, pagamento,
-- baixa, vinculo, responsavel nem historico; nao faz backfill; nao recalcula
-- nada na aplicacao (a fila nasce VAZIA e so recebe em escrita futura de
-- titulo). Aplicar isto NAO corrige os 485 -- quem corrige e o dreno sendo
-- chamado depois, e o retroativo 20261009211000 para os 13 do bordero 723.
-- ============================================================================

begin;

-- Disputa de lock interrompe com seguranca em vez de enfileirar atras de uma
-- transacao longa: os tres `drop trigger` abaixo pegam ACCESS EXCLUSIVE em
-- `acordos_titulos`, e sem teto a migration poderia bloquear TODO leitor da
-- tabela enquanto espera. Com o teto, ela falha rapido e a transacao inteira
-- reverte -- nada pela metade.
set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. A fila
-- ---------------------------------------------------------------------------
create table if not exists public.recalculo_saldo_pendente (
  aluno_id       uuid primary key,
  enfileirado_em timestamptz not null default now(),
  origem         text
);

-- Colunas da correcao 2 (fome de fila). `if not exists` para a migration ser
-- idempotente e para nao quebrar se a tabela ja tiver nascido sem elas.
alter table public.recalculo_saldo_pendente
  add column if not exists tentativas       integer     not null default 0,
  add column if not exists ultimo_erro      text,
  add column if not exists ultima_tentativa timestamptz;

-- Ordem exata do dreno. Sem ele, a varredura e sequencial a cada passada.
create index if not exists ix_recalculo_saldo_pendente_ordem
  on public.recalculo_saldo_pendente (tentativas, enfileirado_em);

alter table public.recalculo_saldo_pendente enable row level security;
alter table public.recalculo_saldo_pendente force row level security;
revoke all on public.recalculo_saldo_pendente from public, anon, authenticated;

comment on table public.recalculo_saldo_pendente is
  'Alunos com titulo alterado cujo saldo ainda nao foi recalculado. Gravada por gatilho de instrucao em acordos_titulos, drenada por recalculo_saldo_pendente_processar. RLS deny-all SEM policy, de proposito: so papel com BYPASSRLS (postgres/service_role, medido em 27/10/2026) alcanca, e o gatilho e o dreno chegam por SECURITY DEFINER. `tentativas` existe para impedir que a mesma falha seja reprocessada para sempre.';

comment on column public.recalculo_saldo_pendente.tentativas is
  'Quantas vezes o dreno tentou e falhou. O dreno so processa tentativas < teto (3); quem passa do teto fica aqui, contado como desistido, e nao e mais reprocessado.';

-- ---------------------------------------------------------------------------
-- 2. O gatilho: de INSTRUCAO, uma escrita por lote, e SEM falha silenciosa
-- ---------------------------------------------------------------------------
create or replace function public._trg_enfileirar_recalculo_titulo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_erro text;
  v_estado text;
begin
  -- Nunca derruba a escrita do titulo: a divida gravar e mais importante que o
  -- campo derivado ficar atualizado no mesmo instante. Se isto falhar, a fila
  -- nao recebe a linha e a divida continua correta em acordos_titulos.
  --
  -- MAS deixa de ser silencioso (apontamento 3 do Guardiao): o erro vai para
  -- `auditoria`. Fail-soft sem rastro e cegueira -- foi assim que 18 dias de
  -- dreno inexistente passaram sem ninguem ver.
  begin
    if TG_OP in ('INSERT','UPDATE') then
      insert into public.recalculo_saldo_pendente (aluno_id, origem)
      select distinct n.aluno_id::uuid, 'trg_titulo_'||lower(TG_OP)
        from novo n where n.aluno_id is not null
      on conflict (aluno_id) do nothing;
    end if;

    if TG_OP in ('UPDATE','DELETE') then
      insert into public.recalculo_saldo_pendente (aluno_id, origem)
      select distinct v.aluno_id::uuid, 'trg_titulo_'||lower(TG_OP)
        from velho v where v.aluno_id is not null
      on conflict (aluno_id) do nothing;
    end if;
  exception when others then
    v_erro   := sqlerrm;
    v_estado := sqlstate;
    -- Bloco aninhado: se a PROPRIA auditoria falhar, engole. Em nenhuma
    -- hipotese o gatilho pode derrubar a escrita do titulo.
    begin
      insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
      values ('sistema', 'RECALCULO_FILA_ENFILEIRAR_FALHOU', 'recalculo_saldo_pendente',
              jsonb_build_object('tg_op', TG_OP, 'sqlstate', v_estado, 'erro', v_erro));
    exception when others then null;
    end;
  end;
  return null;
end;
$function$;

comment on function public._trg_enfileirar_recalculo_titulo() is
  'Gatilho de INSTRUCAO em acordos_titulos: enfileira os aluno_id distintos do lote para recalculo de saldo. Uma escrita por instrucao, nao por linha. Fail-soft -- nunca derruba a escrita do titulo --, mas registra a falha em auditoria (RECALCULO_FILA_ENFILEIRAR_FALHOU) em vez de engolir em silencio.';

revoke all on function public._trg_enfileirar_recalculo_titulo() from public, anon, authenticated;

drop trigger if exists trg_enfileirar_recalculo_titulo_ins on public.acordos_titulos;
create trigger trg_enfileirar_recalculo_titulo_ins
  after insert on public.acordos_titulos
  referencing new table as novo
  for each statement execute function public._trg_enfileirar_recalculo_titulo();

drop trigger if exists trg_enfileirar_recalculo_titulo_upd on public.acordos_titulos;
create trigger trg_enfileirar_recalculo_titulo_upd
  after update on public.acordos_titulos
  referencing new table as novo old table as velho
  for each statement execute function public._trg_enfileirar_recalculo_titulo();

drop trigger if exists trg_enfileirar_recalculo_titulo_del on public.acordos_titulos;
create trigger trg_enfileirar_recalculo_titulo_del
  after delete on public.acordos_titulos
  referencing old table as velho
  for each statement execute function public._trg_enfileirar_recalculo_titulo();

-- ---------------------------------------------------------------------------
-- 3. O dreno
--
--    TETO DE TENTATIVAS = 3. Por que um teto, e nao "tentar sempre": sem ele,
--    um unico aluno cujo recalculo falha (dado inconsistente, timeout de uma
--    consulta interna, qualquer coisa) volta na frente da fila em toda passada
--    e consome o lote inteiro para sempre. Tres tentativas cobrem falha
--    transitoria; a quarta e sinal de que o caso precisa de gente, nao de
--    repeticao.
--
--    NAO HA `set statement_timeout` aqui, de proposito -- ver apontamento 6 no
--    cabecalho. Ele nao rearma o relogio da instrucao em curso, entao era
--    falsa seguranca. O teto real e `p_limite` (max 5000) mais o teto de
--    tentativas, mais o timeout do chamador.
-- ---------------------------------------------------------------------------
create or replace function public.recalculo_saldo_pendente_processar(
  p_limite int default 500,
  p_lote text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_ok int := 0;
  v_erro int := 0;
  v_tent int;
  v_teto_tentativas constant int := 3;
  v_lote text := coalesce(p_lote, 'recalc_'||to_char(now(),'YYYYMMDDHH24MISS'));
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: recalcular saldo e restrito a gestao.' using errcode = '42501';
  end if;

  if p_limite is null or p_limite < 1 or p_limite > 5000 then
    raise exception 'Limite fora da faixa (1..5000): %', p_limite using errcode = '22023';
  end if;

  for r in
    select aluno_id from public.recalculo_saldo_pendente
     where tentativas < v_teto_tentativas
     -- quem ja falhou vai para o FIM, nao para a frente: e isto que impede a
     -- fome de fila que o Guardiao apontou.
     order by tentativas asc, enfileirado_em asc
     limit p_limite
     -- Duas chamadas concorrentes (duas importacoes, ou tela + mao) pegariam o
     -- MESMO aluno. `recalcular_situacao_aluno` e idempotente, entao seria
     -- desperdicio e contencao, nao corrupcao -- mas desperdicio em cima de uma
     -- fila que ja foi acusada de fome nao se deixa passar.
     for update skip locked
  loop
    begin
      -- a funcao canonica, sem regra nova nenhuma
      perform public.recalcular_situacao_aluno(r.aluno_id, v_lote);
      delete from public.recalculo_saldo_pendente where aluno_id = r.aluno_id;
      v_ok := v_ok + 1;
    exception when others then
      -- a linha FICA na fila, mas com tentativas+1 e o erro registrado: na
      -- proxima passada ela vem DEPOIS de quem ainda nao tentou, e depois do
      -- teto nao vem mais.
      update public.recalculo_saldo_pendente
         set tentativas       = tentativas + 1,
             ultimo_erro      = left(sqlstate || ' ' || sqlerrm, 500),
             ultima_tentativa = now()
       where aluno_id = r.aluno_id
      returning tentativas into v_tent;

      -- QUEM OLHA OS DESISTIDOS? Esta linha de auditoria, e e por isso que ela
      -- existe. A fila e deny-all sem policy: nenhum papel da aplicacao
      -- consegue consultar a tabela, e `desistidos` so aparecia no retorno da
      -- RPC. Entao, sem isto, uma linha que desiste sai do radar para sempre --
      -- era o apontamento 3 do parecer do Guardiao de 27/10/2026. `auditoria` e
      -- consultavel pela gestao e ja e onde esta frente registra tudo.
      if v_tent >= v_teto_tentativas then
        begin
          insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
          values ('sistema', 'RECALCULO_SALDO_DESISTIDO', 'recalculo_saldo_pendente',
                  r.aluno_id,
                  jsonb_build_object('tentativas', v_tent,
                                     'teto', v_teto_tentativas,
                                     'ultimo_erro', left(sqlstate || ' ' || sqlerrm, 500),
                                     'lote', v_lote,
                                     'acao_necessaria', 'o saldo deste aluno NAO sera recalculado automaticamente -- precisa de conferencia humana'));
        exception when others then null;
        end;
      end if;
      v_erro := v_erro + 1;
    end;
  end loop;

  return jsonb_build_object(
    'lote', v_lote,
    'processados', v_ok,
    'com_erro', v_erro,
    -- `restantes` conta so o que o dreno AINDA processa. Sem isto, um lote
    -- inteiro de desistidos faria `restantes` nunca zerar e o chamador girar
    -- as 10 voltas para nada.
    'restantes', (select count(*) from public.recalculo_saldo_pendente
                   where tentativas < v_teto_tentativas),
    'desistidos', (select count(*) from public.recalculo_saldo_pendente
                    where tentativas >= v_teto_tentativas),
    'teto_tentativas', v_teto_tentativas);
end;
$function$;

revoke all on function public.recalculo_saldo_pendente_processar(int, text) from public, anon;
grant execute on function public.recalculo_saldo_pendente_processar(int, text) to authenticated;

comment on function public.recalculo_saldo_pendente_processar(int, text) is
  'Drena recalculo_saldo_pendente chamando recalcular_situacao_aluno. So gestao/service_role. Idempotente: a linha sai da fila quando o recalculo passa; quando falha, fica com tentativas+1 e ultimo_erro, e volta para o FIM da ordem. Passado o teto (3) nao e mais processada e aparece em `desistidos` -- visivel, nao perdida, nao reprocessada. `restantes` conta so o que ainda sera processado, para o chamador poder parar.';

-- ---------------------------------------------------------------------------
-- 4. PROVA. Qualquer divergencia aborta a migration inteira.
-- ---------------------------------------------------------------------------
do $prova$
declare v_n int;
begin
  -- 4.1 a fila existe com as tres colunas da correcao
  if not exists (select 1 from pg_class where relname = 'recalculo_saldo_pendente') then
    raise exception 'PROVA: tabela recalculo_saldo_pendente nao foi criada';
  end if;
  select count(*) into v_n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'recalculo_saldo_pendente'
     and column_name in ('tentativas','ultimo_erro','ultima_tentativa');
  if v_n <> 3 then
    raise exception 'PROVA: faltam colunas de controle de tentativa (achei %, esperava 3)', v_n;
  end if;

  -- 4.2 os tres gatilhos de instrucao nasceram
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'public.acordos_titulos'::regclass and not g.tgisinternal
     and g.tgname in ('trg_enfileirar_recalculo_titulo_ins',
                      'trg_enfileirar_recalculo_titulo_upd',
                      'trg_enfileirar_recalculo_titulo_del');
  if v_n <> 3 then
    raise exception 'PROVA: esperava 3 gatilhos de enfileiramento, achei %', v_n;
  end if;

  -- 4.3 os gatilhos de protecao que JA existiam seguem intactos -- esta
  --     migration nao pode custar nenhum deles
  select count(*) into v_n
    from pg_trigger g
   where g.tgrelid = 'public.acordos_titulos'::regclass and not g.tgisinternal
     and g.tgname in ('trg_titulo_em_confirmacao_protegido',
                      'trg_titulo_encerrado_administrativo_protegido',
                      'trg_titulo_liquidado_na_origem_e_terminal');
  if v_n <> 3 then
    raise exception 'PROVA: um dos tres gatilhos de protecao preexistentes desapareceu (achei %)', v_n;
  end if;

  -- 4.4 RLS ligada e forcada, e SEM policy (deny-all deliberado)
  if not exists (select 1 from pg_class
                  where relname = 'recalculo_saldo_pendente'
                    and relrowsecurity and relforcerowsecurity) then
    raise exception 'PROVA: RLS nao esta ligada e forcada em recalculo_saldo_pendente';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'recalculo_saldo_pendente') then
    raise exception 'PROVA: nasceu policy em recalculo_saldo_pendente -- o desenho e deny-all sem policy';
  end if;

  -- 4.5 anon nao recebeu nada
  if has_function_privilege('anon', 'public.recalculo_saldo_pendente_processar(int,text)', 'EXECUTE') then
    raise exception 'PROVA: anon pode executar recalculo_saldo_pendente_processar';
  end if;
  if has_function_privilege('anon', 'public._trg_enfileirar_recalculo_titulo()', 'EXECUTE') then
    raise exception 'PROVA: anon pode executar _trg_enfileirar_recalculo_titulo';
  end if;
  if has_table_privilege('anon', 'public.recalculo_saldo_pendente', 'SELECT')
     or has_table_privilege('authenticated', 'public.recalculo_saldo_pendente', 'SELECT') then
    raise exception 'PROVA: anon ou authenticated tem SELECT na fila';
  end if;
  -- TRUNCATE herdado e a armadilha da skill seguranca-rls: tabela nova herda
  -- TRUNCATE para authenticated se o revoke nao pegar.
  if has_table_privilege('authenticated', 'public.recalculo_saldo_pendente', 'TRUNCATE') then
    raise exception 'PROVA: authenticated tem TRUNCATE na fila';
  end if;

  -- 4.6 a fila nasce VAZIA -- esta migration nao enfileira nem recalcula nada
  if (select count(*) from public.recalculo_saldo_pendente) <> 0 then
    raise exception 'PROVA: a fila nao nasceu vazia -- algo escreveu titulo durante a migration';
  end if;

  -- 4.7 A PREMISSA EM QUE TODO O DESENHO SE APOIA, agora asserida.
  --
  --     A fila e deny-all SEM policy. O gatilho e o dreno so a alcancam porque
  --     sao SECURITY DEFINER e o dono atravessa a RLS. Se o dono NAO tiver
  --     `rolbypassrls`, o INSERT do gatilho falha (e agora vira auditoria, ok)
  --     mas o SELECT do dreno **nao falha: devolve zero linhas** -- e a RPC
  --     responde `processados 0, restantes 0`, verde perfeito com a fila
  --     crescendo. Medido em producao em 27/10/2026 (`postgres`, dono de
  --     acordos_titulos, tem rolbypassrls = true), mas medicao de hoje nao e
  --     garantia de amanha: um CREATE OR REPLACE futuro por outro papel apagaria
  --     a garantia em silencio. Entao a migration passa a exigir a premissa.
  if not exists (
    select 1
      from pg_proc p
      join pg_roles r on r.oid = p.proowner
     where p.proname = 'recalculo_saldo_pendente_processar'
       and p.pronamespace = 'public'::regnamespace
       and (r.rolbypassrls or r.rolsuper)) then
    raise exception
      'PROVA: o dono de recalculo_saldo_pendente_processar nao tem rolbypassrls nem rolsuper -- o dreno leria a fila VAZIA e devolveria sucesso falso. Ver secao 4.7.';
  end if;
end $prova$;

commit;
