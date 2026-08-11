-- Projeção Hora a Hora — aba "Ano vs Ano": recorte REMATRÍCULA 2026/2.
--
-- Além da decomposição ano vs ano, a RPC passa a devolver um bloco
-- `rematricula`: quanto do recuperado do ANO ATUAL veio de alunos que HOJE
-- ainda NÃO matricularam para 2026/2 (alunos.situacao_academica =
-- 'Aguardando Matrícula').
--
-- IMPORTANTE (limitações honestas, refletidas no front):
--   1. As linhas de recuperacao_historica NÃO têm aluno_id nem cpf — só o
--      nome. Então o vínculo com o status acadêmico é por NOME normalizado
--      (upper + trim + colapso de espaços). Cobertura ~94% do valor; o resto
--      não casa por grafia/nome ausente. Homônimos são desambiguados usando
--      DISTINCT por nome (1 linha por nome), evitando inflar o total no join.
--   2. É o status de HOJE aplicado a pagamentos passados: responde "quanto do
--      recuperado veio de gente que AINDA HOJE está sem matricular" — o público
--      que sobra pra campanha de rematrícula. Não é o status "da época".
--
-- Devolve também cobertura_rec_total / cobertura_rec_casado (ano atual) pra o
-- front exibir a % de match e ninguém ler o recorte como número fechado.
--
-- Gate: idêntico — só Amanda Seibel / Fernanda (cobranca04).

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
  -- Mesma união, carregando o NOME (único elo com o cadastro no histórico).
  unif_nome as (
    select p.data_pagamento, p.valor_pago, p.valor_honorario,
           upper(btrim(regexp_replace(coalesce(p.aluno_nome,''),'\s+',' ','g'))) nome
      from pagamentos p where p.data_pagamento is not null
    union all
    select r.data_pagamento, r.valor_pago, r.valor_honorario,
           upper(btrim(regexp_replace(coalesce(r.aluno_nome,''),'\s+',' ','g'))) nome
      from recuperacao_historica r where r.data_pagamento is not null
  ),
  -- Alunos que HOJE ainda não matricularam para 2026/2. DISTINCT por nome
  -- normalizado: 1 linha por nome, evita fanout/homônimo inflando o total.
  rematr as (
    select distinct upper(btrim(regexp_replace(coalesce(nome,''),'\s+',' ','g'))) nome
      from alunos
     where situacao_academica = 'Aguardando Matrícula'
       and coalesce(nome,'') <> ''
  ),
  -- Todos os nomes do cadastro (p/ medir cobertura do match no ano atual).
  todos_nomes as (
    select distinct upper(btrim(regexp_replace(coalesce(nome,''),'\s+',' ','g'))) nome
      from alunos where coalesce(nome,'') <> ''
  ),
  -- Recorte por mês (ano atual) do recuperado de quem está Aguardando Matrícula.
  rematr_mes as (
    select extract(month from u.data_pagamento)::int mes,
           round(sum(u.valor_pago))::bigint    rec,
           round(sum(u.valor_honorario))::bigint hon,
           count(*)::bigint                     n
      from unif_nome u
      join rematr a on a.nome = u.nome
     where extract(year from u.data_pagamento) = v_ano_atual
       and u.nome <> ''
     group by 1
  ),
  -- Cobertura: quanto do recuperado do ano atual casa com ALGUM aluno por nome.
  cobertura as (
    select round(sum(u.valor_pago))::bigint rec_total,
           round(sum(u.valor_pago) filter (where tn.nome is not null))::bigint rec_casado
      from unif_nome u
      left join todos_nomes tn on tn.nome = u.nome and u.nome <> ''
     where extract(year from u.data_pagamento) = v_ano_atual
  ),
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
  linhas as (
    select g.m as mes,
           coalesce(a.rec,0)::bigint rec_ant, coalesce(a.hon,0)::bigint hon_ant, coalesce(a.n,0)::bigint n_ant,
           coalesce(b.rec,0)::bigint rec_atu, coalesce(b.hon,0)::bigint hon_atu, coalesce(b.n,0)::bigint n_atu
      from generate_series(1,12) g(m)
      left join mensal a on a.ano = v_ano_ant   and a.mes = g.m
      left join mensal b on b.ano = v_ano_atual and b.mes = g.m
  ),
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
    ),
    -- Recorte rematrícula 2026/2 (ano atual): recuperado de quem ainda não
    -- matriculou. por_mes só traz meses com valor; front cruza com o total do
    -- mês (linhas.rec_atu) pra mostrar o %.
    'rematricula', json_build_object(
      'label', 'Aguardando Matrícula',
      'por_mes', (
        select coalesce(json_agg(json_build_object(
                  'mes', mes, 'rec', rec, 'hon', hon, 'n', n
                ) order by mes), '[]'::json)
          from rematr_mes
      ),
      'total_rec', (select coalesce(sum(rec),0) from rematr_mes),
      'total_hon', (select coalesce(sum(hon),0) from rematr_mes),
      'total_n',   (select coalesce(sum(n),0)   from rematr_mes),
      'cobertura_rec_total',  (select rec_total  from cobertura),
      'cobertura_rec_casado', (select rec_casado from cobertura)
    )
  ) into v_resultado;

  return v_resultado;
end;
$function$;

revoke all on function public.projecao_ano_vs_ano() from public, anon, authenticated;
grant execute on function public.projecao_ano_vs_ano() to authenticated;
