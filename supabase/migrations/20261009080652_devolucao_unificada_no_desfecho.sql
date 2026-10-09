-- DEVOLUCAO UNIFICADA: UM caminho de escrita, e o titulo FICA devolvido.
--
-- Autorizado pela gestao em 09/10/2026: "ajustar a CHECK para aceitar as duas
-- origens validas de devolucao e unificar a regra usando devolucao_*,
-- garantindo que o titulo permaneca DEVOLVIDO, sem voltar para CANCELADA".
--
-- O QUE ACONTECEU. Em 08/10/2026 duas sessoes implementaram a MESMA regra, em
-- paralelo, por caminhos diferentes:
--
--   20261008201937 (helper `titulo_devolver_da_confirmacao`) devolvia o titulo
--     EM_CONFIRMACAO usando as colunas `devolucao_*`, encerrava a pendencia da
--     Conferencia Prime como DEVOLVIDO e criou a CHECK
--     `acordos_titulos_devolvido_tem_marca`, que EXIGE essas colunas.
--   20261008202822 (bloco (b) do motor) passou a devolver ABERTO/NEGOCIADO/
--     EM_CONFIRMACAO gravando DEVOLVIDO com `origem_encerramento`, SEM as
--     colunas `devolucao_*`.
--
-- Resultado medido em producao, por simulacao em transacao abortada sobre o
-- titulo 114ce69c (Dante Reck Fleck):
--
--   ERROR: new row for relation "acordos_titulos" violates check constraint
--          "acordos_titulos_devolvido_tem_marca"
--
-- As CINCO tabulacoes definitivas abortavam em qualquer aluno com titulo
-- ABERTO/NEGOCIADO/EM_CONFIRMACAO. SUSPENSAO_COBRANCA seguia funcionando porque
-- passava pelo outro bloco. Medido em 09/10/2026 08:00: 0 titulos DEVOLVIDO em
-- toda a base -- ou seja, NINGUEM conseguiu usar as cinco desde a quebra, e nao
-- existe dado em vocabulario misto para sanear.
--
-- O QUE ESTA MIGRATION FAZ:
--   1. a CHECK aceita `devolucao_origem` OU `origem_encerramento` -- para que
--      nenhuma escrita em voo quebre durante a transicao;
--   2. a regra passa a ter UM escritor so (`titulo_devolver_da_confirmacao`),
--      que grava `devolucao_*` e NAO grava `origem_encerramento`;
--   3. um gatilho novo torna DEVOLVIDO terminal, inclusive com
--      `origem_encerramento` nulo -- e isto que cumpre o "permaneca DEVOLVIDO";
--   4. a reativacao da suspensao volta o titulo para a situacao EXATA que ele
--      tinha antes de ser devolvido, gravada em `devolucao_situacao_anterior`.
--
-- O QUE NAO MUDA, DE PROPOSITO:
--   * QUAIS titulos sao devolvidos. A selecao continua identica ao que esta em
--     producao hoje: nas 5 definitivas, ABERTO/NEGOCIADO (sem vinculo de acordo
--     vivo, nao quitada, sem encerramento anterior) e EM_CONFIRMACAO; na
--     suspensao, somente EM_CONFIRMACAO. Esta migration unifica COMO se escreve,
--     nao O QUE se escolhe;
--   * `_titulo_encerrado_administrativo_protegido` fica como a outra sessao
--     deixou: ela JA trata DEVOLVIDO/devolvido como par terminal e restaura
--     `old.situacao` em vez de forcar CANCELADA. Nao ha o que corrigir ali;
--   * nada cria pagamento, baixa, honorario, acordo, parcela, vinculo ou
--     recuperacao para a ReATIVA -- as TRAVAS abortam se criar;
--   * `quitado_em` e `origem_quitacao` seguem nulos: devolucao nao e quitacao.
--
-- ROLLBACK: supabase/rollbacks/20261009080652_devolucao_unificada_no_desfecho.rollback.sql

-- ---------------------------------------------------------------------------
-- 1. A CHECK ACEITA AS DUAS PROCEDENCIAS
-- ---------------------------------------------------------------------------
-- A intencao original continua: titulo DEVOLVIDO tem de dizer POR QUE saiu da
-- cobranca. O que muda e aceitar as duas marcas enquanto as duas existirem --
-- `devolucao_origem` (o caminho unificado, daqui para frente) ou
-- `origem_encerramento` (o que o bloco (b) gravou em 08/10/2026).
alter table public.acordos_titulos drop constraint if exists acordos_titulos_devolvido_tem_marca;
alter table public.acordos_titulos add constraint acordos_titulos_devolvido_tem_marca
  check (upper(coalesce(situacao,'')) <> 'DEVOLVIDO'
         or devolucao_origem is not null
         or origem_encerramento is not null);

comment on constraint acordos_titulos_devolvido_tem_marca on public.acordos_titulos is
  'Titulo DEVOLVIDO precisa dizer por que saiu da cobranca: devolucao_origem (caminho unificado) ou origem_encerramento (grafia de 08/10/2026). Aceita as duas.';

-- ---------------------------------------------------------------------------
-- 2. DE ONDE O TITULO VEIO
-- ---------------------------------------------------------------------------
-- Sem isto a reativacao da suspensao teria de CHUTAR o destino do titulo. Hoje
-- a suspensao so devolve EM_CONFIRMACAO, entao "voltar para EM_CONFIRMACAO"
-- acerta por coincidencia; no dia em que a selecao mudar, acertar por
-- coincidencia vira apagar divida em silencio. A situacao anterior fica
-- gravada na propria linha.
alter table public.acordos_titulos
  add column if not exists devolucao_situacao_anterior text;

comment on column public.acordos_titulos.devolucao_situacao_anterior is
  'Situacao que o titulo tinha imediatamente antes de ser devolvido (ABERTO, NEGOCIADO ou EM_CONFIRMACAO). E para ca que suspensao_cobranca_reativar o devolve.';

-- ---------------------------------------------------------------------------
-- 3. DEVOLVIDO E TERMINAL -- com ou sem origem_encerramento
-- ---------------------------------------------------------------------------
-- `_titulo_encerrado_administrativo_protegido` so age quando
-- `old.origem_encerramento` NAO e nulo. Como o caminho unificado deixa essa
-- coluna NULA, sem este gatilho um titulo devolvido ficaria sem nenhuma
-- protecao: qualquer rotina de recalculo em lote poderia reabri-lo.
--
-- A unica porta de saida e a marca oficial `conferencia_prime.decisao`, a mesma
-- que a Conferencia Prime e a reativacao da suspensao usam. Nao e um "nao
-- mexe nunca": e "so mexe quem assinou".
create or replace function public._titulo_devolvido_e_terminal()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_oficial boolean := coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on';
begin
  -- So protege quem JA estava devolvido. A devolucao em si (ABERTO/NEGOCIADO/
  -- EM_CONFIRMACAO -> DEVOLVIDO) nao passa por aqui.
  if v_oficial or upper(coalesce(old.situacao,'')) <> 'DEVOLVIDO' then
    return new;
  end if;

  if upper(coalesce(new.situacao,'')) <> 'DEVOLVIDO'
     or lower(coalesce(new.status,'')) <> 'devolvido'
     or new.devolucao_origem is distinct from old.devolucao_origem
     or new.devolucao_em is distinct from old.devolucao_em
     or new.devolucao_situacao_anterior is distinct from old.devolucao_situacao_anterior then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('sistema', 'TITULO_DEVOLVIDO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,
            jsonb_build_object('documento', old.documento,
                               'tentou_situacao', new.situacao, 'tentou_status', new.status,
                               'devolucao_origem', old.devolucao_origem));
    new.situacao := old.situacao;
    new.status   := old.status;
    new.devolucao_origem := old.devolucao_origem;
    new.devolucao_em     := old.devolucao_em;
    new.devolucao_situacao_anterior := old.devolucao_situacao_anterior;
  end if;

  return new;
end;
$function$;

comment on function public._titulo_devolvido_e_terminal() is
  'Titulo DEVOLVIDO nao volta a ser cobrado por efeito colateral: a reabertura e recusada e registrada em auditoria. Unica porta: set_config(conferencia_prime.decisao, on), usada pela Conferencia Prime e por suspensao_cobranca_reativar.';

-- O nome com `devolvido` cai ANTES de `em_confirmacao`, `encerrado`, `liquidado`
-- e `situacao_status` na ordem alfabetica, que e a ordem de disparo de gatilhos
-- do mesmo evento. Importa: se restaurarmos DEVOLVIDO/devolvido aqui,
-- `_titulo_situacao_e_status_coerentes` depois confirma o par -- nao o desfaz.
drop trigger if exists trg_titulo_devolvido_terminal on public.acordos_titulos;
create trigger trg_titulo_devolvido_terminal
  before update on public.acordos_titulos
  for each row execute function public._titulo_devolvido_e_terminal();

-- ---------------------------------------------------------------------------
-- 4. O ESCRITOR UNICO
-- ---------------------------------------------------------------------------
-- Generalizado: antes so aceitava EM_CONFIRMACAO; agora e o unico caminho de
-- escrita para QUALQUER titulo que o desfecho devolve. O nome fica como estava
-- porque e o que os dois chamadores (o motor e o retroativo) e os GRANTs
-- referenciam -- renomear seria churn sem ganho.
--
-- QUEM ESCOLHE OS TITULOS E O MOTOR, nao esta funcao. Aqui ficam apenas as
-- recusas de seguranca que valem SEMPRE: estado terminal, pagamento real e
-- liquidacao oficial da Prime. Essa divisao e de proposito -- a elegibilidade
-- muda com a regra de negocio, as recusas de seguranca nao.
create or replace function public.titulo_devolver_da_confirmacao(
  p_titulo_id uuid,
  p_origem    text,
  p_motivo    text,
  p_quem      text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_ator    text := coalesce(nullif(btrim(coalesce(p_quem,'')),''), nullif(v_email,''), 'sistema');
  v_t       public.acordos_titulos%rowtype;
  v_sit_ant text;
  v_valor   numeric;
  v_estado  text;
  v_tinha_pendencia boolean;
  v_pag0 int; v_ac0 int; v_parc0 int; v_vinc0 int; v_baixa0 int; v_hon0 numeric;
begin
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Devolver titulo e decisao da gestao. Registre a solicitacao para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatorio: a devolucao precisa dizer qual tabulacao encerrou o caso e quando.'
      using errcode = '22023';
  end if;

  -- O efeito vem do CATALOGO. Nao existe caminho que devolva titulo por uma
  -- tabulacao que a gestao nao marcou como desfecho.
  if not exists (select 1 from public.tabulacoes
                  where codigo = p_origem and ativa and efeito_desfecho is not null) then
    raise exception 'Tabulacao % nao tem efeito de desfecho no catalogo (tabulacoes.efeito_desfecho).',
      coalesce(p_origem,'(nula)') using errcode = '22023';
  end if;

  select * into v_t from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO: %', p_titulo_id using errcode = '22023';
  end if;

  v_sit_ant := upper(coalesce(v_t.situacao,''));

  -- IDEMPOTENTE e DEFENSIVO. Reexecucao do retroativo nao devolve duas vezes;
  -- e nenhum estado terminal ou pago e tocado -- devolver um titulo PAGO
  -- apagaria dinheiro que entrou de verdade.
  if v_sit_ant not in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     or lower(coalesce(v_t.status,'')) in ('quitada','paga','cancelada','devolvido')
     or coalesce(v_t.origem_liquidacao,'') = 'PRIME_LIQUIDACAO_OFICIAL' then
    return jsonb_build_object('ok', true, 'ignorado', true, 'titulo_id', p_titulo_id,
      'situacao', v_t.situacao, 'status', v_t.status,
      'por_que', case
        when coalesce(v_t.origem_liquidacao,'') = 'PRIME_LIQUIDACAO_OFICIAL'
          then 'liquidado oficialmente na Prime -- pagamento real, nao se devolve'
        else 'situacao/status nao e devolvivel' end);
  end if;

  select count(*) into v_pag0   from public.pagamentos;
  select count(*) into v_ac0    from public.acordos;
  select count(*) into v_parc0  from public.parcelas;
  select count(*) into v_vinc0  from public.acordo_titulo_vinculo;
  select count(*) into v_baixa0 from public.baixas_pagamento;
  select coalesce(sum(coalesce(honorarios,0)),0) into v_hon0 from public.parcelas;

  v_valor := round(coalesce(v_t.valor_cobranca_ajustado, v_t.saldo_corrigido,
                            v_t.valor_em_aberto, v_t.valor_original, 0), 2);

  v_tinha_pendencia := exists (select 1 from public.prime_conferencia_decisao
                                where titulo_id = p_titulo_id and decisao = 'PENDENTE');

  -- A MARCA OFICIAL. Sem ela, sair de EM_CONFIRMACAO nao falha: o gatilho
  -- `_titulo_em_confirmacao_protegido` reescreve new.* de volta e o UPDATE
  -- "funciona" sem mudar nada.
  --
  -- `origem_encerramento` fica NULO de proposito: e o que distingue a devolucao
  -- por tabulacao do encerramento administrativo apurado pela propria Prime.
  -- Quem protege o estado e `trg_titulo_devolvido_terminal`.
  perform set_config('conferencia_prime.decisao', 'on', true);
  update public.acordos_titulos
     set situacao = 'DEVOLVIDO',
         status   = 'devolvido',
         valor_em_aberto = 0,
         devolucao_origem = p_origem,
         devolucao_ref    = lower(p_origem) || ':' || v_t.aluno_id::text,
         devolucao_em     = now(),
         devolucao_por    = v_ator,
         devolucao_situacao_anterior = v_sit_ant,
         motivo_ajuste = coalesce(motivo_ajuste,'')
           || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
           || 'devolvido por ' || p_origem || ' (vinha de ' || v_sit_ant || ') em '
           || to_char(now(),'DD/MM/YYYY HH24:MI') || ' por ' || v_ator
           || ': ' || btrim(p_motivo)
           || '. Saldo cobravel zero. Sem pagamento, baixa, honorario ou recuperacao para a ReATIVA.',
         atualizado_em = now()
   where id = p_titulo_id;
  perform set_config('conferencia_prime.decisao', 'off', true);

  -- A PENDENCIA DA CONFERENCIA PRIME ENCERRA AQUI -- so se existia uma. Titulo
  -- ABERTO/NEGOCIADO nao tem decisao pendente, e inventar uma poluiria o
  -- historico da Prime com decisao que ninguem pediu.
  if v_tinha_pendencia then
    update public.prime_conferencia_decisao
       set decisao      = 'DEVOLVIDO',
           motivo       = btrim(p_motivo),
           decidido_por = v_ator,
           decidido_em  = now()
     where titulo_id = p_titulo_id and decisao = 'PENDENTE';
  end if;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (v_t.aluno_id::text, 'TITULO_DEVOLVIDO',
    'Titulo ' || coalesce(v_t.documento,'?') || ' (venc. '
      || coalesce(to_char(v_t.vencimento,'DD/MM/YYYY'),'?')
      || ') devolvido por ' || p_origem || ': a tabulacao finalizou o caso, entao o titulo '
      || 'deixa de contabilizar'
      || case when v_tinha_pendencia then ' e a pendencia da Conferencia Prime encerra. ' else '. ' end
      || 'Sem pagamento, baixa, honorario ou recuperacao para a ReATIVA. ' || btrim(p_motivo),
    v_sit_ant, 'DEVOLVIDO',
    v_ator, v_ator, now(), v_valor);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_ator, 'TITULO_DEVOLVIDO_POR_DESFECHO', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('documento', v_t.documento, 'aluno_id', v_t.aluno_id,
                             'valor', v_valor, 'origem', p_origem, 'motivo', btrim(p_motivo),
                             'situacao_anterior', v_sit_ant, 'status_anterior', v_t.status,
                             'pendencia_prime_encerrada', v_tinha_pendencia,
                             'sem_efeito_financeiro', true));

  -- TRAVAS. A primeira existe porque a reversao SILENCIOSA do gatilho e o modo
  -- de falha real desta escrita: sem conferir, a funcao devolveria ok: true
  -- sobre um titulo que continua como estava.
  select upper(coalesce(situacao,'')) || '/' || lower(coalesce(status,'')) into v_estado
    from public.acordos_titulos where id = p_titulo_id;
  if v_estado <> 'DEVOLVIDO/devolvido' then
    raise exception 'TRAVA: titulo % nao ficou DEVOLVIDO/devolvido (ficou %). Nada foi confirmado.',
      p_titulo_id, v_estado using errcode = 'P0001';
  end if;

  -- A segunda cobre as SEIS tabelas por onde dinheiro e recuperacao entrariam,
  -- mais a soma de honorarios -- porque honorario nao muda a CONTAGEM de
  -- parcelas, so o valor, e era o furo que a contagem sozinha deixava.
  if (select count(*) from public.pagamentos) <> v_pag0
     or (select count(*) from public.acordos) <> v_ac0
     or (select count(*) from public.parcelas) <> v_parc0
     or (select count(*) from public.acordo_titulo_vinculo) <> v_vinc0
     or (select count(*) from public.baixas_pagamento) <> v_baixa0
     or (select coalesce(sum(coalesce(honorarios,0)),0) from public.parcelas) <> v_hon0 then
    raise exception 'TRAVA: a devolucao criou pagamento/baixa/acordo/parcela/vinculo ou mexeu em honorario -- nao ha recuperacao nenhuma aqui. Nada foi confirmado.'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true, 'ignorado', false, 'titulo_id', p_titulo_id,
    'aluno_id', v_t.aluno_id, 'documento', v_t.documento, 'origem', p_origem,
    'situacao_anterior', v_sit_ant, 'situacao', 'DEVOLVIDO', 'status', 'devolvido',
    'valor', v_valor, 'pendencia_prime_encerrada', v_tinha_pendencia,
    'efeito_financeiro', 'nenhum');
end;
$function$;

comment on function public.titulo_devolver_da_confirmacao(uuid, text, text, text) is
  'ESCRITOR UNICO da devolucao por desfecho. Recebe UM titulo ABERTO/NEGOCIADO/EM_CONFIRMACAO e o deixa DEVOLVIDO/devolvido com as marcas devolucao_* (origem_encerramento fica NULO), zera valor_em_aberto, encerra a pendencia da Conferencia Prime quando existe, e registra motivo/usuario/data em aluno_movimentacoes e auditoria. Recusa titulo terminal, pago ou com origem_liquidacao = PRIME_LIQUIDACAO_OFICIAL. Duas TRAVAS: estado final e integridade financeira (6 tabelas + soma de honorarios). Idempotente. Somente gestao ou sistema.';

revoke all on function public.titulo_devolver_da_confirmacao(uuid, text, text, text) from public, anon;
grant execute on function public.titulo_devolver_da_confirmacao(uuid, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4b. QUAIS TITULOS SAO DEVOLVIVEIS -- o predicado, em um lugar so
-- ---------------------------------------------------------------------------
-- Existe para que a PREVIA e o LACO REAL do motor usem a mesma clausula. Era
-- esse o furo de origem: a previa de 08/10/2026 contava EM_CONFIRMACAO num
-- SELECT e o laco devolvia por outro, e os dois podiam discordar sem que nada
-- avisasse. Agora discordar e impossivel -- ha uma clausula so.
--
-- `p_definitivo` vem de `tabulacoes.efeito_desfecho`: true para as 5 que
-- encerram (DEVOLVE_PARCELA), false para SUSPENSAO_COBRANCA.
create or replace function public.titulos_devolviveis_por_desfecho(
  p_aluno_id   uuid,
  p_definitivo boolean
)
returns table (id uuid, situacao text, valor numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select t.id,
         upper(coalesce(t.situacao,'')) as situacao,
         round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                        t.valor_em_aberto, t.valor_original, 0), 2) as valor
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and coalesce(t.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL'
     and (
       -- Titulo aguardando a Conferencia Prime: sai nas SEIS tabulacoes. O caso
       -- foi finalizado; deixar a pendencia aberta e pedir decisao sobre algo
       -- que ninguem vai mais cobrar.
       upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
       or (
         -- Divida viva do aluno: sai SO nas definitivas. Suspensao suspende a
         -- cobranca, nao encerra a divida.
         p_definitivo
         and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
         and coalesce(lower(t.status),'') not in ('quitada','paga','cancelada','devolvido')
         and t.origem_encerramento is null
         -- Coberto por acordo vivo fica de fora: a divida dele sao as PARCELAS
         -- do acordo, que o bloco (a) ja tratou. Tirar os dois seria tirar a
         -- mesma divida duas vezes.
         and not exists (
           select 1 from public.acordo_titulo_vinculo v
             join public.acordos a on a.id = v.acordo_id
            where v.titulo_id = t.id and coalesce(v.ativo, true)
              and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
       )
     );
$function$;

comment on function public.titulos_devolviveis_por_desfecho(uuid, boolean) is
  'Os titulos que uma tabulacao de desfecho devolve, para um aluno. EM_CONFIRMACAO nas seis tabulacoes; ABERTO/NEGOCIADO sem acordo vivo somente nas definitivas. Nunca titulo liquidado oficialmente na Prime. Fonte unica do predicado: a previa e o laco real do motor leem desta funcao.';

-- Sem grant para `authenticated`: o motor e o retroativo sao SECURITY DEFINER e
-- executam esta funcao como o dono, independentemente de quem chamou. Dar o
-- grant seria expor a leitura de titulo por aluno_id sem necessidade nenhuma.
revoke all on function public.titulos_devolviveis_por_desfecho(uuid, boolean) from public, anon, authenticated;
grant execute on function public.titulos_devolviveis_por_desfecho(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. O MOTOR: UM bloco de devolucao, no lugar de dois
-- ---------------------------------------------------------------------------
-- Antes desta migration o motor tinha DOIS blocos devolvendo titulo: o (b), que
-- gravava `origem_encerramento`, e o (b2), que chamava o helper. Eles nao se
-- atropelavam por acidente de ordem -- o (b) rodava primeiro e o (b2) ja nao
-- achava nada --, mas eram duas copias da mesma regra, e a CHECK provou o
-- preco disso em menos de dez minutos.
--
-- A SELECAO E A MESMA de producao em 09/10/2026, deliberadamente:
--   * nas 5 definitivas: ABERTO/NEGOCIADO (nao quitada, sem encerramento
--     anterior, sem vinculo de acordo vivo) MAIS EM_CONFIRMACAO;
--   * na suspensao: SOMENTE EM_CONFIRMACAO. Titulo ABERTO/NEGOCIADO continua
--     sendo divida viva do aluno -- suspensao suspende a cobranca, nao encerra.
-- Titulo coberto por acordo vivo fica de fora: a divida dele sao as PARCELAS do
-- acordo, que o bloco (a) ja tratou. Devolver os dois seria tirar a mesma
-- divida duas vezes.
create or replace function public.parcela_efeito_sem_pagamento_aplicar(
  p_aluno_id uuid,
  p_motivo   text,
  p_origem   text,
  p_dry_run  boolean default true
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
  -- `tit` = o que vinha de ABERTO/NEGOCIADO (saiu do saldo);
  -- `dev` = o que vinha de EM_CONFIRMACAO (saiu da confirmacao).
  -- Duas contas separadas porque sao causas diferentes no relatorio, e porque
  -- as 43 linhas de auditoria de 08/10/2026 ja usam essa separacao.
  v_tit_qtd int := 0;  v_tit_val numeric := 0;
  v_dev_qtd int := 0;  v_dev_val numeric := 0;
  v_tit record;
  v_res jsonb;
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

  if p_dry_run then
    select count(*), coalesce(sum(coalesce(p.valor,0)),0)
      into v_parc_qtd, v_parc_val
      from public.parcelas p
      join public.acordos a on a.id = p.acordo_id
     where a.aluno_id = p_aluno_id
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and public.parcela_viva(p.status);

    -- A previa usa EXATAMENTE o mesmo predicado do laco real (abaixo), para
    -- que "o que vai acontecer" e "o que aconteceu" nao possam divergir.
    select count(*) filter (where upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO')),
           coalesce(sum(valor) filter (where upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO')),0),
           count(*) filter (where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO'),
           coalesce(sum(valor) filter (where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO'),0)
      into v_tit_qtd, v_tit_val, v_dev_qtd, v_dev_val
      from public.titulos_devolviveis_por_desfecho(p_aluno_id, v_definitivo);

    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'aluno_id', p_aluno_id,
      'origem', p_origem, 'efeito', v_efeito, 'definitivo', v_definitivo,
      'parcelas_afetadas_qtd', v_parc_qtd, 'parcelas_afetadas_valor', round(v_parc_val,2),
      'titulos_a_encerrar_qtd', v_tit_qtd, 'titulos_a_encerrar_valor', round(v_tit_val,2),
      'titulos_a_devolver_qtd', v_dev_qtd, 'titulos_a_devolver_valor', round(v_dev_val,2),
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

  -- (b) O TITULO -- um laco so, um escritor so.
  for v_tit in
    select id, situacao, valor
      from public.titulos_devolviveis_por_desfecho(p_aluno_id, v_definitivo)
     order by id
  loop
    v_res := public.titulo_devolver_da_confirmacao(v_tit.id, p_origem, btrim(p_motivo));
    -- `ignorado` nao entra na conta: a auditoria tem de somar o que MUDOU.
    if coalesce((v_res->>'ignorado')::boolean, false) = false then
      if upper(coalesce(v_tit.situacao,'')) = 'EM_CONFIRMACAO' then
        v_dev_qtd := v_dev_qtd + 1; v_dev_val := v_dev_val + coalesce(v_tit.valor,0);
      else
        v_tit_qtd := v_tit_qtd + 1; v_tit_val := v_tit_val + coalesce(v_tit.valor,0);
      end if;
    end if;
  end loop;

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
     titulos_devolvidos_qtd, titulos_devolvidos_valor,
     saldo_antes, saldo_depois, status_anterior, executado_por)
  values (p_aluno_id, btrim(p_motivo), v_efeito, p_origem,
          v_parc_qtd, round(v_parc_val,2), v_tit_qtd, round(v_tit_val,2),
          v_dev_qtd, round(v_dev_val,2),
          (v_saldo_antes->>'total')::numeric, (v_saldo_depois->>'total')::numeric,
          v_st_ant, coalesce(nullif(v_email,''), 'sistema'));

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (p_aluno_id::text, 'PARCELA_' || v_efeito,
    case when v_definitivo then 'Devolução' else 'Suspensão' end
      || ' aplicada por ' || p_origem || ': ' || v_parc_qtd || ' parcela(s) marcada(s) como '
      || v_efeito || ' (' || public.fmt_brl(round(v_parc_val,2)) || ')'
      || case when v_tit_qtd > 0
              then ' e ' || v_tit_qtd || ' título(s) devolvido(s) ('
                   || public.fmt_brl(round(v_tit_val,2)) || '), que deixam de contabilizar no saldo.'
              when v_definitivo then '.'
              else '. A dívida continua existindo: a cobrança está suspensa, não encerrada.' end
      || case when v_dev_qtd > 0
              then ' ' || v_dev_qtd || ' título(s) saíram da Conferência Prime como DEVOLVIDO ('
                   || public.fmt_brl(round(v_dev_val,2)) || '), encerrando a pendência.'
              else '' end
      || ' Nenhum pagamento, baixa, honorário ou recuperação foi gerado. Motivo: ' || btrim(p_motivo),
    v_st_ant, p_origem,
    coalesce(v_nome, nullif(v_email,''), 'gestão'), coalesce(nullif(v_email,''),'sistema'), now(),
    round(v_parc_val + v_tit_val + v_dev_val, 2));

  return jsonb_build_object(
    'ok', true, 'dry_run', false, 'aluno_id', p_aluno_id,
    'origem', p_origem, 'efeito', v_efeito, 'definitivo', v_definitivo,
    'parcelas_afetadas_qtd', v_parc_qtd, 'parcelas_afetadas_valor', round(v_parc_val,2),
    'titulos_encerrados_qtd', v_tit_qtd, 'titulos_encerrados_valor', round(v_tit_val,2),
    'titulos_devolvidos_qtd', v_dev_qtd, 'titulos_devolvidos_valor', round(v_dev_val,2),
    'saldo_antes', (v_saldo_antes->>'total')::numeric,
    'saldo_depois', (v_saldo_depois->>'total')::numeric);
end;
$function$;

comment on function public.parcela_efeito_sem_pagamento_aplicar(uuid, text, text, boolean) is
  'Aplica o desfecho de uma tabulacao com efeito_desfecho: (a) marca a parcela DEVOLVIDA ou SUSPENSA e (b) devolve os titulos elegiveis (titulos_devolviveis_por_desfecho) por um unico escritor, titulo_devolver_da_confirmacao, encerrando a pendencia da Conferencia Prime quando existe. NAO cria pagamento, baixa, honorario ou recuperacao e NAO marca quitado_em. Somente gestao. p_dry_run = true (padrao) nao escreve nada e usa o MESMO predicado do laco real.';

-- ---------------------------------------------------------------------------
-- 6. LEVANTAR A SUSPENSAO DESFAZ A DEVOLUCAO -- pela situacao EXATA
-- ---------------------------------------------------------------------------
-- A suspensao e o unico desfecho reversivel, e por isso o unico onde devolver
-- titulo pode APAGAR DIVIDA: se a reativacao nao trouxer o titulo de volta, o
-- aluno volta para a fila com saldo menor do que deve, e ninguem e avisado.
--
-- A versao anterior restaurava 'EM_CONFIRMACAO' fixo. Acertava, porque hoje a
-- suspensao so devolve titulo que vinha de EM_CONFIRMACAO -- mas acertava por
-- coincidencia. Agora le `devolucao_situacao_anterior` e devolve o titulo para
-- onde ele estava, com o status coerente de cada situacao.
create or replace function public.suspensao_cobranca_reativar(
  p_aluno_id uuid,
  p_motivo   text,
  p_dry_run  boolean default true
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
  v_tit_qtd int := 0; v_tit_val numeric := 0;
  v_conf_qtd int := 0;
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
    select count(*), coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                                           t.valor_em_aberto, t.valor_original, 0)),0)
      into v_tit_qtd, v_tit_val
      from public.acordos_titulos t
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) = 'DEVOLVIDO'
       and t.devolucao_origem = 'SUSPENSAO_COBRANCA';
    return jsonb_build_object('ok', true, 'dry_run', true, 'aluno_id', p_aluno_id,
      'parcelas_a_reativar_qtd', v_qtd, 'parcelas_a_reativar_valor', round(v_val,2),
      'titulos_a_restaurar_qtd', v_tit_qtd, 'titulos_a_restaurar_valor', round(v_tit_val,2));
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

  -- O TITULO VOLTA PARA ONDE ESTAVA. A marca `conferencia_prime.decisao` e
  -- necessaria por DOIS motivos aqui: ENTRAR em EM_CONFIRMACAO levanta excecao
  -- sem ela (`_titulo_em_confirmacao_protegido`), e sair de DEVOLVIDO e
  -- recusado sem ela (`_titulo_devolvido_e_terminal`).
  perform set_config('conferencia_prime.decisao', 'on', true);
  with r as (
    update public.acordos_titulos t
       set situacao = coalesce(nullif(t.devolucao_situacao_anterior,''), 'EM_CONFIRMACAO'),
           status = case coalesce(nullif(t.devolucao_situacao_anterior,''), 'EM_CONFIRMACAO')
                      when 'ABERTO'     then 'em_aberto'
                      when 'NEGOCIADO'  then 'vinculada'
                      else 'em_confirmacao' end,
           devolucao_origem = null,
           devolucao_ref    = null,
           devolucao_em     = null,
           devolucao_por    = null,
           devolucao_situacao_anterior = null,
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'devolução desfeita em ' || to_char(now(),'DD/MM/YYYY HH24:MI')
             || ' por ' || coalesce(nullif(v_email,''),'gestão')
             || ': a suspensão de cobrança foi levantada, então o título volta para '
             || coalesce(nullif(t.devolucao_situacao_anterior,''), 'EM_CONFIRMACAO')
             || '. ' || btrim(p_motivo),
           atualizado_em = now()
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) = 'DEVOLVIDO'
       and t.devolucao_origem = 'SUSPENSAO_COBRANCA'
    returning t.id, upper(coalesce(t.situacao,'')) as situacao_restaurada,
              coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                       t.valor_em_aberto, t.valor_original, 0) as valor)
  select count(*), coalesce(sum(valor),0),
         count(*) filter (where situacao_restaurada = 'EM_CONFIRMACAO')
    into v_tit_qtd, v_tit_val, v_conf_qtd from r;
  perform set_config('conferencia_prime.decisao', 'off', true);

  -- A pendencia reabre SO para quem voltou a EM_CONFIRMACAO: quem voltou a
  -- ABERTO/NEGOCIADO nao tem nada a decidir na Prime. `decidido_em` volta a
  -- nulo para a fila voltar a mostra-lo.
  if v_conf_qtd > 0 then
    update public.prime_conferencia_decisao d
       set decisao = 'PENDENTE',
           motivo = 'reaberta em ' || to_char(now(),'DD/MM/YYYY HH24:MI')
                    || ': suspensão de cobrança levantada por '
                    || coalesce(nullif(v_email,''),'gestão') || '. ' || btrim(p_motivo),
           decidido_por = null,
           decidido_em  = null
     where d.decisao = 'DEVOLVIDO'
       and d.titulo_id in (select t.id from public.acordos_titulos t
                            where t.aluno_id = p_aluno_id
                              and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO');
  end if;

  if v_tit_qtd > 0 then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (coalesce(nullif(v_email,''), 'sistema'), 'TITULO_DEVOLUCAO_DESFEITA_POR_REATIVACAO',
            'alunos', p_aluno_id,
            jsonb_build_object('titulos_qtd', v_tit_qtd, 'titulos_valor', round(v_tit_val,2),
                               'voltaram_para_confirmacao', v_conf_qtd,
                               'origem', 'SUSPENSAO_COBRANCA', 'motivo', btrim(p_motivo)));
  end if;

  update public.casos
     set nao_acionar = false,
         status_atual = 'CONTATAR',
         status_jornada = null,
         status_acionamento = 'CONTATAR',
         status_financeiro = 'EM_ABERTO',
         situacao_operacional = null,
         caso_atualizado_por = coalesce(nullif(v_email,''), 'sistema'),
         caso_atualizado_em = now()
   where aluno_id = p_aluno_id;

  update public.alunos
     set status_atual = 'CONTATAR',
         status_jornada = null,
         status_acionamento = 'CONTATAR',
         situacao_operacional = null
   where id = p_aluno_id;

  -- A SUSPENSAO TEM DE TER CAIDO DE VERDADE. Sem esta conferencia, uma
  -- reativacao que nao reativa devolve `ok: true` e o saldo segue fora da
  -- cobranca -- erro silencioso, que e o pior tipo aqui.
  if public.aluno_bloqueio_administrativo(p_aluno_id) = 'SUSPENSAO_COBRANCA' then
    raise exception 'Reativação não levantou a suspensão: o portão ainda bloqueia o aluno %. Nada foi confirmado.', p_aluno_id
      using errcode = 'P0001';
  end if;

  -- E NENHUM TITULO pode ficar devolvido pela suspensao que acabou de cair --
  -- se ficar, a divida desapareceu. Melhor abortar do que confirmar isso.
  if exists (select 1 from public.acordos_titulos
              where aluno_id = p_aluno_id
                and upper(coalesce(situacao,'')) = 'DEVOLVIDO'
                and devolucao_origem = 'SUSPENSAO_COBRANCA') then
    raise exception 'TRAVA: título continua DEVOLVIDO por SUSPENSAO_COBRANCA no aluno % depois da reativação. Nada foi confirmado.', p_aluno_id
      using errcode = 'P0001';
  end if;

  v_recalc := public.recalcular_situacao_aluno(p_aluno_id, 'suspensao_reativada');

  update public.parcela_efeito_sem_pagamento_auditoria
     set revertida_em = now(), revertida_por = coalesce(nullif(v_email,''), 'sistema')
   where aluno_id = p_aluno_id and efeito = 'SUSPENSA' and revertida_em is null;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (p_aluno_id::text, 'SUSPENSAO_LEVANTADA',
    'Suspensão de cobrança levantada: ' || v_qtd || ' parcela(s) voltaram a ser cobráveis ('
      || public.fmt_brl(round(v_val,2)) || ')'
      || case when v_tit_qtd > 0
              then ' e ' || v_tit_qtd || ' título(s) voltaram para a situação anterior ('
                   || public.fmt_brl(round(v_tit_val,2)) || '), '
                   || v_conf_qtd || ' deles aguardando a Conferência Prime.'
              else '.' end
      || ' Motivo: ' || btrim(p_motivo),
    coalesce(v_recalc->>'situacao','CONTATAR'),
    coalesce(v_nome, nullif(v_email,''), 'gestão'), coalesce(nullif(v_email,''),'sistema'), now(),
    round(v_val,2));

  return jsonb_build_object('ok', true, 'dry_run', false, 'aluno_id', p_aluno_id,
    'parcelas_reativadas_qtd', v_qtd, 'parcelas_reativadas_valor', round(v_val,2),
    'titulos_restaurados_qtd', v_tit_qtd, 'titulos_restaurados_valor', round(v_tit_val,2),
    'voltaram_para_confirmacao', v_conf_qtd,
    'situacao', v_recalc->>'situacao');
end;
$function$;

comment on function public.suspensao_cobranca_reativar(uuid, text, boolean) is
  'Levanta a suspensao de cobranca: reativa as parcelas SUSPENSA e restaura os titulos que a suspensao devolveu para a situacao EXATA gravada em devolucao_situacao_anterior, reabrindo a pendencia da Conferencia Prime como PENDENTE so para os que voltaram a EM_CONFIRMACAO. Duas TRAVAS: aborta se o portao administrativo continuar bloqueando o aluno e se sobrar titulo DEVOLVIDO por SUSPENSAO_COBRANCA. Somente gestao.';
