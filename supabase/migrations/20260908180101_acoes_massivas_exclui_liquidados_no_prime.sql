-- Acoes Massivas: quem ja consta liquidado no Prime nao entra -- nem aparece.
--
-- Amanda, 08/09/2026: "os casos quitados ou zerados estao entrando nas acoes",
-- "apenas casos que consta debitos", "nem deve aparecer".
--
-- O QUE ACONTECIA. A previa so olha o CRM. Um aluno que pagou no Prime segue
-- com o titulo ABERTO aqui ate alguem dar a baixa, e a fila de conferencia
-- Prime e manual. Medido em 08/09: dos 5.482 elegiveis da previa, 112 tinham
-- TODOS os titulos vivos ja liquidados no extrato do Prime -- entre eles um de
-- R$ 58,6 mil e um de R$ 48,9 mil, liquidados em agosto. Provas independentes
-- nos 112: 100 com valor pago >= 95% do nominal, 64 com solicitacao de
-- confirmacao ja concluida no CRM, 27 com pagamento no extrato bancario.
--
-- A REGRA de "liquidado de verdade" e a mesma validada em 04/09 (1.747
-- pagamentos reais, 0 erros; ver migration 20260904120000, revisao_prime): o
-- Prime devolve paymentDate ate em titulo aberto, entao so conta liquidacao
-- com data DEPOIS do vencimento + 30 dias e DEPOIS da importacao do titulo.
--
-- TRES TRAVAS a mais, vindas dos 11 casos duvidosos entre os 112:
--   * valor pago tem de ser positivo (5 vinham NEGATIVOS = estorno, 1 vinha 0);
--   * aluno com acordo CANCELADO nao sai: o cancelamento devolve a divida e o
--     Prime nao reverte (ver memoria prime-baixa-automatica-proibida);
--   * o Prime tem de ter recebido ao menos metade do nominal, salvo se o CRM
--     tem acordo QUITADO do aluno (negociacao com desconto e liquidacao real).
-- Com as travas, 566 alunos na base inteira; ~100 dos 112 da previa.
--
-- NAO E BAIXA. Nada muda no titulo, no caso ou no aluno: a pessoa so deixa de
-- receber cobranca em massa. A baixa no CRM continua manual, pela fila de
-- conferencia Prime. Limite conhecido: o extrato e coletado por rotina
-- (prime_extrato.coletado_em); quem pagou depois da ultima coleta ainda entra
-- ate a proxima. A previa passa a devolver `prime_extrato_em` para a tela dizer
-- de quando e o extrato.
--
-- Cirurgia na definicao viva das duas funcoes (mesmo motivo da migration
-- 20260908120000: producao tem a versao de 13 parametros da previa, que a
-- main nao registra). Falha alto se qualquer ancora nao aparecer exatamente
-- uma vez. CREATE OR REPLACE preserva os GRANTs.

-- 1) A regra, num lugar so. Devolve so ids: nada de PII.
create or replace function public.acoes_massivas_liquidados_prime(p_aluno_ids uuid[] default null)
returns table(aluno_id uuid, titulos integer, valor_crm numeric, pago_prime numeric, ultima_liquidacao date)
language sql
stable
set search_path to 'public'
as $$
  with vivos as (
    select t.id, t.aluno_id, t.cpf, t.vencimento, t.created_at::date as importado,
           regexp_replace(coalesce(t.documento,''), '\D', '', 'g') as boleto,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v
      from public.acordos_titulos t
     where (p_aluno_ids is null or t.aluno_id = any(p_aluno_ids))
       and upper(coalesce(t.situacao,'')) = 'ABERTO'
       and coalesce(lower(t.status),'') <> 'quitada'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and not exists (
         select 1 from public.acordo_titulo_vinculo vv
           join public.acordos ac on ac.id = vv.acordo_id
          where vv.titulo_id = t.id and coalesce(vv.ativo, true)
            and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA'))
  ),
  cls as (
    select v.aluno_id, v.v, e.liquidado_em, e.valor_pago,
           (e.liquidado_em is not null
            and e.liquidado_em > v.vencimento + 30
            and e.liquidado_em >= v.importado
            and coalesce(e.valor_pago, 0) > 0) as liquidado_real
      from vivos v
      left join lateral (
        select e.liquidado_em, e.valor_pago
          from public.prime_extrato e
         where e.boleto = v.boleto and e.cpf = v.cpf
         order by e.coletado_em desc limit 1) e on true
  )
  select cls.aluno_id, count(*)::int, sum(cls.v), sum(cls.valor_pago), max(cls.liquidado_em)
    from cls
   group by cls.aluno_id
  having bool_and(cls.liquidado_real)
     and not exists (select 1 from public.acordos ac
                      where ac.aluno_id = cls.aluno_id
                        and upper(coalesce(ac.status,'')) in ('CANCELADO','CANCELADA'))
     and (sum(cls.valor_pago) >= sum(cls.v) * 0.5
          or exists (select 1 from public.acordos ac
                      where ac.aluno_id = cls.aluno_id
                        and upper(coalesce(ac.status,'')) like 'QUITADO%'));
$$;

revoke all on function public.acoes_massivas_liquidados_prime(uuid[]) from public, anon, authenticated;
grant execute on function public.acoes_massivas_liquidados_prime(uuid[]) to service_role;

-- 2) Previa e registro: cirurgia na definicao viva.
do $migration$
declare
  v_def text;
  v_qtd int;
  procedure_troca text;
begin
  -- helper local: falha se a ancora nao aparecer exatamente uma vez
  create temp table if not exists _trocas (fn text, ancora text, nova text) on commit drop;
  delete from _trocas;

  insert into _trocas values
  ('acoes_massivas_previa',
$a$  WITH sol_conf AS MATERIALIZED (
    SELECT DISTINCT s.aluno_id FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),$a$,
$a$  WITH sol_conf AS MATERIALIZED (
    SELECT DISTINCT s.aluno_id FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  -- Quem ja consta liquidado no Prime nao entra, nem aparece (Amanda, 08/09).
  liq_prime AS MATERIALIZED (
    SELECT lp.aluno_id FROM public.acoes_massivas_liquidados_prime() lp
  ),$a$),
  ('acoes_massivas_previa',
$a$      AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)$a$,
$a$      AND NOT EXISTS (SELECT 1 FROM liq_prime lp WHERE lp.aluno_id = a.id)
      AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)$a$),
  ('acoes_massivas_previa',
$a$    'total_excluidos_confirmacao', (SELECT count(*) FROM masc WHERE motivo_conf IS NOT NULL),$a$,
$a$    'total_excluidos_confirmacao', (SELECT count(*) FROM masc WHERE motivo_conf IS NOT NULL),
    'prime_extrato_em', (SELECT max(e.coletado_em)::date FROM public.prime_extrato e),$a$),
  ('registrar_acao_massiva',
$a$  v_conf_ids text[];$a$,
$a$  v_conf_ids text[];
  v_liq_ids text[]; v_excluidos_liq int := 0;$a$),
  ('registrar_acao_massiva',
$a$  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
    IF v_id = ANY(v_conf_ids) THEN$a$,
$a$  -- Revalida contra o Prime na hora de gravar: quem ja consta liquidado la
  -- nao recebe cobranca em massa (Amanda, 08/09). Nada e gravado para ele.
  SELECT COALESCE(array_agg(lp.aluno_id::text), '{}') INTO v_liq_ids
    FROM public.acoes_massivas_liquidados_prime(COALESCE(p_aluno_ids, '{}'::text[])::uuid[]) lp;

  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
    IF v_id = ANY(v_liq_ids) THEN
      v_excluidos_liq := v_excluidos_liq + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Já consta liquidado no Prime');
      CONTINUE;
    END IF;
    IF v_id = ANY(v_conf_ids) THEN$a$),
  ('registrar_acao_massiva',
$a$    'excluidos_confirmacao', v_excluidos_conf,$a$,
$a$    'excluidos_confirmacao', v_excluidos_conf,
    'excluidos_liquidados_prime', v_excluidos_liq,$a$);

  for procedure_troca in select distinct fn from _trocas loop
    select count(*) into v_qtd from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = procedure_troca;
    if v_qtd <> 1 then
      raise exception '%: esperava exatamente 1 sobrecarga, achei %', procedure_troca, v_qtd;
    end if;
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = procedure_troca;

    if position('acoes_massivas_liquidados_prime' in v_def) > 0 then
      raise notice '% ja exclui liquidados no Prime; nada a fazer', procedure_troca;
      continue;
    end if;

    declare r record;
    begin
      for r in select ancora, nova from _trocas where fn = procedure_troca loop
        if (length(v_def) - length(replace(v_def, r.ancora, ''))) / length(r.ancora) <> 1 then
          raise exception '%: ancora nao encontrada exatamente uma vez: %', procedure_troca, left(r.ancora, 80);
        end if;
        v_def := replace(v_def, r.ancora, r.nova);
      end loop;
    end;
    execute v_def;
  end loop;
end $migration$;
