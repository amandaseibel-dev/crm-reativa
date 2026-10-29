-- EFETIVIDADE 2026/2 POR BORDERÔ
--
-- Recorte novo sobre dado que já existe: o mesmo universo de títulos que
-- `carteira_2026_2_negociacoes()` e `carteira_2026_2_contexto()` já leem, agora
-- quebrado pelo BORDERÔ de entrada e classificado pela MESMA régua de
-- efetividade de `carteira_2026_1_classificar()`.
--
-- NADA é recalculado nem reescrito. Três funções de leitura, zero DDL de tabela,
-- zero trigger, zero backfill.
--
-- SEMESTRE DO TÍTULO — regra oficial, idêntica à que já está em produção nas
-- duas RPCs de 2026/2 (não inventada aqui):
--     semestre = coalesce(
--        prime_titulo_semestre.semestre  (casado por boleto ↔ documento, só dígitos),
--        case when vencimento ∈ [2026-07-01, 2027-01-01) then '2026/2' end)
--   + situacao <> 'DUPLICADA'          (título duplicado não entra)
--   + coalesce(tipo_boleto,'') <> 'Acordo'   (evita contar o acordo e a origem)
-- NUNCA por data de importação e NUNCA por `alunos.semestre_divida` — este
-- rotula o aluno inteiro pelo vencimento mais recente e está nulo em 36% da
-- base (docs/REGRA-SALDO-COBRAVEL.md §6). A classificação é DO TÍTULO.
--
-- ENTRADA = entrada na carteira de cobrança (o borderô que trouxe o título),
-- nunca entrada financeira de acordo.
--
-- SOMENTE DÍGITOS: as funções de 2026/2 já em produção escrevem o mesmo recorte
-- com uma classe de escape. Aqui está '[^0-9]', que é exatamente a mesma coisa,
-- escrito sem contrabarra: contrabarra em texto de migration já chegou dobrada
-- ao banco por escape de ferramenta, e dobrada ela para de casar dígito nenhum
-- -- sem erro, com o resultado errado.
--
-- CANCELADO ≠ ACORDO CANCELADO. São dois conceitos e ficam em campos separados:
--   cancelado          = a COBRANÇA do título saiu (situacao = 'CANCELADA')
--   acordos_cancelados = o ACORDO caiu; o título continua na carteira e o valor
--                        já convertido continua convertido (conversão é
--                        histórica — igual à régua de 2026/1)

-- ---------------------------------------------------------------------------
-- 1. CLASSIFICADOR — uma linha por título de 2026/2, com o borderô de entrada.
--    Fonte única: as duas funções abaixo só leem daqui.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_2_bordero_classificar()
returns table (
  titulo_id uuid, aluno_id uuid, cpf text, documento text, vencimento date,
  valor_original numeric, situacao_crm text,
  importacao_id uuid, bordero_ref text, bordero_arquivo text, bordero_entrada date,
  acordo_id uuid, acordo_numero text, acordo_estado text,
  faixa text, sub_faixa text,
  recuperado numeric, saldo numeric, liquidado_total boolean,
  fonte_semestre text, motivo_cancelamento text
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
    c.id, c.aluno_id, c.cpf, c.documento, c.vencimento, round(c.vo,2), c.situacao,
    c.importacao_id, i.referencia, i.arquivo_nome, i.created_at::date,
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
    -- Saldo a recuperar: o que falta do valor original. Título cancelado saiu da
    -- carteira, então não tem saldo a recuperar.
    case when c.fora_da_base then 0 else round(greatest(c.vo - c.recuperado, 0), 2) end,
    (not c.fora_da_base and c.recuperado >= round(c.vo,2) - 0.005),
    case when c.sem_serie then 'vencimento (sem série no Prime)' else 'série do Prime' end,
    case when c.fora_da_base
         then coalesce(nullif(c.origem_encerramento,''), 'Sem motivo registrado') end
  from classificado c
  left join public.importacoes i on i.id = c.importacao_id;
$function$;

comment on function public.carteira_2026_2_bordero_classificar() is
'Efetividade 2026/2 título a título, com o borderô de entrada. Semestre pelo título (série do Prime, fallback vencimento), régua de faixas idêntica a carteira_2026_1_classificar. Só leitura.';

-- ---------------------------------------------------------------------------
-- 2. PAINEL — totais do semestre + um bloco por borderô.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_2_borderos()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with c as (select * from public.carteira_2026_2_bordero_classificar()),
  agregado as (
    select
      importacao_id, bordero_ref, bordero_arquivo, bordero_entrada,
      count(*) titulos,
      count(distinct aluno_id) alunos,
      round(sum(valor_original),2) valor_original,
      round(sum(recuperado),2) recuperado,
      count(*) filter (where recuperado > 0) titulos_com_pagamento,
      count(*) filter (where liquidado_total) titulos_liquidados,
      count(*) filter (where faixa = 'CONVERTIDO') convertido_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'CONVERTIDO'),0),2) convertido_valor,
      count(*) filter (where faixa = 'EM_CONFERENCIA') conferencia_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'EM_CONFERENCIA'),0),2) conferencia_valor,
      count(*) filter (where faixa = 'ACADEMICO') academico_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'ACADEMICO'),0),2) academico_valor,
      count(*) filter (where faixa = 'SEM_NEGOCIACAO') sem_negociacao_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'SEM_NEGOCIACAO'),0),2) sem_negociacao_valor,
      count(*) filter (where faixa = 'CANCELADO') cancelado_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'CANCELADO'),0),2) cancelado_valor,
      count(distinct acordo_id) filter (where acordo_estado = 'cancelado') acordos_cancelados,
      round(coalesce(sum(valor_original) filter (where acordo_estado = 'cancelado'),0),2) acordos_cancelados_valor,
      count(*) filter (where saldo > 0) saldo_titulos,
      round(coalesce(sum(saldo),0),2) saldo_valor,
      count(*) filter (where fonte_semestre <> 'série do Prime') fallback_titulos,
      round(coalesce(sum(valor_original) filter (where fonte_semestre <> 'série do Prime'),0),2) fallback_valor
    from c group by 1,2,3,4
  ),
  -- Cancelamento de COBRANÇA por motivo (origem_encerramento). Não confundir
  -- com acordo cancelado, que tem campo próprio em cada bloco.
  motivos as (
    select motivo_cancelamento motivo, count(*) titulos,
           round(sum(valor_original),2) valor
      from c where faixa = 'CANCELADO' group by 1
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'semestre', '2026/2',
    'atualizado_em', jsonb_build_object(
      'prime_coletado_em', (select max(coletado_em) from public.prime_titulo_semestre),
      'ultimo_bordero',    (select max(bordero_entrada) from agregado),
      'titulo_mexido_em',  (select max(t.atualizado_em) from public.acordos_titulos t
                             where t.id in (select titulo_id from c))
    ),
    'total', (
      select jsonb_build_object(
        'borderos', count(*) filter (where importacao_id is not null),
        'titulos', sum(titulos), 'alunos', (select count(distinct aluno_id) from c),
        'valor_original', round(sum(valor_original),2),
        'recuperado', round(sum(recuperado),2),
        'titulos_com_pagamento', sum(titulos_com_pagamento),
        'titulos_liquidados', sum(titulos_liquidados),
        'convertido_titulos', sum(convertido_titulos), 'convertido_valor', round(sum(convertido_valor),2),
        'conferencia_titulos', sum(conferencia_titulos), 'conferencia_valor', round(sum(conferencia_valor),2),
        'academico_titulos', sum(academico_titulos), 'academico_valor', round(sum(academico_valor),2),
        'sem_negociacao_titulos', sum(sem_negociacao_titulos),
        'sem_negociacao_valor', round(sum(sem_negociacao_valor),2),
        'cancelado_titulos', sum(cancelado_titulos), 'cancelado_valor', round(sum(cancelado_valor),2),
        'acordos_cancelados', (select count(distinct acordo_id) from c where acordo_estado = 'cancelado'),
        'acordos_cancelados_valor', round(sum(acordos_cancelados_valor),2),
        'saldo_titulos', sum(saldo_titulos), 'saldo_valor', round(sum(saldo_valor),2),
        'fallback_titulos', sum(fallback_titulos), 'fallback_valor', round(sum(fallback_valor),2)
      ) from agregado
    ),
    'cancelados_por_motivo', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'motivo', motivo, 'titulos', titulos, 'valor', valor) order by valor desc), '[]'::jsonb)
        from motivos
    ),
    'borderos', (
      select coalesce(jsonb_agg(to_jsonb(a) order by a.bordero_entrada desc nulls last,
                                            a.valor_original desc), '[]'::jsonb)
        from agregado a
    )
  ) into v_out;

  return v_out;
end; $function$;

comment on function public.carteira_2026_2_borderos() is
'Painel Efetividade 2026/2 por borderô: totais do semestre e um bloco por borderô. Só leitura, gestão + diretoria.';

-- ---------------------------------------------------------------------------
-- 3. DETALHE — os títulos que compõem um indicador de um borderô (ou de todos).
--    CPF mascarado, igual às outras RPCs desta área.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_2_bordero_detalhe(
  p_importacao_id uuid default null,
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
declare v_out jsonb; v_ind text;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  p_limite := least(greatest(coalesce(p_limite,200),1), 500);
  p_offset := greatest(coalesce(p_offset,0), 0);
  v_ind := lower(coalesce(nullif(p_indicador,''), 'entradas'));
  if v_ind not in ('entradas','recuperado','liquidados','convertido','em_conferencia',
                   'academico','sem_negociacao','cancelado','acordos_cancelados','saldo') then
    raise exception 'Indicador desconhecido: %', p_indicador using errcode = '22023';
  end if;

  -- Um único CTE alimenta a contagem e a página: o classificador roda uma vez.
  with filtrado as (
    select c.* from public.carteira_2026_2_bordero_classificar() c
     where (p_importacao_id is null or c.importacao_id = p_importacao_id)
       and case v_ind
             when 'entradas'           then true
             when 'recuperado'         then c.recuperado > 0
             when 'liquidados'         then c.liquidado_total
             when 'convertido'         then c.faixa = 'CONVERTIDO'
             when 'em_conferencia'     then c.faixa = 'EM_CONFERENCIA'
             when 'academico'          then c.faixa = 'ACADEMICO'
             when 'sem_negociacao'     then c.faixa = 'SEM_NEGOCIACAO'
             when 'cancelado'          then c.faixa = 'CANCELADO'
             when 'acordos_cancelados' then c.acordo_estado = 'cancelado'
             when 'saldo'              then c.saldo > 0
           end
  ),
  -- O total do rodapé soma a MESMA grandeza do card clicado, nunca outra.
  resumo as (
    select count(*) titulos,
           round(coalesce(sum(case v_ind when 'recuperado' then recuperado
                                         when 'saldo'      then saldo
                                         else valor_original end),0),2) valor
      from filtrado
  ),
  pagina as (
    select * from filtrado order by valor_original desc limit p_limite offset p_offset
  )
  select jsonb_build_object(
    'indicador', v_ind,
    'importacao_id', p_importacao_id,
    'total_titulos', (select titulos from resumo),
    'total_valor',   (select valor   from resumo),
    'limite', p_limite, 'offset', p_offset,
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'aluno', coalesce(al.nome, '(sem nome)'),
               'cpf', case when length(z.cpf) = 11
                           then substr(z.cpf,1,3) || '.***.' || substr(z.cpf,7,3) || '-**' else '***' end,
               'documento', z.documento,
               'vencimento', z.vencimento,
               'valor_original', z.valor_original,
               'bordero', coalesce(z.bordero_ref, '(sem borderô)'),
               'acordo', coalesce(z.acordo_numero, '(sem número)'),
               'acordo_estado', z.acordo_estado,
               'situacao', z.sub_faixa,
               'recuperado', z.recuperado,
               'saldo', z.saldo,
               'motivo_cancelamento', z.motivo_cancelamento,
               'fonte_semestre', z.fonte_semestre
             ) order by z.valor_original desc)
        from pagina z left join public.alunos al on al.id = z.aluno_id
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end; $function$;

comment on function public.carteira_2026_2_bordero_detalhe(uuid, text, integer, integer) is
'Títulos que compõem um indicador da Efetividade 2026/2 por borderô. CPF mascarado. Só leitura, gestão + diretoria.';

-- Gestão e diretoria pela porta normal do app; a autorização real está dentro
-- das funções (carteira_2026_1_pode_ler), como nas demais RPCs desta área.
revoke all on function public.carteira_2026_2_bordero_classificar() from public;
revoke all on function public.carteira_2026_2_borderos() from public;
revoke all on function public.carteira_2026_2_bordero_detalhe(uuid, text, integer, integer) from public;
grant execute on function public.carteira_2026_2_bordero_classificar() to authenticated, service_role;
grant execute on function public.carteira_2026_2_borderos() to authenticated, service_role;
grant execute on function public.carteira_2026_2_bordero_detalhe(uuid, text, integer, integer) to authenticated, service_role;
