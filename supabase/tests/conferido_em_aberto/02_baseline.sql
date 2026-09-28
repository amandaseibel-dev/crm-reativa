-- ESTADO INICIAL: o classificador e o detalhe COMO ESTAO EM PRODUCAO em
-- 28/09/2026, mais o revoke da versao 20260927224458.
--
-- A proposta e aplicada POR CIMA disto. Sem este arquivo o teste estaria
-- medindo uma reescrita contra o vazio, e nao a mudanca real.
\set ON_ERROR_STOP on

create or replace function public.carteira_2026_2_classificar()
returns table(titulo_id uuid, aluno_id uuid, cpf text, documento text, vencimento date,
              competencia date, valor_original numeric, situacao_crm text, acordo_id uuid,
              acordo_numero text, acordo_estado text, faixa text, sub_faixa text,
              recuperado numeric, saldo numeric, liquidado_total boolean, fonte_semestre text,
              motivo_cancelamento text)
language sql stable security definer set search_path to 'public'
as $function$
  with serie as (
    select regexp_replace(coalesce(boleto,''), '[^0-9]', '', 'g') b,
           max(semestre) semestre, max(liquidado_em) liq
      from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
  ),
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas,
           count(*) filter (where status = 'VENCIDA' and vencimento >= current_date - 30) venc_ate30,
           count(*) filter (where status = 'VENCIDA' and vencimento <  current_date - 30) venc_mais30
      from public.parcelas group by 1
  ),
  acordo as (
    select a.id, a.numero_ulbra, a.status,
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
  boletos_nossos as (
    select distinct regexp_replace(coalesce(boleto,''), '[^0-9]', '', 'g') b
      from public.parcelas where boleto is not null
  ),
  caixa_fora as (
    select lpad(regexp_replace(coalesce(al.cpf,''), '[^0-9]', '', 'g'), 11, '0') cpf,
           min(p.data_pagamento) primeiro
      from public.pagamentos p join public.alunos al on al.id = p.aluno_id
      left join boletos_nossos bn
             on bn.b = regexp_replace(coalesce(p.numero_parcela_completo,''), '[^0-9]', '', 'g')
     where bn.b is null group by 1
  ),
  academico_cpf as (
    select lpad(regexp_replace(coalesce(cpf,''), '[^0-9]', '', 'g'), 11, '0') cpf,
           bool_or(status in ('Anulado','Cancelado')
                   and valid_from >= date '2026-07-01' and valid_from < date '2027-01-01') anulado,
           bool_or(status = 'Confirmado'
                   and valid_from >= date '2026-07-01' and valid_from < date '2027-01-01') confirmado
      from public.prime_contratos group by 1
  ),
  base as (
    select t.id, t.aluno_id,
           lpad(regexp_replace(coalesce(t.cpf,''), '[^0-9]', '', 'g'), 11, '0') cpf,
           t.documento, t.vencimento, t.valor_original vo, t.situacao,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo_crm,
           t.importacao_id, t.created_at::date entrada_em, t.origem_encerramento,
           coalesce(t.acordo_id, v.acordo_id) acordo_id, s.liq,
           (s.semestre is null) sem_serie,
           (upper(coalesce(t.situacao,'')) = 'CANCELADA') fora_da_base
      from public.acordos_titulos t
      left join serie s on s.b = regexp_replace(coalesce(t.documento,''), '[^0-9]', '', 'g')
      left join public.acordo_titulo_vinculo v on v.titulo_id = t.id and v.ativo
     where t.situacao <> 'DUPLICADA' and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and coalesce(s.semestre,
             case when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01'
                  then '2026/2' end) = '2026/2'
  ),
  marcado as (
    select b.*, ac.numero_ulbra, ac.status acordo_status, ac.ratio, ac.estado,
           (b.liq is not null and b.liq > b.vencimento + 30 and b.liq >= b.entrada_em) liq_real,
           (b.liq is null) sem_linha,
           (cf.primeiro is not null and cf.primeiro >= b.liq - 30) origem_provada,
           (cf.cpf is not null) tem_caixa_fora,
           (coalesce(acd.anulado, false) and not coalesce(acd.confirmado, false)) academico
      from base b
      left join acordo ac on ac.id = b.acordo_id
      left join caixa_fora cf on cf.cpf = b.cpf
      left join academico_cpf acd on acd.cpf = b.cpf
  ),
  classificado as (
    select m.*,
      case when m.fora_da_base then 'CANCELADO'
           when m.acordo_id is not null then 'CONVERTIDO'
           when m.situacao = 'PAGO' and greatest(m.vo - m.saldo_crm, 0) > 0 then 'CONVERTIDO'
           when m.liq_real and m.origem_provada then 'CONVERTIDO'
           when m.liq_real and m.academico then 'ACADEMICO'
           when m.liq_real then 'EM_CONFERENCIA'
           when m.tem_caixa_fora then 'EM_CONFERENCIA'
           when m.sem_linha then 'EM_CONFERENCIA'
           else 'SEM_NEGOCIACAO' end faixa,
      case when m.fora_da_base then 0
           when m.acordo_id is not null then round(m.vo * coalesce(m.ratio,0), 2)
           when m.situacao = 'PAGO' then round(greatest(m.vo - m.saldo_crm, 0), 2)
           else 0 end recuperado
    from marcado m
  )
  select c.id, c.aluno_id, c.cpf, c.documento, c.vencimento,
    date_trunc('month', c.vencimento)::date, round(c.vo,2), c.situacao,
    c.acordo_id, c.numero_ulbra, coalesce(c.estado, 'sem_acordo'), c.faixa,
    case when c.fora_da_base then 'Cobrança cancelada'
         when c.acordo_id is not null then
           case when coalesce(c.ratio,0) >= 1 then 'Pago / Quitado'
                when c.estado = 'regular'   then 'Negociado regular'
                when c.estado = 'atraso'    then 'Negociado em atraso'
                when c.estado = 'quebrado'  then 'Acordo quebrado'
                when c.estado = 'cancelado' then 'Acordo cancelado'
                else 'Negociado regular' end
         when c.situacao = 'PAGO' and greatest(c.vo - c.saldo_crm, 0) > 0 then 'Pago / Quitado'
         when c.liq_real and c.origem_provada then 'Convertido com origem comprovada'
         when c.liq_real and c.academico then 'Baixa / ajuste acadêmico'
         when c.liq_real then 'Liquidado no Prime, origem não comprovada'
         when c.tem_caixa_fora then 'Aberto no Prime, mas paga acordo fora do CRM'
         when c.sem_linha then 'Sem confirmação do Prime (título não encontrado)'
         else 'Sem pagamento e sem negociação' end,
    c.recuperado,
    case when c.fora_da_base then 0 else round(greatest(c.vo - c.recuperado, 0), 2) end,
    (not c.fora_da_base and c.recuperado >= round(c.vo,2) - 0.005),
    case when c.sem_serie then 'vencimento (sem série no Prime)' else 'série do Prime' end,
    case when c.fora_da_base
         then coalesce(nullif(c.origem_encerramento,''), 'Sem motivo registrado') end
  from classificado c;
$function$;

-- Versao 20260927224458, ja em producao: o classificador e fechado para
-- authenticated. E anon nunca teve acesso a nada disto. O teste comeca do
-- estado VERDADEIRO de producao, nao de um mais folgado -- comecar folgado
-- faria a guarda passar por sorte.
revoke execute on function public.carteira_2026_2_classificar() from authenticated;
revoke execute on function public.carteira_2026_2_classificar() from anon;

create or replace function public.carteira_2026_2_competencia_detalhe(
  p_competencia date default null::date, p_indicador text default 'entradas'::text,
  p_limite integer default 200, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_out jsonb; v_ind text; v_comp date;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  v_comp := date_trunc('month', p_competencia)::date;
  v_ind := lower(coalesce(nullif(p_indicador,''), 'entradas'));
  select jsonb_build_object('indicador', v_ind, 'linhas', '[]'::jsonb) into v_out;
  return v_out;
end; $function$;

-- O detalhe e aberto para a gestao logada (authenticated) e fechado para anon,
-- como em producao. A proposta usa CREATE OR REPLACE e tem de PRESERVAR isso.
revoke execute on function public.carteira_2026_2_competencia_detalhe(date,text,integer,integer) from anon;
