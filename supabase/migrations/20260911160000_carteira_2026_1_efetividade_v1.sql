-- ============================================================================
-- CARTEIRA 2026/1 — EFETIVIDADE DE COBRANÇA (V1 para a Diretoria)
-- ----------------------------------------------------------------------------
-- Conceito fechado pela Amanda em 11/09/2026, depois de três versões e uma
-- auditoria título a título:
--
--   EFETIVIDADE = valor ORIGINAL da carteira que foi pago OU negociado em
--   algum momento. A situação posterior do acordo (atraso, quebra,
--   cancelamento) NÃO devolve o valor para a inadimplência — ela aparece só
--   como qualidade interna da conversão.
--
--   INADIMPLÊNCIA = valor que segue sem pagamento e sem nenhuma evidência de
--   negociação, com o Prime confirmando o título ainda aberto.
--
-- Quatro faixas fecham 100% da carteira base; a RECUPERAÇÃO FINANCEIRA (o
-- dinheiro) vive DENTRO da efetividade e nunca é somada de novo.
--
-- REGRAS QUE CUSTARAM MEDIÇÃO (não simplificar sem refazer a auditoria):
--
-- 1. TETO POR TÍTULO. A efetividade de um título nunca passa do valor_original.
--    Juros, multa e honorário não aumentam carteira recuperada — aplicar o teto
--    derrubou o "pago via acordo" de R$ 3.614.133,99 para R$ 3.440.397,54.
--
-- 2. PARTIÇÃO, NÃO SOMA. O título em acordo é dividido em "parte paga"
--    (valor_original × parcelas pagas ÷ total) e "parte negociada" (o resto).
--    Pagar mais uma parcela MOVE valor entre as sub-faixas; o total não sobe.
--
-- 3. BAIXA SEM LASTRO. Título marcado PAGO no CRM que ainda tem saldo gravado
--    só conta a parte com lastro (valor_original − saldo). O saldo só entra se
--    o Prime confirmar a liquidação.
--
-- 4. PLACEHOLDER DO PRIME. `liquidado_em` vem preenchido até em título aberto.
--    Liquidação REAL = depois do vencimento + 30 dias E depois da importação.
--    Sem essa régua, R$ 31 mi de dívida viva somem.
--
-- 5. "ABERTO NO PRIME" NÃO PROVA "NUNCA NEGOCIADO" (medido em 11/09): dos
--    títulos que sabemos estar em acordo, 2,7% do valor aparece aberto — e nos
--    acordos QUEBRADOS isso chega a 28,7%. A ULBRA devolve a mensalidade ao
--    portador quando o acordo quebra. Por isso título aberto de CPF que paga
--    acordo fora do CRM vai para EM VALIDAÇÃO, nunca para inadimplência.
--
-- 6. CPF NÃO CONVERTE CARTEIRA. Aluno que negociou outra dívida não transforma
--    o título de 2026/1 em efetividade. A conta é por título, sempre.
--
-- Números aprovados na V1 (11/09/2026), sobre base de R$ 21.752.304,72:
--   Efetividade comprovada   11.218.629,14   51,57%
--   Inadimplência confirmada  9.644.603,72   44,34%
--   Em validação                850.131,47    3,91%
--   Baixa/Ajuste acadêmico       38.940,39    0,18%
--   (dentro da efetividade) Recuperação financeira 6.510.891,25 — 29,93%
--
-- Só leitura sobre a operação: nada aqui dá baixa, cria acordo ou mexe em
-- saldo. As únicas escritas são nas duas tabelas próprias deste relatório.
-- Reversível: drop das duas tabelas e das quatro funções.
-- ============================================================================
begin;

-- ---------------------------------------------------------------- 1. BASE
-- A carteira é CONGELADA: a Diretoria acompanha a mesma carteira ao longo do
-- tempo. Título que entrar depois não muda o passado — entra como linha nova,
-- com sua própria data de entrada.
create table if not exists public.carteira_2026_1_base (
  titulo_id      uuid primary key,
  aluno_id       uuid,
  cpf            text,
  documento      text,
  vencimento     date,
  valor_original numeric not null,
  origem_semestre text not null,          -- 'serie_prime' | 'vencimento'
  entrada_em     date,                    -- quando o título entrou para cobrança
  congelado_em   timestamptz not null default now()
);
comment on table public.carteira_2026_1_base is
  'Carteira 2026/1 congelada (V1 11/09/2026). Semestre pela série do Prime; fallback por vencimento fica marcado em origem_semestre para auditoria.';
create index if not exists carteira_2026_1_base_cpf_idx on public.carteira_2026_1_base (cpf);

alter table public.carteira_2026_1_base enable row level security;
drop policy if exists carteira_2026_1_base_sem_acesso on public.carteira_2026_1_base;
create policy carteira_2026_1_base_sem_acesso on public.carteira_2026_1_base for all using (false);

-- Congela a base. Só insere o que ainda não existe: nunca reescreve história.
create or replace function public.carteira_2026_1_congelar()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_novos int; v_total numeric; v_qtd int;
begin
  if not (coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null
          or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with serie as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(semestre) semestre
      from public.prime_titulo_semestre
     where coalesce(semestre,'') <> '' group by 1
  ), eleg as (
    select t.id, t.aluno_id,
           lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') cpf,
           t.documento, t.vencimento, t.valor_original,
           case when s.semestre = '2026/1' then 'serie_prime' else 'vencimento' end origem,
           t.created_at::date entrada
      from public.acordos_titulos t
      left join serie s on s.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
     where t.situacao <> 'DUPLICADA'
       and coalesce(s.semestre,
             case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01'
                  then '2026/1' end) = '2026/1'
  )
  insert into public.carteira_2026_1_base
        (titulo_id, aluno_id, cpf, documento, vencimento, valor_original, origem_semestre, entrada_em)
  select e.id, e.aluno_id, e.cpf, e.documento, e.vencimento, coalesce(e.valor_original,0), e.origem, e.entrada
    from eleg e
   where not exists (select 1 from public.carteira_2026_1_base b where b.titulo_id = e.id);
  get diagnostics v_novos = row_count;

  select count(*), round(sum(valor_original),2) into v_qtd, v_total from public.carteira_2026_1_base;
  return jsonb_build_object('novos', v_novos, 'titulos', v_qtd, 'valor', v_total);
end; $$;
revoke all on function public.carteira_2026_1_congelar() from public, anon;
grant execute on function public.carteira_2026_1_congelar() to authenticated;

select public.carteira_2026_1_congelar();

-- ---------------------------------------------- 2. CLASSIFICAÇÃO (a régua)
-- Uma linha por título, com o valor de cada faixa. É a única fonte da verdade
-- do relatório: os cards, o drill-down e a evolução leem daqui.
create or replace function public.carteira_2026_1_classificar()
returns table (
  titulo_id uuid, cpf text, aluno_id uuid, documento text, vencimento date,
  entrada_em date, valor_original numeric, situacao_crm text, estado_prime text,
  faixa text, sub_faixa text, acordo_estado text,
  ef_pago numeric, ef_negociado numeric, ef_convertido numeric,
  em_validacao numeric, academico numeric, inadimplencia numeric,
  recuperacao_financeira numeric
) language sql stable security definer set search_path = public as $$
  with
  -- liquidação no Prime, com a régua do placeholder
  serie as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(liquidado_em) liq
      from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
  ),
  -- estado de cada acordo: quanto já foi pago e em que situação ele está
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas,
           count(*) filter (where status = 'VENCIDA' and vencimento >= current_date - 30) venc_ate30,
           count(*) filter (where status = 'VENCIDA' and vencimento <  current_date - 30) venc_mais30
      from public.parcelas group by 1
  ),
  acordo as (
    select a.id,
           case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                when a.status = 'QUITADO' then 1 else 0 end ratio,
           case when a.status = 'CANCELADO' then 'cancelado'
                when a.status = 'QUITADO'   then 'quitado'
                when coalesce(p.venc_mais30,0) > 0 then 'quebrado'
                when coalesce(p.venc_ate30,0)  > 0 then 'atraso'
                else 'regular' end estado
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  -- caixa de acordo que não existe no CRM: prova de negociação fora daqui
  boletos_nossos as (
    select distinct regexp_replace(coalesce(boleto,''), '\D', '', 'g') b
      from public.parcelas where boleto is not null
  ),
  caixa_fora as (
    select lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') cpf,
           min(p.data_pagamento) primeiro, round(sum(p.valor_pago), 2) caixa
      from public.pagamentos p
      join public.alunos al on al.id = p.aluno_id
      left join boletos_nossos bn
             on bn.b = regexp_replace(coalesce(p.numero_parcela_completo,''), '\D', '', 'g')
     where bn.b is null
     group by 1
  ),
  -- acordo cancelado que perdeu o vínculo: a data de criação casa com a
  -- liquidação do título no Prime (±7 dias) — foi ele que negociou aquilo
  cancelado_solto as (
    select lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') cpf,
           array_agg(a.criado_em::date) datas
      from public.acordos a
     where a.status = 'CANCELADO'
       and not exists (select 1 from public.acordos_titulos x where x.acordo_id = a.id)
       and not exists (select 1 from public.acordo_titulo_vinculo v where v.acordo_id = a.id)
     group by 1
  ),
  -- matrícula 2026/1 anulada e nenhuma confirmada: saída acadêmica, não cobrança
  academico_cpf as (
    select lpad(regexp_replace(coalesce(cpf,''), '\D', '', 'g'), 11, '0') cpf,
           bool_or(status in ('Anulado','Cancelado')
                   and valid_from >= date '2026-01-01' and valid_from < date '2026-07-01') anulado,
           bool_or(status = 'Confirmado'
                   and valid_from >= date '2026-01-01' and valid_from < date '2026-07-01') confirmado
      from public.prime_contratos group by 1
  ),
  base as (
    select b.titulo_id, b.cpf, b.aluno_id, b.documento, b.vencimento, b.entrada_em,
           b.valor_original vo, t.situacao,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo,
           coalesce(t.acordo_id, v.acordo_id) acordo_id,
           s.liq,
           (s.liq is not null and s.liq > b.vencimento + 30 and s.liq >= b.entrada_em) liq_real
      from public.carteira_2026_1_base b
      join public.acordos_titulos t on t.id = b.titulo_id
      left join public.acordo_titulo_vinculo v on v.titulo_id = b.titulo_id and v.ativo
      left join serie s on s.b = regexp_replace(coalesce(b.documento,''), '\D', '', 'g')
  ),
  marcado as (
    select base.*, ac.ratio, ac.estado,
           ((cf.primeiro is not null and cf.primeiro >= base.liq - 30)
            or (cs.datas is not null
                and exists (select 1 from unnest(cs.datas) d where base.liq between d - 7 and d + 7))) origem_provada,
           (cf.cpf is not null) tem_caixa_fora,
           (coalesce(acd.anulado, false) and not coalesce(acd.confirmado, false)) academico
      from base
      left join acordo ac on ac.id = base.acordo_id
      left join caixa_fora cf on cf.cpf = base.cpf
      left join cancelado_solto cs on cs.cpf = base.cpf
      left join academico_cpf acd on acd.cpf = base.cpf
  )
  select
    titulo_id, cpf, aluno_id, documento, vencimento, entrada_em, vo, situacao,
    case when liq is null then 'sem linha no Prime'
         when liq_real then 'liquidado no Prime'
         else 'aberto no Prime' end,
    -- FAIXA (as quatro que fecham 100%)
    case when acordo_id is not null then 'EFETIVIDADE'
         when situacao = 'PAGO' and greatest(vo - saldo, 0) > 0 then 'EFETIVIDADE'
         when liq_real and origem_provada then 'EFETIVIDADE'
         when liq_real and academico then 'ACADEMICO'
         when liq_real then 'EM_VALIDACAO'
         when tem_caixa_fora then 'EM_VALIDACAO'
         else 'INADIMPLENCIA' end,
    -- SUB-FAIXA (qualidade da conversão)
    case when acordo_id is not null then
           case when coalesce(ratio,0) >= 1 then 'Pago / Quitado'
                when estado = 'regular'   then 'Negociado regular'
                when estado = 'atraso'    then 'Negociado em atraso'
                when estado = 'quebrado'  then 'Acordo quebrado'
                when estado = 'cancelado' then 'Acordo cancelado'
                else 'Negociado regular' end
         when situacao = 'PAGO' and greatest(vo - saldo, 0) > 0 then 'Pago / Quitado'
         when liq_real and origem_provada then 'Convertido com origem comprovada'
         when liq_real and academico then 'Baixa/Ajuste academico'
         when liq_real then 'Liquidado no Prime, origem nao comprovada'
         when tem_caixa_fora then 'Aberto no Prime, mas paga acordo fora do CRM'
         else 'Sem pagamento e sem negociacao' end,
    -- VALORES (cada real em uma coluna só; arredonda só no total)
    coalesce(estado, 'sem_acordo'),
    case when acordo_id is not null then vo * coalesce(ratio,0)
         when situacao = 'PAGO' then greatest(vo - saldo, 0) else 0 end,
    case when acordo_id is not null then vo * (1 - coalesce(ratio,0)) else 0 end,
    case when acordo_id is null and liq_real and origem_provada
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when acordo_id is null and liq_real and not origem_provada and not academico
         then (case when situacao = 'PAGO' then saldo else vo end)
         when acordo_id is null and not liq_real and tem_caixa_fora
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when acordo_id is null and liq_real and not origem_provada and academico
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when acordo_id is null and not liq_real and not tem_caixa_fora
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    -- RECUPERAÇÃO FINANCEIRA: só o que virou dinheiro (parcela paga + baixa com
    -- lastro). O caixa de acordo fora do CRM entra à parte, com teto por aluno.
    case when acordo_id is not null then vo * coalesce(ratio,0)
         when situacao = 'PAGO' then greatest(vo - saldo, 0) else 0 end
  from marcado;
$$;
revoke all on function public.carteira_2026_1_classificar() from public, anon, authenticated;

-- --------------------------------------------------- 3. CACHE DO RESULTADO
-- A classificação varre 15 mil títulos contra 389 mil linhas do Prime. A tela
-- lê o cache; recalcular é um clique da gestão (padrão das analíticas).
create table if not exists public.carteira_2026_1_snapshot (
  id bigint generated always as identity primary key,
  dia date not null default (now() at time zone 'America/Sao_Paulo')::date,
  payload jsonb not null,
  gerado_em timestamptz not null default now(),
  gerado_por text
);
create unique index if not exists carteira_2026_1_snapshot_dia_uidx on public.carteira_2026_1_snapshot (dia);
comment on table public.carteira_2026_1_snapshot is
  'Fotografia diária dos indicadores da carteira 2026/1 (curva de evolução da Diretoria).';

alter table public.carteira_2026_1_snapshot enable row level security;
drop policy if exists carteira_2026_1_snapshot_sem_acesso on public.carteira_2026_1_snapshot;
create policy carteira_2026_1_snapshot_sem_acesso on public.carteira_2026_1_snapshot for all using (false);

create or replace function public.carteira_2026_1_pode_ler()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.role(),'') = 'service_role'
      or auth.jwt() is null
      or coalesce(public.usuario_e_gestao(), false)
      or coalesce(public.usuario_e_diretoria(), false);
$$;
revoke all on function public.carteira_2026_1_pode_ler() from public, anon;
grant execute on function public.carteira_2026_1_pode_ler() to authenticated;

create or replace function public.carteira_2026_1_recalcular()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_out jsonb; v_caixa_fora numeric;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  -- Caixa de acordo fora do CRM, confirmado: aluno cuja dívida no CRM é toda
  -- de 2026/1, com título liquidado no Prime, sem outra safra liquidada na
  -- mesma data (assinatura de acordo que pegou 2026/2) e com teto no espaço
  -- ainda não contado. Medido em 11/09: R$ 832.792,15.
  create temp table _c on commit drop as select * from public.carteira_2026_1_classificar();

  with por_aluno as (
    select c.aluno_id, sum(c.valor_original) base_2026_1,
           sum(c.ef_pago) + sum(case when c.acordo_estado in ('regular','atraso') then c.ef_negociado else 0 end) ja_contado,
           bool_or(c.estado_prime = 'liquidado no Prime') tem_liquidacao
      from _c c where c.aluno_id is not null group by 1
  ),
  base_total as (
    select t.aluno_id, sum(t.valor_original) total
      from public.acordos_titulos t where t.situacao <> 'DUPLICADA' group by 1
  ),
  liq_datas as (
    select b.aluno_id, s.liq dia
      from public.carteira_2026_1_base b
      join public.acordos_titulos t on t.id = b.titulo_id
      join (select regexp_replace(coalesce(boleto,''),'\D','','g') bo, max(liquidado_em) liq
              from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1) s
        on s.bo = regexp_replace(coalesce(b.documento,''),'\D','','g')
     where s.liq is not null and s.liq > b.vencimento + 30 and s.liq >= b.entrada_em
     group by 1,2
  ),
  outra_safra as (
    select distinct ld.aluno_id
      from liq_datas ld
      join public.alunos al on al.id = ld.aluno_id
      join public.prime_titulo_semestre ts
        on regexp_replace(coalesce(ts.cpf,''),'\D','','g') = regexp_replace(coalesce(al.cpf,''),'\D','','g')
     where ts.semestre <> '2026/1' and ts.liquidado_em = ld.dia
       and ts.liquidado_em >= date '2026-07-01'
  ),
  boletos_nossos as (
    select distinct regexp_replace(coalesce(boleto,''),'\D','','g') b
      from public.parcelas where boleto is not null
  ),
  caixa as (
    select p.aluno_id, sum(p.valor_pago) caixa
      from public.pagamentos p
      left join boletos_nossos bn on bn.b = regexp_replace(coalesce(p.numero_parcela_completo,''),'\D','','g')
     where bn.b is null and p.aluno_id is not null
     group by 1
  )
  select round(coalesce(sum(least(ca.caixa, greatest(pa.base_2026_1 - pa.ja_contado, 0))), 0), 2)
    into v_caixa_fora
    from por_aluno pa
    join caixa ca on ca.aluno_id = pa.aluno_id
    join base_total bt on bt.aluno_id = pa.aluno_id
    left join outra_safra os on os.aluno_id = pa.aluno_id
   where pa.tem_liquidacao and os.aluno_id is null
     and abs(bt.total - pa.base_2026_1) < 0.01;

  select jsonb_build_object(
    'gerado_em', now(),
    'base', jsonb_build_object(
      'valor', round(sum(valor_original),2),
      'titulos', count(*),
      'cpfs', count(distinct cpf),
      'congelada_em', (select max(congelado_em) from public.carteira_2026_1_base),
      'entrada_de', (select min(entrada_em) from public.carteira_2026_1_base),
      'entrada_ate', (select max(entrada_em) from public.carteira_2026_1_base),
      'por_vencimento_sem_serie', (select count(*) from public.carteira_2026_1_base where origem_semestre = 'vencimento')
    ),
    'faixas', jsonb_build_object(
      'efetividade',   round(sum(ef_pago + ef_negociado + ef_convertido),2),
      'inadimplencia', round(sum(inadimplencia),2),
      'em_validacao',  round(sum(em_validacao),2),
      'academico',     round(sum(academico),2)
    ),
    -- composição POR VALOR: um título de acordo parcial tem parte em "pago" e
    -- parte em "negociado" — agrupar pelo título jogaria os dois na mesma linha.
    'composicao', jsonb_build_array(
      jsonb_build_object('sub_faixa','Pago / Quitado','valor', round(sum(ef_pago),2),
                         'titulos', count(*) filter (where ef_pago > 0)),
      jsonb_build_object('sub_faixa','Negociado regular','valor',
                         round(sum(case when acordo_estado in ('regular','quitado') then ef_negociado else 0 end),2),
                         'titulos', count(*) filter (where acordo_estado in ('regular','quitado') and ef_negociado > 0)),
      jsonb_build_object('sub_faixa','Negociado em atraso (ate 30 dias)','valor',
                         round(sum(case when acordo_estado = 'atraso' then ef_negociado else 0 end),2),
                         'titulos', count(*) filter (where acordo_estado = 'atraso' and ef_negociado > 0)),
      jsonb_build_object('sub_faixa','Acordo quebrado (acima de 30 dias)','valor',
                         round(sum(case when acordo_estado = 'quebrado' then ef_negociado else 0 end),2),
                         'titulos', count(*) filter (where acordo_estado = 'quebrado' and ef_negociado > 0)),
      jsonb_build_object('sub_faixa','Acordo cancelado','valor',
                         round(sum(case when acordo_estado = 'cancelado' then ef_negociado else 0 end),2),
                         'titulos', count(*) filter (where acordo_estado = 'cancelado' and ef_negociado > 0)),
      jsonb_build_object('sub_faixa','Convertido com origem comprovada','valor', round(sum(ef_convertido),2),
                         'titulos', count(*) filter (where ef_convertido > 0))
    ),
    'recuperacao', jsonb_build_object(
      'parcelas_e_baixas', round(sum(recuperacao_financeira),2),
      'caixa_acordo_fora_do_crm', v_caixa_fora,
      'total', round(sum(recuperacao_financeira),2) + v_caixa_fora
    ),
    'cpfs', jsonb_build_object(
      'convertido_total', (select count(*) from (select cpf from _c group by cpf
          having sum(inadimplencia + em_validacao + academico) <= 0.01) a),
      'parcial', (select count(*) from (select cpf from _c group by cpf
          having sum(ef_pago + ef_negociado + ef_convertido) > 0.01
             and sum(inadimplencia + em_validacao + academico) > 0.01) a),
      'zero_conversao', (select count(*) from (select cpf from _c group by cpf
          having sum(ef_pago + ef_negociado + ef_convertido) <= 0.01) a),
      'inadimplentes', (select count(distinct cpf) from _c where inadimplencia > 0)
    ),
    'titulos_inadimplentes', (select count(*) from _c where inadimplencia > 0)
  ) into v_out from _c;

  insert into public.carteira_2026_1_snapshot (payload, gerado_por)
  values (v_out, coalesce(auth.jwt() ->> 'email', 'sistema'))
  on conflict (dia) do update set payload = excluded.payload, gerado_em = now(),
                                  gerado_por = excluded.gerado_por;
  return v_out;
end; $$;
revoke all on function public.carteira_2026_1_recalcular() from public, anon;
grant execute on function public.carteira_2026_1_recalcular() to authenticated;

-- ------------------------------------------------------- 4. LEITURA DA TELA
create or replace function public.carteira_2026_1_indicadores()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  select payload || jsonb_build_object('gerado_por', gerado_por, 'dia', dia)
    into v_out from public.carteira_2026_1_snapshot order by dia desc limit 1;
  return coalesce(v_out, jsonb_build_object('vazio', true));
end; $$;
revoke all on function public.carteira_2026_1_indicadores() from public, anon;
grant execute on function public.carteira_2026_1_indicadores() to authenticated;

-- Curva de evolução (a Diretoria vê a mesma carteira andando no tempo).
create or replace function public.carteira_2026_1_evolucao()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'dia', dia,
           'base', (payload->'base'->>'valor')::numeric,
           'efetividade', (payload->'faixas'->>'efetividade')::numeric,
           'inadimplencia', (payload->'faixas'->>'inadimplencia')::numeric,
           'em_validacao', (payload->'faixas'->>'em_validacao')::numeric,
           'recuperacao', (payload->'recuperacao'->>'total')::numeric
         ) order by dia), '[]'::jsonb)
    into v_out from public.carteira_2026_1_snapshot;
  return v_out;
end; $$;
revoke all on function public.carteira_2026_1_evolucao() from public, anon;
grant execute on function public.carteira_2026_1_evolucao() to authenticated;

-- --------------------------------------------------- 5. DETALHE AUDITÁVEL
-- Clicar na faixa abre os títulos que a compõem. CPF mascarado: a Diretoria
-- precisa identificar o caso, não colecionar documento (premissa de LGPD).
create or replace function public.carteira_2026_1_detalhe(
  p_faixa text, p_sub_faixa text default null, p_limite int default 200, p_offset int default 0
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
-- VOLATILE de propósito: monta temp table, e função STABLE não pode criar uma.
declare v_out jsonb; v_total int; v_valor numeric;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  p_limite := least(greatest(coalesce(p_limite, 200), 1), 500);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  drop table if exists _cls;
  create temp table _cls on commit drop as
    select * from public.carteira_2026_1_classificar()
     where faixa = upper(coalesce(p_faixa, 'EFETIVIDADE'))
       and (p_sub_faixa is null or sub_faixa = p_sub_faixa);

  select count(*), round(coalesce(sum(ef_pago + ef_negociado + ef_convertido
                        + em_validacao + academico + inadimplencia),0), 2)
    into v_total, v_valor from _cls;

  select coalesce(jsonb_agg(jsonb_build_object(
           'aluno', coalesce(al.nome, '(sem nome)'),
           'cpf', case when length(c.cpf) = 11
                       then substr(c.cpf,1,3) || '.***.' || substr(c.cpf,7,3) || '-**' else '***' end,
           'documento', c.documento,
           'vencimento', c.vencimento,
           'entrada_em', c.entrada_em,
           'valor_original', round(c.valor_original,2),
           'situacao_crm', c.situacao_crm,
           'estado_prime', c.estado_prime,
           'sub_faixa', c.sub_faixa,
           'valor_na_faixa', round(c.ef_pago + c.ef_negociado + c.ef_convertido
                                   + c.em_validacao + c.academico + c.inadimplencia, 2)
         ) order by c.valor_original desc), '[]'::jsonb)
    into v_out
    from (select * from _cls order by valor_original desc limit p_limite offset p_offset) c
    left join public.alunos al on al.id = c.aluno_id;

  return jsonb_build_object('faixa', upper(coalesce(p_faixa,'EFETIVIDADE')), 'sub_faixa', p_sub_faixa,
                            'total_titulos', v_total, 'total_valor', v_valor,
                            'limite', p_limite, 'offset', p_offset, 'linhas', v_out);
end; $$;
revoke all on function public.carteira_2026_1_detalhe(text,text,int,int) from public, anon;
grant execute on function public.carteira_2026_1_detalhe(text,text,int,int) to authenticated;

-- Primeira fotografia.
select public.carteira_2026_1_recalcular();

commit;
