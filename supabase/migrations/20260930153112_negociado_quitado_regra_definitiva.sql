-- ============================================================================
-- REGRA DEFINITIVA: mensalidade negociada cuja obrigacao ja foi liquidada pelo
-- acordo passa a QUITADO. O vinculo, o acordo e o historico ficam.
-- ============================================================================
-- INERTE PARA O ESTOQUE HISTORICO: nao altera nenhuma linha de acordos_titulos.
--
-- CAUSA RAIZ (provada no audit_log, titulo 0006089c-282e-4f0a-b7a7-531c0cf9aa0e,
-- mesmo criado_em = mesma transacao):
--   id 181656  ABERTO -> PAGO       "quitada junto com o acordo 188..."  (o motor)
--   id 181684  PAGO   -> NEGOCIADO  (o UPDATE incondicional da rotina)
--
-- `prime_vincular_por_negociacao` insere o vinculo (o gatilho chama
-- titulo_reavaliar, que decide CERTO) e logo depois sobrescreve a decisao com
-- situacao='NEGOCIADO' fixo, sem olhar o status do acordo.
--
-- O patch e ANCORADO no corpo de producao: le pg_get_functiondef, troca APENAS
-- o trecho do SET e reexecuta. Nao retypa a funcao (ela tem regexp com \D, cujo
-- reescape pelo MCP e inseguro) e nao toca em mais nada.
-- ============================================================================

do $do$
declare
  v_def text;
  v_novo text;
  v_ancora text := 'set situacao=''NEGOCIADO'', status=''vinculada'', acordo_id = a.acordo_id,';
  v_vezes int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'prime_vincular_por_negociacao';

  if v_def is null then
    raise exception 'ABORTA: prime_vincular_por_negociacao nao existe em producao';
  end if;

  -- IDEMPOTENCIA pelo texto NOVO: se a ancora ja sumiu, nada a fazer.
  if position(v_ancora in v_def) = 0 then
    raise notice 'JA CORRIGIDA: a ancora nao existe mais no corpo';
    return;
  end if;

  -- A ancora tem de ser UNICA: patch ambiguo nao e patch.
  v_vezes := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_vezes <> 1 then
    raise exception 'ABORTA: ancora encontrada % vezes, esperado 1', v_vezes;
  end if;

  v_novo := replace(v_def, v_ancora, 'set');

  if position(v_ancora in v_novo) <> 0 then
    raise exception 'ABORTA: a ancora sobreviveu ao patch';
  end if;
  if length(v_def) - length(v_novo) <> length(v_ancora) - 3 then
    raise exception 'ABORTA: o patch mudou % chars, esperado %',
      length(v_def) - length(v_novo), length(v_ancora) - 3;
  end if;

  execute v_novo;
  raise notice 'CORRIGIDA: prime_vincular_por_negociacao (-% chars)', length(v_ancora) - 3;
end
$do$;

-- ---------------------------------------------------------------------------
-- O REGISTRO AUDITAVEL da reconciliacao (estado anterior e posterior por ID)
-- ---------------------------------------------------------------------------
create table if not exists public.mensalidade_reconciliacao_log (
  id              bigserial primary key,
  lote            text not null,
  titulo_id       uuid not null,
  aluno_id        uuid,
  acordo_id       uuid,
  numero_acordo   bigint,
  documento       text,
  valor_original  numeric,
  situacao_antes  text, status_antes  text,
  situacao_depois text, status_depois text,
  motivo          text,
  executado_por   text,
  executado_em    timestamptz not null default now()
);

create index if not exists ix_mrl_lote   on public.mensalidade_reconciliacao_log (lote);
create index if not exists ix_mrl_titulo on public.mensalidade_reconciliacao_log (titulo_id);

alter table public.mensalidade_reconciliacao_log enable row level security;

drop policy if exists mrl_leitura_gestao on public.mensalidade_reconciliacao_log;
create policy mrl_leitura_gestao on public.mensalidade_reconciliacao_log
  for select to authenticated using (public.usuario_e_gestao());

-- ---------------------------------------------------------------------------
-- A RECONCILIACAO, idempotente, pelo motor oficial
-- ---------------------------------------------------------------------------
-- NAO TEM UPDATE DE STATUS PROPRIO: chama titulo_reavaliar titulo a titulo.
-- Nao guarda uma copia da regra -- usa a regra.
create or replace function public.mensalidade_reconciliar_negociado_quitado(
  p_confirmar boolean default false
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '600s'
as $function$
declare
  v_lote text;
  v_qtd int; v_alunos int; v_acordos int; v_soma numeric;
  v_ok int; v_t uuid; v_fora int;
  v_neg_antes int; v_pago_antes int; v_neg_depois int; v_pago_depois int;
  v_val_antes numeric; v_val_depois numeric;
  v_parc_antes int; v_parc_depois int;
  v_vinc_antes int; v_vinc_depois int;
  v_pag_antes int;  v_pag_depois int;
  v_ac_antes int;   v_ac_depois int;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  -- 1) A POPULACAO, materializada por ID antes de qualquer escrita.
  create temp table _mrnq_alvo on commit drop as
  select t.id as titulo_id, t.aluno_id, va.acordo_id, a.numero_acordo, t.documento,
         coalesce(t.valor_original,0) as valor_original,
         t.situacao as situacao_antes, t.status as status_antes
    from public.acordos_titulos t
    join lateral (
      select v.acordo_id
        from public.acordo_titulo_vinculo v
        join public.acordos a2 on a2.id = v.acordo_id
       where v.titulo_id = t.id
         and coalesce(v.ativo, true)
         and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA')
       order by v.criado_em desc nulls last
       limit 1
    ) va on true
    join public.acordos a on a.id = va.acordo_id
   where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
     and upper(coalesce(a.status,'')) = 'QUITADO'
     and not exists (
       select 1 from public.parcelas p
        where p.acordo_id = va.acordo_id
          and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'))
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and t.origem_liquidacao   is null
     and t.origem_encerramento is null;

  select count(*), count(distinct aluno_id), count(distinct acordo_id),
         round(coalesce(sum(valor_original),0),2)
    into v_qtd, v_alunos, v_acordos, v_soma
    from _mrnq_alvo;

  if not coalesce(p_confirmar, false) then
    return jsonb_build_object(
      'modo','previa', 'mensalidades',v_qtd, 'alunos',v_alunos,
      'acordos',v_acordos, 'valor',v_soma,
      'impressao_digital_ids',
        (select md5(string_agg(titulo_id::text, ',' order by titulo_id)) from _mrnq_alvo),
      'ids', (select coalesce(jsonb_agg(titulo_id order by titulo_id),'[]'::jsonb) from _mrnq_alvo));
  end if;

  -- IDEMPOTENCIA: rodar de novo sem nada elegivel nao escreve nada.
  if v_qtd = 0 then
    return jsonb_build_object('modo','aplicado','mensalidades',0,'alterados',0,
      'observacao','nada elegivel: a reconciliacao ja esta em dia');
  end if;

  -- 2) FOTO DO ANTES -- global, nao so da populacao.
  select count(*) filter (where upper(coalesce(situacao,''))='NEGOCIADO'),
         count(*) filter (where upper(coalesce(situacao,''))='PAGO'),
         round(coalesce(sum(coalesce(valor_original,0)),0),2)
    into v_neg_antes, v_pago_antes, v_val_antes
    from public.acordos_titulos;
  select count(*) into v_parc_antes from public.parcelas;
  select count(*) into v_vinc_antes from public.acordo_titulo_vinculo;
  select count(*) into v_pag_antes  from public.pagamentos;
  select count(*) into v_ac_antes   from public.acordos;

  v_lote := to_char(clock_timestamp(),'YYYYMMDDHH24MISS');

  -- 3) O MOTOR OFICIAL, titulo a titulo.
  for v_t in select titulo_id from _mrnq_alvo order by titulo_id loop
    perform public.titulo_reavaliar(v_t);
  end loop;

  -- 4) REGISTRO auditavel: antes e depois, linha a linha.
  insert into public.mensalidade_reconciliacao_log
    (lote, titulo_id, aluno_id, acordo_id, numero_acordo, documento, valor_original,
     situacao_antes, status_antes, situacao_depois, status_depois, motivo, executado_por)
  select v_lote, x.titulo_id, x.aluno_id, x.acordo_id, x.numero_acordo, x.documento,
         x.valor_original, x.situacao_antes, x.status_antes, t.situacao, t.status,
         'acordo QUITADO sem parcela viva: a obrigacao desta mensalidade foi liquidada pelo acordo',
         coalesce(auth.email(), 'service_role')
    from _mrnq_alvo x
    join public.acordos_titulos t on t.id = x.titulo_id;

  -- 5) FOTO DO DEPOIS.
  select count(*) filter (where upper(coalesce(situacao,''))='NEGOCIADO'),
         count(*) filter (where upper(coalesce(situacao,''))='PAGO'),
         round(coalesce(sum(coalesce(valor_original,0)),0),2)
    into v_neg_depois, v_pago_depois, v_val_depois
    from public.acordos_titulos;
  select count(*) into v_parc_depois from public.parcelas;
  select count(*) into v_vinc_depois from public.acordo_titulo_vinculo;
  select count(*) into v_pag_depois  from public.pagamentos;
  select count(*) into v_ac_depois   from public.acordos;

  -- ------------------------------------------------------------------------
  -- 6) AS GUARDAS. Qualquer uma que falhe aborta a transacao inteira.
  -- ------------------------------------------------------------------------
  select count(*) into v_ok from public.mensalidade_reconciliacao_log
   where lote = v_lote
     and upper(coalesce(situacao_depois,'')) = 'PAGO'
     and lower(coalesce(status_depois,''))   = 'quitada';
  if v_ok <> v_qtd then
    raise exception 'ABORTA: elegiveis=%, efetivamente quitadas=%. Nada foi mantido.', v_qtd, v_ok;
  end if;

  select count(*) into v_fora from public.mensalidade_reconciliacao_log
   where lote = v_lote and upper(coalesce(situacao_antes,'')) <> 'NEGOCIADO';
  if v_fora > 0 then
    raise exception 'ABORTA: % linha(s) do lote nao estavam em NEGOCIADO', v_fora;
  end if;

  if (v_neg_antes - v_neg_depois) <> v_qtd then
    raise exception 'ABORTA: NEGOCIADO caiu % (esperado %). Houve efeito fora da populacao.',
      v_neg_antes - v_neg_depois, v_qtd;
  end if;
  if (v_pago_depois - v_pago_antes) <> v_qtd then
    raise exception 'ABORTA: PAGO subiu % (esperado %). Houve efeito fora da populacao.',
      v_pago_depois - v_pago_antes, v_qtd;
  end if;

  if v_val_depois <> v_val_antes then
    raise exception 'ABORTA: soma de valor_original mudou de % para %', v_val_antes, v_val_depois;
  end if;
  if v_parc_depois <> v_parc_antes then
    raise exception 'ABORTA: parcelas mudaram de % para %', v_parc_antes, v_parc_depois;
  end if;
  if v_vinc_depois <> v_vinc_antes then
    raise exception 'ABORTA: vinculos mudaram de % para %', v_vinc_antes, v_vinc_depois;
  end if;
  if v_pag_depois <> v_pag_antes then
    raise exception 'ABORTA: pagamentos mudaram de % para %', v_pag_antes, v_pag_depois;
  end if;
  if v_ac_depois <> v_ac_antes then
    raise exception 'ABORTA: acordos mudaram de % para %', v_ac_antes, v_ac_depois;
  end if;

  return jsonb_build_object(
    'modo','aplicado', 'lote',v_lote,
    'mensalidades',v_qtd, 'alterados',v_ok, 'alunos',v_alunos, 'acordos',v_acordos,
    'valor',v_soma,
    'negociado_antes',v_neg_antes, 'negociado_depois',v_neg_depois,
    'pago_antes',v_pago_antes,     'pago_depois',v_pago_depois,
    'parcelas',v_parc_antes, 'vinculos',v_vinc_antes,
    'pagamentos',v_pag_antes, 'acordos_total',v_ac_antes);
end;
$function$;

revoke all on function public.mensalidade_reconciliar_negociado_quitado(boolean) from public, anon;
grant execute on function public.mensalidade_reconciliar_negociado_quitado(boolean) to authenticated, service_role;