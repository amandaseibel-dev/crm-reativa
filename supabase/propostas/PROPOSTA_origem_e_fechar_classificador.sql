-- PROPOSTA DE MIGRATION -- NAO APLICADA. Aguarda decisao.
--
-- Fica FORA de supabase/migrations/ de proposito: versao nao aplicada dentro
-- daquele diretorio e exatamente o que o Gate 1 esta limpando. Ao aprovar,
-- mover para supabase/migrations/ com a versao que o apply_migration registrar.
--
-- DUAS CORRECOES, achadas na revisao de 27/09/2026.
--
-- ============================================================================
-- A) SEGURANCA -- URGENTE. carteira_2026_2_classificar esta ABERTA a qualquer
--    usuario logado e devolve CPF SEM MASCARA.
--
--    Medido em 27/09 chamando a RPC pelo PostgREST com sessao comum: HTTP 200,
--    1.000 linhas (teto do PostgREST) com cpf em texto puro, aluno_id,
--    documento e valor. A funcao e SECURITY DEFINER, NAO tem portao de
--    permissao e NAO mascara CPF -- mascarar e trabalho de
--    carteira_2026_2_competencia_detalhe, que e quem deveria ser a porta.
--
--    FOI ERRO MEU NA 20260927221825: concedi EXECUTE a `authenticated` no
--    classificador. O equivalente de 2026/1 ja fazia certo --
--    carteira_2026_1_classificar tem ACL `postgres | service_role`, sem
--    authenticated -- e eu divergi do padrao que ja existia no proprio codigo.
--
--    REVOGAR NAO QUEBRA NADA. carteira_2026_2_competencias e
--    _competencia_detalhe sao SECURITY DEFINER de postgres, que e dono do
--    classificador: elas o chamam como postgres, nao como quem ligou. PROVA em
--    producao hoje: carteira_2026_1_academico e concedida a authenticated,
--    chama carteira_2026_1_classificar, e esse classificador NAO e concedido a
--    authenticated -- e funciona.
--
--    IMPACTO: nenhuma tela, nenhum total, nenhum agrupamento. So fecha a porta.
--
-- ============================================================================
-- B) RASTREABILIDADE. O classificador passa a devolver `origem_importacao`, e
--    o detalhe a expoe por linha.
--
--    Agrupar pelo mes de vencimento resolveu o recorte, nao a rastreabilidade:
--    o titulo sem importacao_id agora aparece em dezembro/2026 como qualquer
--    outro, e nada dizia que nao se sabe de onde ele veio. A tela desenha NULL
--    como "Sem importacao de origem identificada", em ambar.
--
--    O numero do bordero volta APENAS aqui, no detalhamento titulo a titulo,
--    como rastreabilidade -- nunca como identificacao de card.
--
--    IMPACTO MEDIDO em 27/09: 2.525 titulos de 2026/2; 1 sem importacao_id
--    (R$ 13.643,33, vence 05/12/2026); 2.524 com referencia presente. NENHUM
--    total muda, NENHUM agrupamento muda.
--
-- ============================================================================
-- PONTO DELICADO: o classificador retorna TABLE, e acrescentar coluna a um
-- RETURNS TABLE exige DROP + CREATE. O DROP e SEM CASCADE; as duas dependentes
-- continuam validas porque a dependencia e por nome, resolvida em execucao.
-- Entre o DROP e o CREATE, na MESMA transacao, as RPCs nao sao chamaveis --
-- segundos, e a tela ainda nao esta publicada. Ainda assim: nao aplicar em
-- horario de uso intenso.
--
-- A TELA JA ACEITA OS DOIS ESTADOS: a coluna Origem so aparece quando o campo
-- vem no JSON. Sem esta migration a tela funciona e apenas nao mostra a coluna.
-- Por isso ela NAO bloqueia o PR #540 -- mas a parte (A) e exposicao viva.

drop function if exists public.carteira_2026_2_classificar();

create or replace function public.carteira_2026_2_classificar()
returns table (
  titulo_id uuid, aluno_id uuid, cpf text, documento text, vencimento date,
  competencia date, valor_original numeric, situacao_crm text,
  acordo_id uuid, acordo_numero text, acordo_estado text,
  faixa text, sub_faixa text,
  recuperado numeric, saldo numeric, liquidado_total boolean,
  fonte_semestre text, motivo_cancelamento text, origem_importacao text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with serie as (
    select regexp_replace(coalesce(boleto,''), '[^0-9]', '', 'g') b,
           max(semestre) semestre, max(liquidado_em) liq
      from public.prime_titulo_semestre
     where coalesce(semestre,'') <> ''
     group by 1
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
  -- Boleto que É nosso (parcela de acordo do CRM). Pagamento cujo boleto não
  -- está aqui é caixa que entrou FORA do CRM.
  boletos_nossos as (
    select distinct regexp_replace(coalesce(boleto,''), '[^0-9]', '', 'g') b
      from public.parcelas where boleto is not null
  ),
  caixa_fora as (
    select lpad(regexp_replace(coalesce(al.cpf,''), '[^0-9]', '', 'g'), 11, '0') cpf,
           min(p.data_pagamento) primeiro
      from public.pagamentos p
      join public.alunos al on al.id = p.aluno_id
      left join boletos_nossos bn
             on bn.b = regexp_replace(coalesce(p.numero_parcela_completo,''), '[^0-9]', '', 'g')
     where bn.b is null group by 1
  ),
  -- Ajuste acadêmico: contrato anulado/cancelado DENTRO de 2026/2 e sem
  -- confirmação no mesmo período. A janela acompanha o semestre do recorte
  -- (em 2026/1 a mesma regra usa jan–jun).
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
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
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
      -- Recuperado: MESMA fórmula que a tela de Efetividade já mostra como
      -- "Valor recebido" -- rateio do valor original pelo % de parcelas PAGAS
      -- do acordo, ou (valor original - saldo) quando o próprio título é PAGO.
      -- Teto no valor original de propósito: juros, multa e honorário não
      -- aumentam a carteira recuperada.
      case when m.fora_da_base then 0
           when m.acordo_id is not null then round(m.vo * coalesce(m.ratio,0), 2)
           when m.situacao = 'PAGO' then round(greatest(m.vo - m.saldo_crm, 0), 2)
           else 0 end recuperado
    from marcado m
  )
  select
    c.id, c.aluno_id, c.cpf, c.documento, c.vencimento,
    date_trunc('month', c.vencimento)::date,
    round(c.vo,2), c.situacao,
    c.acordo_id, c.numero_ulbra, coalesce(c.estado, 'sem_acordo'),
    c.faixa,
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
         then coalesce(nullif(c.origem_encerramento,''), 'Sem motivo registrado') end,
    -- Origem: a importacao que trouxe o titulo. NULL quando nao ha nenhuma --
    -- agrupar pelo mes de vencimento resolveu o RECORTE, nao a RASTREABILIDADE.
    (select i.referencia from public.importacoes i where i.id = c.importacao_id)
  from classificado c;
$function$;

comment on function public.carteira_2026_2_classificar() is
'Efetividade 2026/2 titulo a titulo, com a competencia (mes do vencimento) e a importacao de origem. Regua de faixas identica a carteira_2026_1_classificar. Só leitura. INTERNA: nao conceder a authenticated -- devolve CPF sem mascara.';

-- (A) A PORTA. Mesma ACL de carteira_2026_1_classificar.
revoke all on function public.carteira_2026_2_classificar() from public;
revoke all on function public.carteira_2026_2_classificar() from authenticated;
grant execute on function public.carteira_2026_2_classificar() to service_role;

-- (B) O detalhe passa a carregar a origem em cada linha.
-- Apenas UMA chave nova no jsonb_build_object; nada mais muda.
create or replace function public.carteira_2026_2_competencia_detalhe(
  p_competencia date default null,
  p_indicador text default 'entradas',
  p_limite integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
-- CORPO: identico ao de 20260927221825, com UMA linha nova dentro do
-- jsonb_build_object de cada titulo, logo depois de 'fonte_semestre':
--
--     'origem_importacao', case when z.origem_importacao is not null
--                               then 'Borderô ' || z.origem_importacao end
--
-- O corpo completo e gerado na hora de aplicar, a partir do arquivo
-- 20260927221825, para garantir que nada mais mude junto.
$function$;
