-- ENCERRAR PENDENCIA DE CONCILIACAO -- A SAIDA OPERACIONAL DA FILA
-- 17/09/2026.
--
-- O PROBLEMA (leitura de 17/09/2026). A fila tem 55 linhas e so 10 tem acao na
-- tela. Faltam duas saidas:
--   1. PARCELA_JA_PAGA com o dinheiro JA refletido: a parcela do boleto esta
--      PAGO, existe UM unico pagamento desse boleto e o acordo fecha pagamento
--      a pagamento. So a referencia da baixa antiga (por sufixo) ficou
--      deslocada. Sao 8 casos, R$ 5.359,20.
--   2. Linha sem nenhuma acao tecnica segura: a gestao nao tem como encerrar.
--
-- O QUE ESTA MIGRATION FAZ
--   conciliacao_ja_paga_previa .............. SQL puro e STABLE: prova as 8
--                                              evidencias. Nao escreve nada.
--   conciliacao_ja_paga_encerrar ............ fecha SO a linha da fila.
--   conciliacao_ja_paga_encerrar_pendentes .. percorre os pendentes elegiveis.
--   fluxo_pagamentos_rodar .................. etapa nova, depois da reconstrucao.
--   conciliacao_encerrar .................... a gestao passa a encerrar
--                                              qualquer pendencia aberta, com o
--                                              estado anterior em auditoria.
--   pagamentos_sem_aluno .................... a fila ativa deixa de mostrar
--                                              linha que ja tem decisao.
--   fluxo_pagamentos_config ................. etapa `encerrar_ja_paga_conferida`,
--                                              DESLIGADA ao entrar.
--
-- NADA AQUI TOCA DINHEIRO. Nenhuma das funcoes escreve em parcelas, acordos,
-- pagamentos, acordos_titulos ou baixas_pagamento: so a decisao em
-- fila_pagamento_sem_vinculo e o registro em auditoria. O motor de baixa
-- (pagamento_conciliar_um) nao e alterado, e a reconstrucao da parcela paga
-- antes da extracao tambem nao.
--
-- COMO A LINHA SAI DA FILA: `decisao` deixa de ser nula. A tela le
-- pagamentos_sem_aluno (que passa a excluir quem tem decisao), o reprocessador
-- (conciliacao_reprocessar), a reconstrucao e o motor ja ignoram quem tem
-- decisao -- e o motor so reabre linha com `decisao is null`. O registro nao e
-- apagado: fica com decisao, quem decidiu e quando.
--
-- EVIDENCIAS DO ENCERRAMENTO AUTOMATICO -- todas, ou a pendencia fica aberta:
--    1 pendencia aberta em PARCELA_JA_PAGA, sem estorno e sem retroativo;
--    2 boleto no padrao 5 + acordo(6) + parcela(4);
--    3 existe uma parcela com esse boleto e ela esta PAGO;
--    4 existe UM unico pagamento nao estornado com esse boleto;
--    5 o valor pago esta na faixa que o motor aceita para essa parcela;
--    6 o acordo fecha pagamento a pagamento: toda parcela paga tem boleto e um
--      pagamento do proprio boleto, todo pagamento do acordo tem parcela paga
--      do proprio boleto, e as contagens sao iguais;
--    7 a baixa registrada na parcela e antiga e deslocada (sem referencia, ou
--      referencia de pagamento de OUTRO boleto);
--    8 nenhuma baixa devolvida na parcela.
-- Rollback: supabase/rollbacks/20260917210000_encerrar_pendencia_de_conciliacao.rollback.sql

-- ---------------------------------------------------------------------------
-- 1. A PREVIA DO ENCERRAMENTO AUTOMATICO -- SEM ESCRITA
-- ---------------------------------------------------------------------------
create or replace function public.conciliacao_ja_paga_previa(p_pagamento_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $fn$
with
pag as (
  select p.id, p.numero_parcela_completo, p.valor_pago, p.data_pagamento, p.status_conciliacao,
         coalesce(p.retroativo, false) as retroativo,
         coalesce(p.dados, '{}'::jsonb) ? 'estornado_em' as estornado,
         ltrim(coalesce(p.numero_parcela_completo, ''), '0') as boleto
    from public.pagamentos p
   where p.id = p_pagamento_id
),
b as (
  select pag.*,
         pag.boleto ~ '^5\d{10}$' as no_padrao,
         case when pag.boleto ~ '^5\d{10}$' then substr(pag.boleto, 1, 7) end as prefixo
    from pag
),
parc as (
  select q.id, q.acordo_id, q.numero, q.boleto, q.valor, q.vencimento,
         upper(coalesce(q.status, '')) as status, q.origem_baixa, q.origem_baixa_ref,
         q.pago_em, q.confirmado_por_email
    from public.parcelas q, b
   where q.boleto = b.boleto
),
ac as (
  select a.id, a.numero_ulbra, a.status, a.qtd_parcelas, a.valor_total
    from public.acordos a join parc on parc.acordo_id = a.id
),
-- O ACORDO INTEIRO, PAGAMENTO A PAGAMENTO. E o que separa "a baixa antiga caiu
-- na parcela certa por outro caminho" de "falta dinheiro" ou "sobra baixa".
pagas as (
  select q.id, q.boleto, q.valor,
         (select count(*) from public.pagamentos g
           where ltrim(coalesce(g.numero_parcela_completo, ''), '0') = q.boleto
             and not (coalesce(g.dados, '{}'::jsonb) ? 'estornado_em')) as pagamentos_do_boleto
    from public.parcelas q join ac on ac.id = q.acordo_id
   where upper(coalesce(q.status, '')) = 'PAGO'
),
pagamentos_do_acordo as (
  select g.id, ltrim(coalesce(g.numero_parcela_completo, ''), '0') as boleto, g.valor_pago
    from public.pagamentos g, b
   where b.prefixo is not null
     and ltrim(coalesce(g.numero_parcela_completo, ''), '0') like b.prefixo || '%'
     and not (coalesce(g.dados, '{}'::jsonb) ? 'estornado_em')
),
ctx as (
  select
    (select count(*) from parc) as parcelas_com_o_boleto,
    (select count(*) from parc where parc.status = 'PAGO') as parcela_paga,
    (select count(*) from public.pagamentos g, b
      where ltrim(coalesce(g.numero_parcela_completo, ''), '0') = b.boleto
        and not (coalesce(g.dados, '{}'::jsonb) ? 'estornado_em')) as pagamentos_do_boleto,
    (select count(*) from pagas) as parcelas_pagas_no_acordo,
    (select count(*) from pagas where pagas.boleto is null) as pagas_sem_boleto,
    (select count(*) from pagas where pagas.pagamentos_do_boleto <> 1) as pagas_sem_pagamento_proprio,
    (select count(*) from pagamentos_do_acordo) as pagamentos_no_acordo,
    (select count(*) from pagamentos_do_acordo pp
      where not exists (select 1 from pagas where pagas.boleto = pp.boleto)) as pagamentos_sem_parcela_paga,
    (select count(*) from public.baixas_pagamento bx, parc
      where bx.parcela_id = parc.id and bx.devolvido_em is not null) as baixas_devolvidas,
    (select count(*) from public.fila_pagamento_sem_vinculo f, b
      where f.pagamento_id = b.id and f.decisao is null) as fila_aberta,
    (select count(*) from public.fila_pagamento_sem_vinculo f, b
      where f.pagamento_id = b.id and f.decisao is not null) as fila_decidida
),
v as (
  select x.ordem, x.codigo, coalesce(x.ok, false) as ok, x.detalhe
    from (values
      (1, 'PENDENCIA_ABERTA_JA_PAGA',
          (select b.status_conciliacao = 'PARCELA_JA_PAGA' and not b.estornado and not b.retroativo from b)
          and (select ctx.fila_aberta = 1 and ctx.fila_decidida = 0 from ctx),
          'estado: ' || coalesce((select b.status_conciliacao from b), '(pagamento nao encontrado ou sem estado)')
          || ' - linhas abertas na fila: ' || (select ctx.fila_aberta::text from ctx)),
      (2, 'BOLETO_NO_PADRAO',
          (select b.no_padrao from b),
          'boleto ' || coalesce((select b.numero_parcela_completo from b), '(sem)')),
      (3, 'PARCELA_DO_BOLETO_PAGA',
          (select ctx.parcelas_com_o_boleto = 1 and ctx.parcela_paga = 1 from ctx),
          'parcelas com o boleto: ' || (select ctx.parcelas_com_o_boleto::text from ctx)
          || ' - em PAGO: ' || (select ctx.parcela_paga::text from ctx)),
      (4, 'UNICO_PAGAMENTO_DO_BOLETO',
          (select ctx.pagamentos_do_boleto = 1 from ctx),
          'pagamentos nao estornados com este boleto: ' || (select ctx.pagamentos_do_boleto::text from ctx)),
      (5, 'VALOR_REFLETIDO_NA_PARCELA',
          (select b.valor_pago >= parc.valor - 0.05 and b.valor_pago <= parc.valor * 1.15 from b, parc),
          'pago ' || coalesce((select b.valor_pago::text from b), '?')
          || ' - parcela ' || coalesce((select parc.valor::text from parc), '?')
          || ' (a faixa que o motor aceita na baixa)'),
      (6, 'ACORDO_FECHA_PAGAMENTO_A_PAGAMENTO',
          (select ctx.parcelas_pagas_no_acordo >= 1 and ctx.pagas_sem_boleto = 0
                  and ctx.pagas_sem_pagamento_proprio = 0 and ctx.pagamentos_sem_parcela_paga = 0
                  and ctx.parcelas_pagas_no_acordo = ctx.pagamentos_no_acordo from ctx),
          (select ctx.parcelas_pagas_no_acordo || ' parcela(s) paga(s) e ' || ctx.pagamentos_no_acordo
                  || ' pagamento(s) - paga sem boleto: ' || ctx.pagas_sem_boleto
                  || ' - paga sem pagamento proprio: ' || ctx.pagas_sem_pagamento_proprio
                  || ' - pagamento sem parcela paga: ' || ctx.pagamentos_sem_parcela_paga from ctx)),
      (7, 'REFERENCIA_ANTIGA_DESLOCADA',
          (select parc.origem_baixa_ref is distinct from p_pagamento_id::text
                  and (parc.origem_baixa_ref is null
                       or not exists (select 1 from public.pagamentos g, b
                                       where g.id::text = parc.origem_baixa_ref
                                         and ltrim(coalesce(g.numero_parcela_completo, ''), '0') = b.boleto))
             from parc),
          'referencia da baixa na parcela: ' || coalesce((select parc.origem_baixa_ref from parc), '(sem registro)')),
      (8, 'SEM_BAIXA_DEVOLVIDA',
          (select ctx.baixas_devolvidas = 0 from ctx),
          'baixas devolvidas na parcela: ' || (select ctx.baixas_devolvidas::text from ctx))
    ) as x(ordem, codigo, ok, detalhe)
)
select jsonb_build_object(
  'origem', 'PARCELA_JA_PAGA_CONFERIDA',
  'aprovado', (select bool_and(v.ok) from v),
  'bloqueios', coalesce((select jsonb_agg(v.codigo order by v.ordem) from v where not v.ok), '[]'::jsonb),
  'validacoes', (select jsonb_agg(jsonb_build_object('codigo', v.codigo, 'ok', v.ok, 'detalhe', v.detalhe) order by v.ordem) from v),
  'pagamento', (select jsonb_build_object('id', b.id, 'boleto', b.boleto, 'valor_pago', b.valor_pago,
                 'data_pagamento', b.data_pagamento, 'status_conciliacao', b.status_conciliacao) from b),
  'parcela', (select jsonb_build_object('id', parc.id, 'numero', parc.numero, 'boleto', parc.boleto, 'valor', parc.valor,
                'vencimento', parc.vencimento, 'status', parc.status, 'pago_em', parc.pago_em,
                'confirmado_por_email', parc.confirmado_por_email, 'origem_baixa', parc.origem_baixa,
                'origem_baixa_ref', parc.origem_baixa_ref) from parc),
  'acordo', (select jsonb_build_object('id', ac.id, 'numero_ulbra', ac.numero_ulbra, 'status', ac.status,
               'qtd_parcelas', ac.qtd_parcelas, 'valor_total', ac.valor_total) from ac),
  'evidencia', (select to_jsonb(ctx) from ctx)
);
$fn$;

comment on function public.conciliacao_ja_paga_previa(uuid) is
  'Previa do encerramento automatico de PARCELA_JA_PAGA (PARCELA_JA_PAGA_CONFERIDA). SQL puro, sem DML: prova que o dinheiro ja esta refletido -- parcela do boleto em PAGO, um unico pagamento desse boleto e o acordo fechando pagamento a pagamento. A porta e conciliacao_ja_paga_encerrar.';

-- ---------------------------------------------------------------------------
-- 2. O ENCERRAMENTO AUTOMATICO -- SO A DECISAO DA FILA
-- ---------------------------------------------------------------------------
create or replace function public.conciliacao_ja_paga_encerrar(p_pagamento_id uuid, p_confirmar boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $fn$
declare
  v_previa jsonb;
  v_n int;
  v_depois jsonb;
begin
  v_previa := public.conciliacao_ja_paga_previa(p_pagamento_id);

  if not coalesce(p_confirmar, false) then
    return v_previa || jsonb_build_object('ok', true, 'modo', 'SIMULACAO', 'gravou', false);
  end if;
  if not coalesce((v_previa ->> 'aprovado')::boolean, false) then
    return v_previa || jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false);
  end if;

  -- duas rodadas ao mesmo tempo: a segunda espera e, ao reler, e recusada
  perform pg_advisory_xact_lock(hashtextextended('conciliacao_ja_paga:' || p_pagamento_id::text, 0));
  v_previa := public.conciliacao_ja_paga_previa(p_pagamento_id);
  if not coalesce((v_previa ->> 'aprovado')::boolean, false) then
    return v_previa || jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false);
  end if;

  -- A UNICA ESCRITA: a decisao da fila. A parcela, o acordo, o pagamento e o
  -- saldo ficam exatamente como estao -- o dinheiro ja esta refletido.
  update public.fila_pagamento_sem_vinculo
     set decisao = 'RESOLVIDO_AUTOMATICO',
         decidido_por = 'conciliacao@sistema',
         decidido_em = now(),
         observacao = coalesce(observacao, '')
           || case when coalesce(observacao, '') = '' then '' else ' | ' end
           || 'parcela ja paga conferida: um unico pagamento deste boleto, a parcela em PAGO e o acordo fechando'
           || ' pagamento a pagamento; so a referencia da baixa antiga estava deslocada. Sem baixa nova.'
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'JA_PAGA_ABORTADO: a linha da fila mudou entre a previa e a gravacao (% linhas)', v_n;
  end if;

  select jsonb_build_object(
           'fila', jsonb_build_object('decisao', f.decisao, 'decidido_por', f.decidido_por, 'decidido_em', f.decidido_em),
           'pagamento_status', (select p.status_conciliacao from public.pagamentos p where p.id = p_pagamento_id))
    into v_depois
    from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('conciliacao@sistema', 'CONCILIACAO_JA_PAGA_CONFERIDA', 'fila_pagamento_sem_vinculo', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'antes', v_previa, 'depois', v_depois,
                             'sem_efeito_financeiro', true));

  return v_previa || jsonb_build_object('ok', true, 'modo', 'CONFIRMADO', 'gravou', true, 'estado_depois', v_depois);
end;
$fn$;

comment on function public.conciliacao_ja_paga_encerrar(uuid, boolean) is
  'Encerra a pendencia de um PARCELA_JA_PAGA cujo dinheiro ja esta refletido. p_confirmar=false devolve a previa. Confirmado, grava SO a decisao da fila (RESOLVIDO_AUTOMATICO) e a auditoria: nao baixa parcela, nao altera acordo, saldo nem mensalidade.';

-- ---------------------------------------------------------------------------
-- 3. OS PENDENTES ELEGIVEIS
-- ---------------------------------------------------------------------------
create or replace function public.conciliacao_ja_paga_encerrar_pendentes(p_limite integer default 50)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_id uuid;
  v_r jsonb;
  v_cod text;
  v_n int := 0;
  v_ok int := 0;
  v_err int := 0;
  v_bloq jsonb := '{}'::jsonb;
  v_itens jsonb := '[]'::jsonb;
begin
  for v_id in
    select g.id
      from public.pagamentos g
     where g.status_conciliacao = 'PARCELA_JA_PAGA'
       and exists (select 1 from public.fila_pagamento_sem_vinculo f
                    where f.pagamento_id = g.id and f.decisao is null)
     order by g.data_pagamento desc, g.id
     limit greatest(coalesce(p_limite, 50), 0)
  loop
    v_n := v_n + 1;
    begin
      v_r := public.conciliacao_ja_paga_encerrar(v_id, true);
      if coalesce((v_r ->> 'gravou')::boolean, false) then
        v_ok := v_ok + 1;
      else
        for v_cod in select jsonb_array_elements_text(coalesce(v_r -> 'bloqueios', '[]'::jsonb)) loop
          v_bloq := jsonb_set(v_bloq, array[v_cod], to_jsonb(coalesce((v_bloq ->> v_cod)::int, 0) + 1), true);
        end loop;
      end if;
      v_itens := v_itens || jsonb_build_array(jsonb_build_object(
        'pagamento_id', v_id, 'boleto', v_r -> 'pagamento' ->> 'boleto',
        'encerrada', coalesce((v_r ->> 'gravou')::boolean, false), 'bloqueios', v_r -> 'bloqueios'));
    exception when others then
      -- um pagamento nao derruba os outros
      v_err := v_err + 1;
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('conciliacao@sistema', 'CONCILIACAO_JA_PAGA_FALHOU', 'fila_pagamento_sem_vinculo', v_id,
              jsonb_build_object('erro', SQLERRM));
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('pagamento_id', v_id, 'erro', SQLERRM));
    end;
  end loop;

  return jsonb_build_object('avaliados', v_n, 'encerradas', v_ok, 'erros', v_err,
                            'recusados_por_motivo', v_bloq, 'itens', v_itens);
end;
$fn$;

revoke all on function public.conciliacao_ja_paga_previa(uuid) from public, anon, authenticated;
revoke all on function public.conciliacao_ja_paga_encerrar(uuid, boolean) from public, anon, authenticated;
revoke all on function public.conciliacao_ja_paga_encerrar_pendentes(integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. fluxo_pagamentos_rodar: etapa nova depois da reconstrucao
-- ---------------------------------------------------------------------------
create or replace function public.fluxo_pagamentos_rodar(p_origem text default 'cron'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_antes numeric; v_depois numeric; v_res jsonb := '{}'::jsonb;
  v_liga boolean; v_carga jsonb; v_erro text;
begin
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
    values (p_origem, jsonb_build_object('pulou','sistema sob carga'));
    return jsonb_build_object('pulou','sistema sob carga');
  end if;

  perform set_config('reativa.fluxo_pagamentos','on', true);
  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  begin
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='amarrar_boleto';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('amarrar_boleto', public.parcelas_amarrar_boleto());
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='pos_importacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('pos_importacao', public.acordos_pos_importacao(null, true));
    end if;

    -- le o numero no pagamento, grava na parcela e baixa
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_pelo_relatorio';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa_pelo_relatorio', public.baixa_pelo_relatorio_pagamento(true, (current_date - 180)));
    end if;

    -- parcela paga antes da extracao, em acordo que ja entrou (17/09/2026)
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='reconstruir_parcela_paga_antes';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('reconstruir_parcela_paga_antes', public.parcela_paga_antes_reconstruir_pendentes(50));
    end if;

    -- parcela ja paga com o dinheiro refletido: so fecha a pendencia (17/09/2026)
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='encerrar_ja_paga_conferida';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('encerrar_ja_paga_conferida', public.conciliacao_ja_paga_encerrar_pendentes(50));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_por_documento';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa', public.baixa_por_documento_aplicar('2026-07-01', true));
    else
      v_res := v_res || jsonb_build_object('baixa_previa', public.baixa_por_documento_aplicar('2026-07-01', false));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='sinalizar_duplicado';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('duplicados', public.acordos_sinalizar_boleto_repetido());
    end if;

    -- O acordo diz de onde veio. Por ultimo: nao altera as etapas acima.
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='vinculo_por_negociacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('vinculo_por_negociacao', public.prime_vincular_por_negociacao(true, 3));
    end if;
  exception when others then
    v_erro := SQLERRM;
  end;

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;
  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values (p_origem, v_antes, v_depois, v_res, v_erro);

  return jsonb_build_object('carteira_antes',v_antes,'carteira_depois',v_depois,
    'variacao', round(v_depois-v_antes,2), 'etapas', v_res, 'erro', v_erro);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. conciliacao_encerrar: a gestao encerra qualquer pendencia aberta
-- ---------------------------------------------------------------------------
create or replace function public.conciliacao_encerrar(
  p_pagamento_id uuid, p_observacao text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_email text; v_n int := 0; v_st text; v_antes jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encerrar pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO');
  end if;
  if v_st = 'BAIXADO' then
    return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO');
  end if;

  -- QUALQUER PENDENCIA ABERTA (17/09/2026). Antes so PARCELA_JA_PAGA podia ser
  -- encerrada, porque uma `decisao` faz o reprocessador parar de olhar aquele
  -- pagamento. Isso continua verdade -- e agora e o ponto: a gestao decide
  -- quando a linha nao tem mais saida automatica. O preco esta dito no retorno
  -- e na auditoria: o estado anterior fica registrado e nada financeiro muda.
  select jsonb_build_object(
           'status_conciliacao', v_st,
           'conciliacao_motivo', (select p.conciliacao_motivo from public.pagamentos p where p.id = p_pagamento_id),
           'fila', (select jsonb_build_object('motivo', f.motivo, 'status_conciliacao', f.status_conciliacao,
                      'detectado_em', f.detectado_em, 'observacao', f.observacao, 'decisao', f.decisao)
                      from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id))
    into v_antes;

  if not exists (select 1 from public.fila_pagamento_sem_vinculo f
                  where f.pagamento_id = p_pagamento_id and f.decisao is null) then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PENDENCIA_ABERTA',
      'status_conciliacao', v_st, 'estado_anterior', v_antes);
  end if;

  -- A UNICA ESCRITA E A DECISAO DA FILA. Encerrar nao baixa parcela, nao mexe
  -- em acordo, saldo, mensalidade nem cria vinculo financeiro.
  update public.fila_pagamento_sem_vinculo
     set decisao = 'ENCERRADO_GESTAO',
         decidido_por = v_email,
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'encerrado pela gestao'
           || case when p_observacao is null then '' else ': ' || p_observacao end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'ENCERRAMENTO_ABORTADO: a linha da fila mudou durante o encerramento (% linhas)', v_n;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CONCILIACAO_ENCERRADA_PELA_GESTAO', 'fila_pagamento_sem_vinculo', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'estado_anterior', v_antes,
                             'observacao', p_observacao, 'decisao', 'ENCERRADO_GESTAO',
                             'sem_efeito_financeiro', true));

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n,
                            'decisao', 'ENCERRADO_GESTAO', 'estado_anterior', v_antes);
end;
$fn$;

comment on function public.conciliacao_encerrar(uuid, text) is
  'Encerramento da pendencia de conciliacao pela gestao, em qualquer estado aberto que nao seja BAIXADO. Grava SO a decisao ENCERRADO_GESTAO na fila e a auditoria com o estado anterior: nao baixa parcela, nao altera acordo, saldo, mensalidade nem cria vinculo financeiro. A linha sai da fila ativa e deixa de ser reprocessada.';

-- ---------------------------------------------------------------------------
-- 6. pagamentos_sem_aluno: a fila ativa nao mostra o que ja foi decidido
-- ---------------------------------------------------------------------------
create or replace function public.pagamentos_sem_aluno(
  p_mes text default null,
  p_todos_os_meses boolean default false
)
returns table (
  pagamento_id uuid,
  data_pagamento date,
  aluno_nome text,
  matricula text,
  titulo_numero text,
  numero_parcela_completo text,
  valor_pago numeric,
  valor_honorario numeric,
  operador_nome text,
  operador_email text,
  motivo text,
  candidatos integer,
  motivo_financeiro text,
  sugestoes jsonb,
  detectado_em timestamptz,
  importacao_id uuid,
  arquivo_nome text,
  status_conciliacao text,
  tem_aluno boolean
)
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  return query
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  )
  select
    p.id, p.data_pagamento, p.aluno_nome, p.matricula,
    p.titulo_numero, p.numero_parcela_completo,
    p.valor_pago, p.valor_honorario,
    p.operador_nome, p.operador_email,
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    -- Preferir o motivo da conciliacao, que e o novo e o mais especifico;
    -- cair para o motivo da fila; e so entao dizer que a linha e anterior.
    coalesce(p.conciliacao_motivo, f.motivo,
             'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em,
    p.importacao_id,
    i.arquivo_nome,
    p.status_conciliacao,
    (p.aluno_id is not null)
  from public.pagamentos p
  cross join mes
  left join lateral (
    select count(*)::int as qtd from public.alunos a
     where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))
       and coalesce(trim(p.aluno_nome),'') <> ''
  ) c on true
  left join public.fila_pagamento_sem_vinculo f
    on f.pagamento_id = p.id and f.decisao is null
  left join public.importacoes i on i.id = p.importacao_id
  where (p.aluno_id is null or f.pagamento_id is not null)
    -- ENCERRADA SAI DA FILA ATIVA (17/09/2026). Sem isto, a linha decidida
    -- volta a aparecer pelo `p.aluno_id is null` -- e encerrar nao resolveria
    -- nada para quem olha a tela.
    and not exists (select 1 from public.fila_pagamento_sem_vinculo fd
                     where fd.pagamento_id = p.id and fd.decisao is not null)
    and (coalesce(p_todos_os_meses, false)
         or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  order by p.data_pagamento desc, p.valor_pago desc;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. A ETAPA NASCE DESLIGADA
-- ---------------------------------------------------------------------------
insert into public.fluxo_pagamentos_config (etapa, ligado, observacao, alterado_em, alterado_por)
values ('encerrar_ja_paga_conferida', false,
        'DESLIGADA ao entrar (17/09/2026). Encerra a pendencia de PARCELA_JA_PAGA quando as 8 evidencias provam que o dinheiro ja esta refletido: nao baixa nada, so fecha a linha da fila com auditoria. Ligar so por decisao da gestao.',
        now(), 'migration_20260917210000')
on conflict (etapa) do nothing;

-- ---------------------------------------------------------------------------
-- PROVA. Qualquer divergencia aborta a migration inteira.
-- ---------------------------------------------------------------------------
do $prova$
declare
  v_src text;
  v_nome text;
begin
  -- o motor de baixa e a reconstrucao nao foram tocados
  if md5((select prosrc from pg_proc where oid = 'public.pagamento_conciliar_um(uuid,boolean)'::regprocedure)) <> 'fa3d64add73e0e73e587e16f0c0624d1' then
    raise exception 'PROVA: o motor de baixa nao e o de producao de 17/09/2026';
  end if;
  if md5((select prosrc from pg_proc where oid = 'public.parcela_paga_antes_reconstruir(uuid,boolean)'::regprocedure)) <> '0bd85569a834454244abb5ea97f068a2' then
    raise exception 'PROVA: a reconstrucao da parcela paga antes da extracao mudou';
  end if;

  -- NENHUMA ESCRITA FINANCEIRA nas funcoes desta migration
  for v_nome in select unnest(array['public.conciliacao_ja_paga_previa(uuid)',
                                    'public.conciliacao_ja_paga_encerrar(uuid,boolean)',
                                    'public.conciliacao_ja_paga_encerrar_pendentes(integer)',
                                    'public.conciliacao_encerrar(uuid,text)']) loop
    select prosrc into v_src from pg_proc where oid = v_nome::regprocedure;
    if v_src ~* '(insert\s+into|update|delete\s+from)\s+public\.(parcelas|acordos|pagamentos|acordos_titulos|baixas_pagamento|acordo_titulo_vinculo)\M' then
      raise exception 'PROVA: % escreve em tabela financeira', v_nome;
    end if;
  end loop;

  -- a previa e SQL puro, STABLE e sem DML
  if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang
       where p.oid = 'public.conciliacao_ja_paga_previa(uuid)'::regprocedure) <> 'sql'
     or (select provolatile from pg_proc where oid = 'public.conciliacao_ja_paga_previa(uuid)'::regprocedure) <> 's' then
    raise exception 'PROVA: conciliacao_ja_paga_previa deixou de ser SQL puro e STABLE';
  end if;

  -- o encerramento automatico nao e porta de entrada; o manual continua sendo
  if has_function_privilege('authenticated', 'public.conciliacao_ja_paga_previa(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.conciliacao_ja_paga_encerrar(uuid,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.conciliacao_ja_paga_encerrar_pendentes(integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.conciliacao_encerrar(uuid,text)', 'EXECUTE') then
    raise exception 'PROVA: permissao errada nas funcoes de encerramento';
  end if;
  if not has_function_privilege('authenticated', 'public.conciliacao_encerrar(uuid,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.pagamentos_sem_aluno(text,boolean)', 'EXECUTE') then
    raise exception 'PROVA: a gestao perdeu o acesso a fila ou ao encerramento';
  end if;

  -- encerrar exige o portao da gestao antes de qualquer escrita
  select prosrc into v_src from pg_proc where oid = 'public.conciliacao_encerrar(uuid,text)'::regprocedure;
  if position('usuario_e_gestao' in v_src) = 0
     or position('usuario_e_gestao' in v_src) > position('update public.fila_pagamento_sem_vinculo' in v_src) then
    raise exception 'PROVA: conciliacao_encerrar perdeu o portao da gestao';
  end if;
  if position('ENCERRADO_GESTAO' in v_src) = 0 or position('estado_anterior' in v_src) = 0 then
    raise exception 'PROVA: conciliacao_encerrar nao registra a decisao ou o estado anterior';
  end if;

  -- a fila ativa ignora quem ja tem decisao
  select prosrc into v_src from pg_proc where oid = 'public.pagamentos_sem_aluno(text,boolean)'::regprocedure;
  if v_src not like '%fd.decisao is not null%' then
    raise exception 'PROVA: pagamentos_sem_aluno ainda mostra linha decidida';
  end if;

  -- a etapa nova roda depois da reconstrucao, e nasce desligada
  select prosrc into v_src from pg_proc where oid = 'public.fluxo_pagamentos_rodar(text)'::regprocedure;
  if position('conciliacao_ja_paga_encerrar_pendentes' in v_src) < position('parcela_paga_antes_reconstruir_pendentes' in v_src) then
    raise exception 'PROVA: a etapa nova roda antes da reconstrucao';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'encerrar_ja_paga_conferida') is distinct from false then
    raise exception 'PROVA: etapa encerrar_ja_paga_conferida ausente ou ligada';
  end if;
end;
$prova$;
