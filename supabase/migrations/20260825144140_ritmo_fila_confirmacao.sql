-- Fila de confirmação: ritmo do dia e quantos dias faltam para zerar.
--
-- A conta ingênua -- pendentes ÷ feitas por dia -- MENTE aqui, porque a fila
-- não é um estoque parado: ela recebe caso novo todo dia. Medido em prod nos
-- 12 dias úteis até 2026-08-25: ENTRARAM 694 e SAÍRAM 307. A fila não está
-- sendo drenada, está CRESCENDO ~32 casos por dia útil.
--
-- Então a projeção usa o SALDO do dia (saíram - entraram):
--   saldo > 0  -> dias_para_zerar = pendentes / saldo
--   saldo <= 0 -> não zera no ritmo atual; devolve dias_para_zerar = null e
--                 diz quanto seria preciso fazer por dia para zerar em 30 dias.
-- Melhor dizer "não zera" do que devolver um número bonito e falso.
--
-- Só dias com movimento entram na média (domingo não conta como dia parado).
--
-- Somente leitura. NÃO altera nada.
-- Rollback: supabase/rollbacks/20260825210000_ritmo_fila_confirmacao.rollback.sql

create or replace function public.ritmo_fila_confirmacao(p_dias int default 14)
  returns jsonb
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  with janela as (
    select greatest(coalesce(p_dias, 14), 1) as n
  ),
  dias as (
    select generate_series(
             (now() at time zone 'America/Sao_Paulo')::date - (select n from janela),
             (now() at time zone 'America/Sao_Paulo')::date,
             '1 day')::date as d
  ),
  ent as (
    select (criado_em at time zone 'America/Sao_Paulo')::date d, count(*) n
      from public.solicitacoes_confirmacao_pagamento
     group by 1
  ),
  sai as (
    select (confirmado_em at time zone 'America/Sao_Paulo')::date d, count(*) n
      from public.solicitacoes_confirmacao_pagamento
     where confirmado_em is not null
       and status <> 'AGUARDANDO_CONFIRMACAO'
     group by 1
  ),
  serie as (
    select dias.d,
           coalesce(ent.n, 0) as entraram,
           coalesce(sai.n, 0) as sairam
      from dias
      left join ent on ent.d = dias.d
      left join sai on sai.d = dias.d
  ),
  -- Dia sem NENHUM movimento é dia que não houve trabalho (domingo, feriado):
  -- entra na média como zero, ele achataria o ritmo real sem representar nada.
  uteis as (
    select * from serie where entraram > 0 or sairam > 0
  ),
  agg as (
    select
      count(*)                                            as dias_considerados,
      coalesce(avg(sairam), 0)                            as media_saidas,
      coalesce(avg(entraram), 0)                          as media_entradas,
      coalesce(avg(sairam), 0) - coalesce(avg(entraram),0) as saldo_dia
    from uteis
  ),
  pend as (
    select count(*) n
      from public.solicitacoes_confirmacao_pagamento
     where status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  hoje as (
    select
      (select count(*) from public.solicitacoes_confirmacao_pagamento
        where confirmado_em is not null and status <> 'AGUARDANDO_CONFIRMACAO'
          and (confirmado_em at time zone 'America/Sao_Paulo')::date
              = (now() at time zone 'America/Sao_Paulo')::date) as sairam,
      (select count(*) from public.solicitacoes_confirmacao_pagamento
        where (criado_em at time zone 'America/Sao_Paulo')::date
              = (now() at time zone 'America/Sao_Paulo')::date) as entraram
  )
  select jsonb_build_object(
    'pendentes',          pend.n,
    'feitas_hoje',        hoje.sairam,
    'entraram_hoje',      hoje.entraram,
    'dias_considerados',  agg.dias_considerados,
    'media_saidas',       round(agg.media_saidas, 1),
    'media_entradas',     round(agg.media_entradas, 1),
    'saldo_dia',          round(agg.saldo_dia, 1),
    'dias_para_zerar',    case when agg.saldo_dia > 0
                               then ceil(pend.n / agg.saldo_dia)::int end,
    -- Quanto seria preciso FAZER por dia para zerar em 30 dias, já contando o
    -- que continua entrando. É o número acionável quando a fila está crescendo.
    'necessario_por_dia_30d',
        ceil(pend.n::numeric / 30 + agg.media_entradas)::int
  )
  from agg, pend, hoje;
$function$;

revoke all on function public.ritmo_fila_confirmacao(int) from public, anon;
grant execute on function public.ritmo_fila_confirmacao(int) to authenticated, service_role;
