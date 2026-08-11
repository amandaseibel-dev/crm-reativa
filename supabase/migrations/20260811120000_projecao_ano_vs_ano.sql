-- Projeção Hora a Hora — aba "Ano vs Ano" (gestão).
--
-- Objetivo: entender as QUEDAS na recuperação comparando ano contra ano.
-- O total mês a mês esconde a queda real; por isso a RPC decompõe cada mês
-- em TRÊS drivers: volume (nº de pagamentos), ticket médio (pago/pagamento)
-- e honorário. Ex.: um mês pode recuperar MAIS no total (mais volume) e ainda
-- assim ter ticket médio menor — a "queda escondida".
--
-- Fonte unificada: pagamentos (jul/2026 em diante) + recuperacao_historica
-- (abr/2025 → jun/2026). Mesma união usada em dashboard_ano_vs_ano.
--
-- Gate: SOMENTE gestão real (Amanda Seibel / Fernanda = cobranca04). Amanda ADM
-- (cobranca07) e operadores NÃO acessam — retorna {autorizado:false}. A
-- autorização é feita no backend (SECURITY DEFINER), não dá pra burlar no front.

create or replace function public.projecao_ano_vs_ano()
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_ano_atual int := extract(year from current_date)::int;
  v_ano_ant int := extract(year from current_date)::int - 1;
  v_mes_atual int := extract(month from current_date)::int;
  v_dia_atual int := extract(day from current_date)::int;
  v_resultado json;
begin
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    return json_build_object('autorizado', false);
  end if;

  with unif as (
    select p.data_pagamento, p.valor_pago, p.valor_honorario
      from pagamentos p where p.data_pagamento is not null
    union all
    select r.data_pagamento, r.valor_pago, r.valor_honorario
      from recuperacao_historica r where r.data_pagamento is not null
  ),
  -- Agregação por ano+mês dos dois anos em foco (ano anterior x ano atual).
  mensal as (
    select extract(year from data_pagamento)::int  ano,
           extract(month from data_pagamento)::int mes,
           round(sum(valor_pago))::bigint          rec,
           round(sum(valor_honorario))::bigint     hon,
           count(*)::bigint                         n
      from unif
     where extract(year from data_pagamento) in (v_ano_ant, v_ano_atual)
     group by 1,2
  ),
  -- Uma linha por mês (1..12), com colunas do ano anterior e do ano atual.
  linhas as (
    select g.m as mes,
           coalesce(a.rec,0)::bigint rec_ant, coalesce(a.hon,0)::bigint hon_ant, coalesce(a.n,0)::bigint n_ant,
           coalesce(b.rec,0)::bigint rec_atu, coalesce(b.hon,0)::bigint hon_atu, coalesce(b.n,0)::bigint n_atu
      from generate_series(1,12) g(m)
      left join mensal a on a.ano = v_ano_ant   and a.mes = g.m
      left join mensal b on b.ano = v_ano_atual and b.mes = g.m
  ),
  -- "Mesmo período": mês corrente até o mesmo dia do mês, nos dois anos —
  -- comparação justa do mês em curso (não compara mês inteiro x mês parcial).
  mp as (
    select
      round(coalesce(sum(valor_pago)      filter (where extract(year from data_pagamento)=v_ano_ant),0))::bigint  rec_ant,
      round(coalesce(sum(valor_pago)      filter (where extract(year from data_pagamento)=v_ano_atual),0))::bigint rec_atu,
      round(coalesce(sum(valor_honorario) filter (where extract(year from data_pagamento)=v_ano_ant),0))::bigint  hon_ant,
      round(coalesce(sum(valor_honorario) filter (where extract(year from data_pagamento)=v_ano_atual),0))::bigint hon_atu,
      count(*) filter (where extract(year from data_pagamento)=v_ano_ant)::bigint  n_ant,
      count(*) filter (where extract(year from data_pagamento)=v_ano_atual)::bigint n_atu
      from unif
     where extract(month from data_pagamento) = v_mes_atual
       and extract(day   from data_pagamento) <= v_dia_atual
  )
  select json_build_object(
    'autorizado', true,
    'ano_anterior', v_ano_ant,
    'ano_atual',    v_ano_atual,
    'mes_ref',      v_mes_atual,
    'dia_ref',      v_dia_atual,
    'por_mes', (
      select coalesce(json_agg(json_build_object(
                'mes', mes,
                'rec_ant', rec_ant, 'rec_atu', rec_atu,
                'hon_ant', hon_ant, 'hon_atu', hon_atu,
                'n_ant',   n_ant,   'n_atu',   n_atu,
                'ticket_ant', case when n_ant>0 then round(rec_ant::numeric / n_ant)::bigint else 0 end,
                'ticket_atu', case when n_atu>0 then round(rec_atu::numeric / n_atu)::bigint else 0 end
              ) order by mes), '[]'::json)
        from linhas
    ),
    'total_ant', (select coalesce(sum(rec_ant),0) from linhas),
    'total_atu', (select coalesce(sum(rec_atu),0) from linhas),
    'hon_total_ant', (select coalesce(sum(hon_ant),0) from linhas),
    'hon_total_atu', (select coalesce(sum(hon_atu),0) from linhas),
    'mesmo_periodo', (
      select json_build_object(
        'rec_ant', rec_ant, 'rec_atu', rec_atu,
        'hon_ant', hon_ant, 'hon_atu', hon_atu,
        'n_ant',   n_ant,   'n_atu',   n_atu,
        'ticket_ant', case when n_ant>0 then round(rec_ant::numeric / n_ant)::bigint else 0 end,
        'ticket_atu', case when n_atu>0 then round(rec_atu::numeric / n_atu)::bigint else 0 end
      ) from mp
    )
  ) into v_resultado;

  return v_resultado;
end;
$function$;

revoke all on function public.projecao_ano_vs_ano() from public, anon, authenticated;
grant execute on function public.projecao_ano_vs_ano() to authenticated;
