-- Panorama da carteira: semestre, faixa de valor e mensalidade x acordo.
--
-- Amanda, 27/08/2026: "ajuste a saude da carteira por semestre, quantidade de
-- cpf por faixa, titulos mensalidade = acordos, % da base -- isso deixe no
-- topo".
--
-- POR QUE NO TOPO. A tela abria pelos indicadores operacionais (sem
-- acionamento, retornos, criticos) -- que respondem "o que fazer hoje".
-- Faltava a resposta anterior a essa: DE QUE E FEITA a carteira. Sem isso ela
-- olhava R$ 46 milhoes sem saber onde eles estao.
--
-- OS TRES CORTES, sobre a MESMA base canonica de saldo (parcela de acordo
-- ATIVO + mensalidade nao vinculada, sem deducao por data):
--
--   semestre  -> 2026/1 sozinho e R$ 15,9 mi; ainda ha R$ 5,9 mi de 2024 e
--                antes.
--   faixa     -> o corte que muda decisao: 33,5% dos CPFs devem ate R$ 1 mil e
--                sao 5% do dinheiro; 1,9% devem acima de R$ 30 mil e sao
--                31,5%. Trabalhar por quantidade e trabalhar pelos 5%.
--   tipo      -> 41.433 titulos de mensalidade (R$ 36,7 mi) contra 10.057
--                parcelas de acordo (R$ 12,4 mi): 75% da carteira NUNCA foi
--                negociada.
--
-- Cada linha traz a % sobre o total -- o absoluto sozinho nao diz se e muito ou
-- pouco. Uma consulta so para os tres cortes: a tela ja carrega bastante coisa.

create or replace function public.saude_carteira_panorama()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_res jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not (coalesce(public.usuario_e_gestao(), false) or coalesce(public.usuario_tem_visao_geral(), false)) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with tudo as (
    select t.aluno_id, t.vencimento,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor,
           'MENSALIDADE'::text as tipo
      from public.acordos_titulos t
     where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and coalesce(lower(t.status),'') <> 'quitada'
       and not exists (
         select 1 from public.acordo_titulo_vinculo x
           join public.acordos a on a.id = x.acordo_id
          where x.titulo_id = t.id and coalesce(x.ativo, true)
            and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
    union all
    select a.aluno_id, p.vencimento, coalesce(p.valor,0), 'ACORDO'
      from public.parcelas p
      join public.acordos a on a.id = p.acordo_id
     where a.status = 'ATIVO'
       and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','ESTORNADA')
  ),
  por_cpf as (select aluno_id, sum(valor) as saldo from tudo where aluno_id is not null group by 1),
  totais as (
    select (select count(*) from por_cpf) as cpfs,
           (select round(sum(saldo),2) from por_cpf) as valor,
           (select count(*) from tudo) as titulos
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'total', (select jsonb_build_object('cpfs', cpfs, 'titulos', titulos, 'valor', valor) from totais),
    'por_semestre', (
      select coalesce(jsonb_agg(x order by x->>'semestre'), '[]'::jsonb) from (
        select jsonb_build_object(
          'semestre', case when vencimento is null then 'sem data'
                      else extract(year from vencimento)::text || '/' ||
                           case when extract(month from vencimento) <= 6 then '1' else '2' end end,
          'cpfs', count(distinct aluno_id),
          'titulos', count(*),
          'valor', round(sum(valor),2),
          'pct_valor', round(100.0 * sum(valor) / nullif((select valor from totais),0), 1)
        ) as x
        from tudo group by 1
      ) s
    ),
    'por_faixa', (
      select coalesce(jsonb_agg(x order by ordem), '[]'::jsonb) from (
        select
          case when saldo < 1000 then 1 when saldo < 3000 then 2 when saldo < 6000 then 3
               when saldo < 12000 then 4 when saldo < 30000 then 5 else 6 end as ordem,
          jsonb_build_object(
            'faixa', case when saldo < 1000 then 'até R$ 1 mil'
                          when saldo < 3000 then 'R$ 1 a 3 mil'
                          when saldo < 6000 then 'R$ 3 a 6 mil'
                          when saldo < 12000 then 'R$ 6 a 12 mil'
                          when saldo < 30000 then 'R$ 12 a 30 mil'
                          else 'acima de R$ 30 mil' end,
            'cpfs', count(*),
            'pct_cpfs', round(100.0 * count(*) / nullif((select cpfs from totais),0), 1),
            'valor', round(sum(saldo),2),
            'pct_valor', round(100.0 * sum(saldo) / nullif((select valor from totais),0), 1)
          ) as x
        from por_cpf
        group by 1, case when saldo < 1000 then 'até R$ 1 mil'
                         when saldo < 3000 then 'R$ 1 a 3 mil'
                         when saldo < 6000 then 'R$ 3 a 6 mil'
                         when saldo < 12000 then 'R$ 6 a 12 mil'
                         when saldo < 30000 then 'R$ 12 a 30 mil'
                         else 'acima de R$ 30 mil' end
      ) f
    ),
    'por_tipo', (
      select coalesce(jsonb_agg(x order by x->>'tipo'), '[]'::jsonb) from (
        select jsonb_build_object(
          'tipo', tipo,
          'titulos', count(*),
          'cpfs', count(distinct aluno_id),
          'valor', round(sum(valor),2),
          'pct_valor', round(100.0 * sum(valor) / nullif((select valor from totais),0), 1)
        ) as x
        from tudo group by tipo
      ) t2
    )
  ) into v_res;

  return v_res;
end;
$function$;

comment on function public.saude_carteira_panorama() is
  'Panorama do topo da Saude da Carteira: saldo em aberto quebrado por semestre de vencimento, por faixa de valor (CPFs e % da base) e por tipo (mensalidade x acordo). Mesma regra canonica de saldo do resto do sistema.';

revoke all on function public.saude_carteira_panorama() from public;
grant execute on function public.saude_carteira_panorama() to authenticated;
