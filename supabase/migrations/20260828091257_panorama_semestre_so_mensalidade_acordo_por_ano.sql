-- Semestre so para mensalidade; acordo ganha corte proprio, por ano.
--
-- Amanda, 27/08/2026: "deixa sem as parcelas de acordos, apenas as
-- mensalidades, e os acordos faz por ano".
--
-- POR QUE ELA ESTA CERTA. Eu tinha enfiado as parcelas de acordo dentro do
-- bloco de semestre, numa linha "ja em acordo". Ficava no lugar errado: aquele
-- bloco responde "de que semestre nasceu a divida", e para acordo essa resposta
-- nao existe -- o boleto esta no portador 166, que a coleta de series nao cobre
-- (conferido: zero de 10.057 casam). Uma linha sem semestre dentro de um bloco
-- de semestres so atrapalha a leitura.
--
-- Agora sao dois blocos com perguntas diferentes:
--
--   semestre  -> SO MENSALIDADE, pela serie de cobranca. De onde vem a divida
--                que ainda nao foi negociada.
--   acordo    -> POR ANO DE VENCIMENTO. Quando o dinheiro ja negociado deveria
--                entrar. E a pergunta que cabe a um acordo: nao de onde veio,
--                mas quando cai.
--
-- O ano de VENCIMENTO e o corte util -- o ano em que o acordo foi FEITO diria
-- quase nada, porque 95% deles entraram por importacao em julho e agosto de
-- 2026.
--
--     2025    1.182 parcelas    390 alunos   R$    951.513,73  <- ja venceu
--     2026    8.072           2.294          R$ 10.298.730,54
--     2027      803             532          R$  1.199.152,95
--
-- Os totais do topo continuam somando tudo (mensalidade + acordo): a carteira e
-- as duas coisas. O que muda e como cada parte e quebrada.

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
    select a.aluno_id, coalesce(p.valor,0) as valor, p.vencimento
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
      select coalesce(jsonb_agg(x order by rotulo), '[]'::jsonb) from (
        select semestre as rotulo,
               jsonb_build_object(
                 'semestre', semestre,
                 'cpfs', count(distinct aluno_id),
                 'titulos', count(*),
                 'valor', round(sum(valor),2),
                 'pct_valor', round(100.0 * sum(valor) / nullif((select valor from totais),0), 1)
               ) as x
          from mens_sem group by semestre
      ) s2
    ),
    'acordo_por_ano', (
      select coalesce(jsonb_agg(x order by rotulo), '[]'::jsonb) from (
        select coalesce(extract(year from vencimento)::text, 'sem data') as rotulo,
               jsonb_build_object(
                 'ano', coalesce(extract(year from vencimento)::text, 'sem data'),
                 'cpfs', count(distinct aluno_id),
                 'parcelas', count(*),
                 'valor', round(sum(valor),2),
                 'vencido', (vencimento < current_date),
                 'pct_valor', round(100.0 * sum(valor) / nullif((select valor from totais),0), 1)
               ) as x
          from parc
         group by coalesce(extract(year from vencimento)::text, 'sem data'), (vencimento < current_date)
      ) a2
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
  'Panorama do topo da Saude da Carteira. Semestre: SO MENSALIDADE, pela serie de cobranca da Prime (acordo nao tem semestre de origem -- portador 166 nao coletado). Acordo: bloco proprio por ANO DE VENCIMENTO, que e quando o dinheiro negociado deveria entrar. Faixa e tipo somam as duas coisas.';

revoke all on function public.saude_carteira_panorama() from public;
grant execute on function public.saude_carteira_panorama() to authenticated;
