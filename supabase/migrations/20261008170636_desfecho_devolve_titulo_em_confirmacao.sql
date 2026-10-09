-- DESFECHO DEVOLVE O QUE ESTAVA EM CONFIRMACAO.
--
-- Pedido da gestao em 08/10/2026. As seis tabulacoes com `efeito_desfecho` no
-- catalogo (medidas em producao hoje) finalizam o caso:
--
--   ANTECIPACAO_SEMESTRE            Antecipacao de semestre        DEVOLVE_PARCELA
--   ALEGA_FIES_CONFIRMADO           FIES confirmado pela unidade   DEVOLVE_PARCELA
--   ALEGA_CREDIES_CONFIRMADO        CREDIES confirmado             DEVOLVE_PARCELA
--   ALEGA_FINANCIAMENTO_CONFIRMADO  Financiamento confirmado       DEVOLVE_PARCELA
--   CANCELAMENTO_COBRANCA           Cancelamento definitivo        DEVOLVE_PARCELA
--   SUSPENSAO_COBRANCA              Suspensao de cobranca          SUSPENDE_PARCELA
--
-- O QUE ESTAVA ERRADO. `parcela_efeito_sem_pagamento_aplicar` trata a parcela
-- (bloco a) e o titulo ABERTO/NEGOCIADO (bloco b), mas NAO toca em titulo
-- `EM_CONFIRMACAO`. Consequencia medida em 08/10/2026: dos 41 alunos tabulados
-- hoje, **4 ficaram com 12 titulos presos em confirmacao** (R$ 27.043,72). E
-- pior que um numero errado na tela:
--
--   * `aluno_saldo_pendente_detalhe` devolve `tem_pendencia = true` enquanto
--     existir titulo EM_CONFIRMACAO -- o caso fica pendente para sempre;
--   * `_talvez_quitar_aluno` retorna na primeira linha pelo mesmo motivo;
--   * a Conferencia Prime continua com a pendencia `PENDENTE` na fila, pedindo
--     decisao sobre um caso que a gestao ja encerrou.
--
-- A ARMADILHA QUE ESTA MIGRATION EXISTE PARA NAO CAIR. Tirar um titulo de
-- EM_CONFIRMACAO com um UPDATE comum **nao falha: nao faz nada**. O gatilho
-- BEFORE `_titulo_em_confirmacao_protegido` reescreve `new.situacao`,
-- `new.status`, `new.aluno_id` e `new.acordo_id` de volta para os valores
-- antigos e grava `TITULO_EM_CONFIRMACAO_ALTERACAO_RECUSADA` em `auditoria`.
-- A unica porta e `set_config('conferencia_prime.decisao','on',true)`, que e
-- como `prime_conferencia_encerrar_administrativo` ja faz desde 19/09/2026.
-- Por isso a escrita mora em UMA funcao, com TRAVA que confere o estado final.
--
-- POR QUE `DEVOLVIDO` E NAO `CANCELADA`. `CANCELADA` + `origem_encerramento` ja
-- significa "encerramento administrativo": e o desfecho que a propria
-- Conferencia Prime aplica quando apura o titulo. O titulo devolvido por
-- tabulacao saiu por outra causa -- a unidade confirmou FIES/CREDIES/
-- financiamento/antecipacao, ou a gestao cancelou/suspendeu a cobranca -- e
-- ninguem apurou nada na Prime. Usar a mesma palavra para as duas causas
-- apagaria essa diferenca no historico. Alem disso
-- `_titulo_encerrado_administrativo_protegido` torna `CANCELADA` +
-- `origem_encerramento` TERMINAL: gravar isso na suspensao tornaria a suspensao
-- irreversivel, exatamente o erro que `suspensao_cobranca_reativar` levou um
-- teste para descobrir. `DEVOLVIDO` fica fora do saldo pelo mesmo caminho dos
-- outros (so ABERTO/NEGOCIADO contam) e nao reabre no bordero -- a lista
-- `SITUACOES_QUE_NAO_REABREM` em src/utils/bordero.js ja previa DEVOLVIDO desde
-- 08/10/2026.
--
-- SUSPENSAO DEVOLVE, E A REATIVACAO DESFAZ. Decisao da gestao em 08/10/2026: as
-- seis devolvem. Como a suspensao e reversivel e `suspensao_cobranca_reativar`
-- so reativava PARCELA, devolver titulo sem mexer nela deixaria o titulo
-- DEVOLVIDO para sempre ao levantar a suspensao -- divida apagada em silencio.
-- Esta migration fecha o par: a reativacao traz o titulo de volta para
-- EM_CONFIRMACAO e reabre a pendencia da Prime como PENDENTE.
--
-- O QUE ESTA MIGRATION NAO FAZ, DE PROPOSITO:
--   * nao insere em `pagamentos`, `baixas_pagamento` nem `acordo_titulo_vinculo`
--     e nao escreve `honorarios` -- nao entrou dinheiro e nao houve recuperacao
--     da ReATIVA. A TRAVA da funcao conta as quatro tabelas antes e depois e
--     aborta se alguma mudou de tamanho;
--   * nao marca `quitado_em` nem `origem_quitacao`;
--   * nao toca em titulo de aluno sem tabulacao de desfecho;
--   * nao reescreve `_talvez_quitar_aluno`: medido em producao hoje, as seis
--     tabulacoes JA estao nas duas listas de guarda dela, entao nenhum destes
--     alunos vira QUITADO quando o ultimo titulo sair da confirmacao.
--
-- ROLLBACK: supabase/rollbacks/20261008170636_desfecho_devolve_titulo_em_confirmacao.rollback.sql

-- ---------------------------------------------------------------------------
-- 1. VOCABULARIO: as marcas da devolucao
-- ---------------------------------------------------------------------------
-- Colunas proprias, e NAO `origem_encerramento`, porque aquela coluna arrasta
-- `_titulo_encerrado_administrativo_protegido`, que forca CANCELADA/cancelada em
-- toda escrita posterior -- e a suspensao precisa poder voltar.
alter table public.acordos_titulos
  add column if not exists devolucao_origem text,
  add column if not exists devolucao_ref    text,
  add column if not exists devolucao_em     timestamptz,
  add column if not exists devolucao_por    text;

alter table public.acordos_titulos drop constraint if exists acordos_titulos_devolucao_origem_valida;
alter table public.acordos_titulos add constraint acordos_titulos_devolucao_origem_valida
  check (devolucao_origem is null or devolucao_origem = any (array[
    'CANCELAMENTO_COBRANCA','ANTECIPACAO_SEMESTRE','ALEGA_FIES_CONFIRMADO',
    'ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO','SUSPENSAO_COBRANCA']));

-- DEVOLVIDO sem a marca de quem/quando/por que seria um estado sem resposta
-- para "por que este titulo saiu da cobranca?".
alter table public.acordos_titulos drop constraint if exists acordos_titulos_devolvido_tem_marca;
alter table public.acordos_titulos add constraint acordos_titulos_devolvido_tem_marca
  check (upper(coalesce(situacao,'')) <> 'DEVOLVIDO'
         or (devolucao_origem is not null and devolucao_em is not null));

comment on column public.acordos_titulos.devolucao_origem is
  'Tabulacao de desfecho que devolveu este titulo da Conferencia Prime. Nulo = titulo nunca devolvido.';

create index if not exists idx_acordos_titulos_devolucao
  on public.acordos_titulos(devolucao_origem, devolucao_em desc)
  where devolucao_origem is not null;

-- A pendencia da Prime passa a ter como encerrar por devolucao. Reaproveitar
-- ENCERRADO_ADMINISTRATIVO diria que a Prime apurou o titulo -- ela nao apurou.
alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_decisao_check;
alter table public.prime_conferencia_decisao add constraint prime_conferencia_decisao_decisao_check
  check (decisao = any (array['PENDENTE','CONFIRMADO','VINCULADO','REJEITADO',
                              'ENCERRADO_ADMINISTRATIVO','DEVOLVIDO']));

-- A auditoria do desfecho passa a contar titulo devolvido separado de titulo
-- encerrado: sao causas diferentes e precisam somar separado no relatorio.
alter table public.parcela_efeito_sem_pagamento_auditoria
  add column if not exists titulos_devolvidos_qtd   int     not null default 0,
  add column if not exists titulos_devolvidos_valor numeric not null default 0;

-- ---------------------------------------------------------------------------
-- 2. COERENCIA situacao <-> status
-- ---------------------------------------------------------------------------
-- Texto base = PRODUCAO lida em 08/10/2026 (ver supabase/ledger/DUAS-TRILHAS.md).
-- Muda UMA linha, marcada. Sem ela, um titulo poderia ficar
-- DEVOLVIDO/em_confirmacao e `statusNaoReabreNoBordero` leria o status antigo.
create or replace function public._titulo_situacao_e_status_coerentes()
returns trigger
language plpgsql set search_path to 'public'
as $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  -- + DEVOLVIDO (08/10/2026): devolvido por tabulacao de desfecho.
  elsif v_sit = 'DEVOLVIDO' and v_st <> 'devolvido' then
    new.status := 'devolvido';
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. A ESCRITA, EM UM LUGAR SO
-- ---------------------------------------------------------------------------
-- Um titulo por chamada. O motor do desfecho e o retroativo chamam ESTA funcao
-- -- duas copias da mesma regra seria a forma de uma delas ficar atras.
create or replace function public.titulo_devolver_da_confirmacao(
  p_titulo_id uuid,
  p_origem    text,
  p_motivo    text,
  -- Quem decidiu. O retroativo passa o `executado_por` da tabulacao original,
  -- para a devolucao ficar no nome de quem tabulou -- e nao no de quem rodou a
  -- correcao. Nulo = quem esta na sessao.
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
  v_valor   numeric;
  v_estado  text;
  v_pag0 int; v_ac0 int; v_parc0 int; v_vinc0 int;
begin
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Devolver titulo da confirmacao e decisao da gestao. Registre a solicitacao para Amanda, Fernanda ou Amanda ADM.'
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

  -- IDEMPOTENTE. Reexecucao do retroativo nao pode devolver duas vezes nem
  -- abortar o lote por causa de um titulo que ja saiu.
  if upper(coalesce(v_t.situacao,'')) <> 'EM_CONFIRMACAO' then
    return jsonb_build_object('ok', true, 'ignorado', true, 'titulo_id', p_titulo_id,
      'situacao', v_t.situacao, 'por_que', 'nao esta EM_CONFIRMACAO');
  end if;

  select count(*) into v_pag0  from public.pagamentos;
  select count(*) into v_ac0   from public.acordos;
  select count(*) into v_parc0 from public.parcelas;
  select count(*) into v_vinc0 from public.acordo_titulo_vinculo;

  v_valor := round(coalesce(v_t.valor_cobranca_ajustado, v_t.saldo_corrigido,
                            v_t.valor_em_aberto, v_t.valor_original, 0), 2);

  -- A MARCA OFICIAL. Sem ela o gatilho `_titulo_em_confirmacao_protegido`
  -- reescreve new.* de volta e este UPDATE "funciona" sem mudar nada.
  perform set_config('conferencia_prime.decisao', 'on', true);
  update public.acordos_titulos
     set situacao = 'DEVOLVIDO',
         status   = 'devolvido',
         devolucao_origem = p_origem,
         devolucao_ref    = lower(p_origem) || ':' || v_t.aluno_id::text,
         devolucao_em     = now(),
         devolucao_por    = v_ator,
         motivo_ajuste = coalesce(motivo_ajuste,'')
           || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
           || 'devolvido da Conferencia Prime por ' || p_origem || ' em '
           || to_char(now(),'DD/MM/YYYY HH24:MI') || ' por ' || v_ator
           || ': ' || btrim(p_motivo)
           || '. Saldo cobravel zero. Sem pagamento, baixa, honorario ou recuperacao para a ReATIVA.',
         atualizado_em = now()
   where id = p_titulo_id;
  perform set_config('conferencia_prime.decisao', 'off', true);

  -- A PENDENCIA DA CONFERENCIA PRIME ENCERRA AQUI. Motivo, usuario e data ficam
  -- na propria linha da decisao -- e onde a tela da Prime le o historico.
  update public.prime_conferencia_decisao
     set decisao      = 'DEVOLVIDO',
         motivo       = btrim(p_motivo),
         decidido_por = v_ator,
         decidido_em  = now()
   where titulo_id = p_titulo_id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (v_t.aluno_id::text, 'TITULO_DEVOLVIDO_CONFIRMACAO',
    'Titulo ' || coalesce(v_t.documento,'?') || ' (venc. '
      || coalesce(to_char(v_t.vencimento,'DD/MM/YYYY'),'?')
      || ') saiu da Conferencia Prime como DEVOLVIDO por ' || p_origem
      || ': a tabulacao finalizou o caso, entao o titulo deixa de contabilizar e a pendencia encerra. '
      || 'Sem pagamento, baixa, honorario ou recuperacao para a ReATIVA. ' || btrim(p_motivo),
    'EM_CONFIRMACAO', 'DEVOLVIDO',
    v_ator, v_ator,
    now(), v_valor);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_ator, 'TITULO_DEVOLVIDO_DA_CONFIRMACAO',
          'acordos_titulos', p_titulo_id,
          jsonb_build_object('documento', v_t.documento, 'aluno_id', v_t.aluno_id,
                             'valor', v_valor, 'origem', p_origem, 'motivo', btrim(p_motivo),
                             'situacao_anterior', v_t.situacao, 'status_anterior', v_t.status,
                             'sem_efeito_financeiro', true));

  -- TRAVAS. A primeira existe porque a reversao silenciosa do gatilho e o modo
  -- de falha real desta escrita: sem conferir, a funcao devolveria ok: true
  -- sobre um titulo que continua em confirmacao.
  select upper(coalesce(situacao,'')) || '/' || lower(coalesce(status,'')) into v_estado
    from public.acordos_titulos where id = p_titulo_id;
  if v_estado <> 'DEVOLVIDO/devolvido' then
    raise exception 'TRAVA: titulo % nao ficou DEVOLVIDO/devolvido (ficou %). Nada foi confirmado.',
      p_titulo_id, v_estado using errcode = 'P0001';
  end if;
  if (select count(*) from public.pagamentos) <> v_pag0
     or (select count(*) from public.acordos) <> v_ac0
     or (select count(*) from public.parcelas) <> v_parc0
     or (select count(*) from public.acordo_titulo_vinculo) <> v_vinc0 then
    raise exception 'TRAVA: devolucao criou pagamento/acordo/parcela/vinculo -- nao ha recuperacao nenhuma aqui.'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true, 'ignorado', false, 'titulo_id', p_titulo_id,
    'aluno_id', v_t.aluno_id, 'documento', v_t.documento, 'origem', p_origem,
    'situacao', 'DEVOLVIDO', 'status', 'devolvido', 'valor', v_valor,
    'decisao_prime', 'DEVOLVIDO', 'efeito_financeiro', 'nenhum');
end;
$function$;

comment on function public.titulo_devolver_da_confirmacao(uuid, text, text, text) is
  'Tira UM titulo de EM_CONFIRMACAO e o deixa DEVOLVIDO/devolvido, encerrando a pendencia da Conferencia Prime (decisao = DEVOLVIDO). Preserva motivo, usuario e data na linha da decisao, em aluno_movimentacoes e em auditoria. NAO cria pagamento, acordo, parcela, vinculo nem honorario -- a TRAVA aborta se criar. Idempotente: titulo fora da confirmacao e ignorado. Somente gestao ou sistema.';

revoke all on function public.titulo_devolver_da_confirmacao(uuid, text, text, text) from public, anon;
grant execute on function public.titulo_devolver_da_confirmacao(uuid, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. O MOTOR DO DESFECHO PASSA A DEVOLVER
-- ---------------------------------------------------------------------------
-- Texto base = PRODUCAO lida em 08/10/2026 (ver supabase/ledger/DUAS-TRILHAS.md).
-- Entra o bloco (b2) e os dois contadores no retorno, no dry-run e na auditoria.
-- Os blocos (a), (b) e (c) ficam byte a byte como estavam.
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
  v_tit_qtd int := 0;  v_tit_val numeric := 0;
  -- + 08/10/2026: o que estava EM_CONFIRMACAO
  v_dev_qtd int := 0;  v_dev_val numeric := 0;
  v_tit record;
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

    -- + 08/10/2026: a previa precisa mostrar a devolucao, senao a gestao decide
    -- sem ver o que vai sair da confirmacao. Vale para as SEIS tabulacoes.
    select count(*), coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                                           t.valor_em_aberto, t.valor_original, 0)),0)
      into v_dev_qtd, v_dev_val
      from public.acordos_titulos t
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO';

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

  -- (b2) O QUE ESTAVA EM CONFIRMACAO -- 08/10/2026.
  -- Vale para as SEIS tabulacoes, inclusive SUSPENSAO_COBRANCA: decisao da
  -- gestao em 08/10/2026. A volta esta em `suspensao_cobranca_reativar`.
  --
  -- Em loop, e nao num UPDATE de conjunto, porque cada titulo precisa da marca
  -- `conferencia_prime.decisao`, da sua linha em `prime_conferencia_decisao`, da
  -- movimentacao, da auditoria e da TRAVA de estado final -- tudo isso mora em
  -- `titulo_devolver_da_confirmacao`, que e tambem o que o retroativo chama.
  for v_tit in
    select t.id,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                    t.valor_em_aberto, t.valor_original, 0) as valor
      from public.acordos_titulos t
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
     order by t.id
  loop
    perform public.titulo_devolver_da_confirmacao(v_tit.id, p_origem, btrim(p_motivo));
    v_dev_qtd := v_dev_qtd + 1;
    v_dev_val := v_dev_val + coalesce(v_tit.valor,0);
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
      || case when v_definitivo
              then ' e ' || v_tit_qtd || ' título(s) encerrado(s) administrativamente ('
                   || public.fmt_brl(round(v_tit_val,2)) || '), que deixam de contabilizar no saldo.'
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
  'Aplica o desfecho de uma tabulacao com efeito_desfecho: (a) marca a parcela DEVOLVIDA ou SUSPENSA, (b) encerra administrativamente o titulo ABERTO/NEGOCIADO quando definitivo, (b2) devolve o titulo EM_CONFIRMACAO (DEVOLVIDO) encerrando a pendencia da Conferencia Prime -- nas seis tabulacoes. NAO cria pagamento, baixa, honorario ou recuperacao e NAO marca quitado_em. Somente gestao. p_dry_run = true (padrao) nao escreve nada.';

-- ---------------------------------------------------------------------------
-- 5. LEVANTAR A SUSPENSAO TRAZ O TITULO DE VOLTA
-- ---------------------------------------------------------------------------
-- Texto base = PRODUCAO lida em 08/10/2026. Entra UM bloco, marcado.
--
-- POR QUE ISTO E OBRIGATORIO. A suspensao e o unico desfecho reversivel. Sem
-- este bloco, devolver o titulo na suspensao o deixaria DEVOLVIDO para sempre:
-- `aluno_bloqueio_administrativo` sairia do caminho, o aluno voltaria para a
-- fila, e a divida que estava em confirmacao teria sumido sem ninguem decidir
-- nada sobre ela. E o mesmo erro silencioso que a TRAVA de
-- `aluno_bloqueio_administrativo` desta funcao foi criada para pegar.
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
  -- + 08/10/2026: titulos que a suspensao devolveu
  v_tit_qtd int := 0; v_tit_val numeric := 0;
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
    -- + 08/10/2026
    select count(*), coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                                           t.valor_em_aberto, t.valor_original, 0)),0)
      into v_tit_qtd, v_tit_val
      from public.acordos_titulos t
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) = 'DEVOLVIDO'
       and t.devolucao_origem = 'SUSPENSAO_COBRANCA';
    return jsonb_build_object('ok', true, 'dry_run', true, 'aluno_id', p_aluno_id,
      'parcelas_a_reativar_qtd', v_qtd, 'parcelas_a_reativar_valor', round(v_val,2),
      'titulos_a_voltar_para_confirmacao_qtd', v_tit_qtd,
      'titulos_a_voltar_para_confirmacao_valor', round(v_tit_val,2));
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

  -- + 08/10/2026: O TITULO VOLTA PARA A CONFERENCIA PRIME.
  -- A marca `conferencia_prime.decisao` e necessaria nas DUAS direcoes: o
  -- gatilho `_titulo_em_confirmacao_protegido` levanta excecao para quem tenta
  -- ENTRAR em EM_CONFIRMACAO sem ela ('so entra pela deteccao do grupo A').
  perform set_config('conferencia_prime.decisao', 'on', true);
  with r as (
    update public.acordos_titulos t
       set situacao = 'EM_CONFIRMACAO',
           status   = 'em_confirmacao',
           devolucao_origem = null,
           devolucao_ref    = null,
           devolucao_em     = null,
           devolucao_por    = null,
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'devolução desfeita em ' || to_char(now(),'DD/MM/YYYY HH24:MI')
             || ' por ' || coalesce(nullif(v_email,''),'gestão')
             || ': a suspensão de cobrança foi levantada, então o título volta a aguardar a '
             || 'Conferência Prime em vez de ficar devolvido. ' || btrim(p_motivo),
           atualizado_em = now()
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) = 'DEVOLVIDO'
       and t.devolucao_origem = 'SUSPENSAO_COBRANCA'
    returning t.id,
              coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                       t.valor_em_aberto, t.valor_original, 0) as valor)
  select count(*), coalesce(sum(valor),0) into v_tit_qtd, v_tit_val from r;
  perform set_config('conferencia_prime.decisao', 'off', true);

  -- A pendencia reabre: quem decide o destino do titulo e a Prime, nao esta
  -- funcao. `decidido_em` volta a nulo para a fila voltar a mostra-lo.
  if v_tit_qtd > 0 then
    update public.prime_conferencia_decisao d
       set decisao = 'PENDENTE',
           motivo = 'reaberta em ' || to_char(now(),'DD/MM/YYYY HH24:MI')
                    || ': suspensão de cobrança levantada por '
                    || coalesce(nullif(v_email,''),'gestão') || '. ' || btrim(p_motivo),
           decidido_por = null,
           decidido_em  = null
     where d.titulo_id in (select t.id from public.acordos_titulos t
                            where t.aluno_id = p_aluno_id
                              and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
       and d.decisao = 'DEVOLVIDO';

    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (coalesce(nullif(v_email,''), 'sistema'), 'TITULO_DEVOLUCAO_DESFEITA_POR_REATIVACAO',
            'alunos', p_aluno_id,
            jsonb_build_object('titulos_qtd', v_tit_qtd, 'titulos_valor', round(v_tit_val,2),
                               'origem', 'SUSPENSAO_COBRANCA', 'motivo', btrim(p_motivo)));
  end if;

  -- O aluno volta para a fila. `nao_acionar` sai, o status volta a neutro e o
  -- motor decide situacao, criticidade e retorno -- em vez de a funcao chutar.
  --
  -- `status_acionamento` recebe 'CONTATAR', NAO null. O gatilho
  -- `_acionamento_nao_volta_para_nulo` restaura o valor antigo quando alguem
  -- tenta anular esse campo ("acionamento e fato consumado"), e por isso a
  -- primeira versao desta funcao deixava 'SUSPENSAO_COBRANCA' gravado no aluno.
  -- Consequencia medida pelo teste: `aluno_bloqueio_administrativo` continuava
  -- devolvendo SUSPENSAO_COBRANCA, o saldo cobravel ficava em ZERO e a
  -- suspensao era, na pratica, IRREVERSIVEL. Valor real contorna o gatilho sem
  -- precisar desliga-lo.
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

  -- + 08/10/2026: nenhum titulo pode ficar devolvido pela suspensao que acabou
  -- de cair. Se ficar, a divida teria sumido -- e melhor abortar.
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
              then ' e ' || v_tit_qtd || ' título(s) voltaram a aguardar a Conferência Prime ('
                   || public.fmt_brl(round(v_tit_val,2)) || ').'
              else '.' end
      || ' Motivo: ' || btrim(p_motivo),
    coalesce(v_recalc->>'situacao','CONTATAR'),
    coalesce(v_nome, nullif(v_email,''), 'gestão'), coalesce(nullif(v_email,''),'sistema'), now(),
    round(v_val,2));

  return jsonb_build_object('ok', true, 'dry_run', false, 'aluno_id', p_aluno_id,
    'parcelas_reativadas_qtd', v_qtd, 'parcelas_reativadas_valor', round(v_val,2),
    'titulos_de_volta_em_confirmacao_qtd', v_tit_qtd,
    'titulos_de_volta_em_confirmacao_valor', round(v_tit_val,2),
    'situacao', v_recalc->>'situacao');
end;
$function$;

comment on function public.suspensao_cobranca_reativar(uuid, text, boolean) is
  'Levanta a suspensao de cobranca: reativa as parcelas SUSPENSA e traz de volta para EM_CONFIRMACAO os titulos que a suspensao havia devolvido, reabrindo a pendencia da Conferencia Prime como PENDENTE. Duas TRAVAS: aborta se o portao administrativo continuar bloqueando o aluno e se sobrar titulo DEVOLVIDO por SUSPENSAO_COBRANCA. Somente gestao.';

-- ---------------------------------------------------------------------------
-- 6. O RETROATIVO, SO DO DIA PEDIDO
-- ---------------------------------------------------------------------------
-- Pedido da gestao em 08/10/2026: "faca o retroativo SOMENTE dos casos tabulados
-- hoje [...] nao altere casos antigos de outros dias".
--
-- O ESCOPO E A AUDITORIA DO DESFECHO, nao `alunos.status_jornada`. A diferenca e
-- grande e foi medida em 08/10/2026:
--
--   * por auditoria do dia: 4 alunos, 12 titulos  <- o que esta funcao corrige
--   * por status_jornada, sem recorte de data: +38 alunos e +63 titulos de
--     29/06 a 29/09 (33 em SUSPENSAO_COBRANCA, 5 em CANCELAMENTO_COBRANCA)
--
-- Esses 38 foram tabulados antes de o desfecho existir e nao sao "casos que
-- ficaram em confirmacao por causa do bug": sao casos antigos, que a gestao
-- mandou nao tocar. `parcela_efeito_sem_pagamento_auditoria.executado_em` e a
-- unica fonte que separa os dois grupos por data real de execucao.
--
-- IDEMPOTENTE: titulo que ja saiu da confirmacao e ignorado pelo helper, entao
-- reexecutar nao devolve duas vezes nem aborta o lote.
create or replace function public.devolucao_retroativa_desfecho_do_dia(
  p_dia     date default (now() at time zone 'America/Sao_Paulo')::date,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_itens jsonb := '[]'::jsonb;
  v_qtd int := 0; v_val numeric := 0; v_alunos int := 0;
  r record;
begin
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Correcao retroativa do desfecho e decisao da gestao.' using errcode = '42501';
  end if;
  if p_dia is null then
    raise exception 'Informe o dia a corrigir.' using errcode = '22023';
  end if;

  for r in
    -- Um aluno pode ter mais de uma linha de auditoria no dia. Vale a ULTIMA:
    -- e a tabulacao que ficou valendo no aluno ao fim do dia.
    with ultima as (
      select distinct on (a.aluno_id)
             a.aluno_id, a.origem, a.motivo, a.executado_por, a.executado_em
        from public.parcela_efeito_sem_pagamento_auditoria a
        join public.tabulacoes tb
          on tb.codigo = a.origem and tb.ativa and tb.efeito_desfecho is not null
       where (a.executado_em at time zone 'America/Sao_Paulo')::date = p_dia
         and a.revertida_em is null
       order by a.aluno_id, a.executado_em desc
    )
    select u.aluno_id, u.origem, u.motivo, u.executado_por, u.executado_em,
           al.nome, t.id as titulo_id, t.documento,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                    t.valor_em_aberto, t.valor_original, 0) as valor
      from ultima u
      join public.alunos al on al.id = u.aluno_id
      join public.acordos_titulos t on t.aluno_id = u.aluno_id
     where upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
     order by u.origem, al.nome, t.id
  loop
    v_qtd := v_qtd + 1;
    v_val := v_val + coalesce(r.valor,0);
    v_itens := v_itens || jsonb_build_object(
      'aluno_id', r.aluno_id, 'aluno', r.nome, 'titulo_id', r.titulo_id,
      'documento', r.documento, 'valor', round(coalesce(r.valor,0),2),
      'origem', r.origem, 'tabulado_por', r.executado_por,
      'tabulado_em', to_char(r.executado_em at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'));

    if not p_dry_run then
      -- Motivo, usuario e data da tabulacao original seguem na devolucao: sem
      -- isso a correcao apagaria quem decidiu o encerramento do caso.
      perform public.titulo_devolver_da_confirmacao(
        r.titulo_id,
        r.origem,
        'correcao retroativa de ' || to_char(p_dia,'DD/MM/YYYY')
          || ': a tabulacao "' || r.origem || '" finalizou o caso em '
          || to_char(r.executado_em at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')
          || ' e este titulo ficou preso em confirmacao. Motivo original: '
          || coalesce(nullif(btrim(coalesce(r.motivo,'')),''), '(sem motivo registrado)'),
        r.executado_por);
    end if;
  end loop;

  select count(distinct (i->>'aluno_id')) into v_alunos
    from jsonb_array_elements(v_itens) i;

  return jsonb_build_object(
    'ok', true, 'dry_run', p_dry_run, 'dia', p_dia,
    'alunos', coalesce(v_alunos,0),
    'titulos', v_qtd, 'valor', round(v_val,2),
    'itens', v_itens);
end;
$function$;

comment on function public.devolucao_retroativa_desfecho_do_dia(date, boolean) is
  'Corrige os titulos que ficaram em EM_CONFIRMACAO nos casos finalizados por tabulacao de desfecho NO DIA informado, devolvendo-os pelo mesmo caminho do motor (titulo_devolver_da_confirmacao). Escopo vem de parcela_efeito_sem_pagamento_auditoria.executado_em, nunca de alunos.status_jornada -- casos de outros dias ficam fora. p_dry_run = true (padrao) nao escreve nada e devolve a lista do que seria corrigido.';

revoke all on function public.devolucao_retroativa_desfecho_do_dia(date, boolean) from public, anon;
grant execute on function public.devolucao_retroativa_desfecho_do_dia(date, boolean) to authenticated, service_role;
