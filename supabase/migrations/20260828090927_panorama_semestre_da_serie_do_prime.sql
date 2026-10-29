-- O semestre da divida sai do PRIME, e so do Prime.
--
-- Amanda, 27/08/2026: "quero o semestre de origem da divida em aberto"; depois,
-- "nos ja estamos recebendo mensalidades de 2026/2"; e por fim, sobre a regra
-- de matricula que cheguei a aplicar: "mas ainda falta eu fazer a conferencia
-- ne" -- "melhor seria pelo prime mesmo".
--
-- ERRO MEU NA PRIMEIRA VERSAO: derivei o semestre do MES DO VENCIMENTO. Ela ja
-- tinha me ensinado que isso erra -- a matricula antecipada faz o aluno pagar
-- em junho uma parcela do contrato do semestre seguinte. Quem separa e a SERIE
-- DE COBRANCA, que a coleta da Prime guarda em prime_titulo_semestre.
--
-- Medido: o vencimento classificaria 3.371 titulos no semestre errado. E
-- 2026/2 aparecia inflado (6.815 titulos pelo vencimento contra 862 pela
-- serie), porque pegava parcela de contrato antigo que vence no segundo
-- semestre.
--
-- O SEMESTRE REAL, pela serie (97,2% dos titulos abertos casam):
--     2024/1   3.270 titulos   R$  2.100.655,55
--     2024/2   5.148           R$  2.998.068,73
--     2025/1   9.693           R$  6.413.575,17
--     2025/2  10.775           R$  7.852.096,90
--     2026/1  10.519           R$ 13.032.382,67
--     2026/2     862           R$  2.185.833,22
--     sem serie 1.166          R$  2.135.296,03
--
-- A REGRA DA MATRICULA, testada e revertida a pedido dela. "Aluno matriculado
-- em 2026/2 tem a divida contada em 2026/2" e regra de NEGOCIO -- defensavel,
-- mas e escolha dela e ela ainda nao conferiu. A serie e FATO, conferivel
-- boleto a boleto. Enquanto a conferencia nao acontece, o painel mostra fato.
--
-- Fica registrado o que aquela regra moveria, para quando ela conferir: 3.865
-- alunos matriculados em 2026/2 com divida aberta, R$ 14.231.231,21, dos quais
-- 9.719 titulos a serie coloca em outro semestre -- divida velha de aluno que
-- voltou.
--
-- PARCELA DE ACORDO fica em linha propria, e isso e honesto: o boleto de acordo
-- esta no portador 166, que a coleta de series nao cobre -- conferido, zero de
-- 10.057 casam. Inventar semestre para R$ 12,4 milhoes seria pior que admitir
-- que nao sabemos.

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

  with serie as (
    select distinct regexp_replace(coalesce(boleto,''), '\D', '', 'g') as doc, semestre
      from public.prime_titulo_semestre
     where coalesce(semestre,'') <> ''
  ),
  mens as (
    select t.aluno_id,
           regexp_replace(coalesce(t.documento,''), '\D', '', 'g') as doc,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor
      from public.acordos_titulos t
     where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and coalesce(lower(t.status),'') <> 'quitada'
       and not exists (
         select 1 from public.acordo_titulo_vinculo x
           join public.acordos a on a.id = x.acordo_id
          where x.titulo_id = t.id and coalesce(x.ativo, true)
            and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
  ),
  mens_sem as (
    select m.aluno_id, m.valor, coalesce(s.semestre, 'sem série identificada') as semestre
      from mens m left join serie s on s.doc = m.doc
  ),
  parc as (
    select a.aluno_id, coalesce(p.valor,0) as valor
      from public.parcelas p
      join public.acordos a on a.id = p.acordo_id
     where a.status = 'ATIVO'
       and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','ESTORNADA')
  ),
  tudo as (
    select aluno_id, valor, 'MENSALIDADE'::text as tipo from mens_sem
    union all
    select aluno_id, valor, 'ACORDO' from parc
  ),
  por_cpf as (select aluno_id, sum(valor) as saldo from tudo where aluno_id is not null group by 1),
  totais as (
    select (select count(*) from por_cpf) as cpfs,
           (select round(sum(saldo),2) from por_cpf) as valor,
           (select count(*) from tudo) as titulos
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'fonte_semestre', 'série de cobrança da Prime',
    'total', (select jsonb_build_object('cpfs', cpfs, 'titulos', titulos, 'valor', valor) from totais),
    'por_semestre', (
      select coalesce(jsonb_agg(x order by ordem, rotulo), '[]'::jsonb) from (
        select 1 as ordem, semestre as rotulo,
               jsonb_build_object(
                 'semestre', semestre,
                 'cpfs', count(distinct aluno_id),
                 'titulos', count(*),
                 'valor', round(sum(valor),2),
                 'pct_valor', round(100.0 * sum(valor) / nullif((select valor from totais),0), 1)
               ) as x
          from mens_sem group by semestre
        union all
        select 2, 'já em acordo',
               jsonb_build_object(
                 'semestre', 'já em acordo',
                 'cpfs', count(distinct aluno_id),
                 'titulos', count(*),
                 'valor', round(sum(valor),2),
                 'pct_valor', round(100.0 * sum(valor) / nullif((select valor from totais),0), 1)
               )
          from parc
      ) s2
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
  'Panorama do topo da Saude da Carteira. O semestre sai da SERIE DE COBRANCA da Prime (prime_titulo_semestre) -- fato conferivel boleto a boleto, nao regra de negocio. Nunca pelo vencimento (matricula antecipada erra). Parcela de acordo em linha propria: portador 166 nao tem serie coletada.';

revoke all on function public.saude_carteira_panorama() from public;
grant execute on function public.saude_carteira_panorama() to authenticated;
