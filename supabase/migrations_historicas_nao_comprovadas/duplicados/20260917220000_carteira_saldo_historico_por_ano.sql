-- ============================================================================
-- EFETIVIDADE — 2024 e 2025 passam a ser lidos POR ANO, com a base ajustada
-- ----------------------------------------------------------------------------
-- Amanda, 17/09/2026: "cria na efetividade um agrupamento no saldo 2024 e
-- depois um de 2025 separadamente, e deixa por semestre apenas 2026", "com os
-- casos já ajustados"; e antes disso: "veja se a base de 2024 e 2025 não estão
-- infladas, faça a conferência com o prime".
--
-- A CONFERÊNCIA COM O PRIME (medida em 17/09) MOSTROU QUE ESTAVAM INFLADAS.
-- Partindo das mensalidades originais em aberto do portador 195 (REATIVA
-- RECUPERAÇÃO DE CRÉDITO) com semestre 2024/1..2025/2 — 28.213 títulos /
-- 7.861 alunos / R$ 17.898.363,47 — o que infla NÃO é duplicidade nem acordo
-- do CRM (as duas provas deram zero): é negociação feita direto com a Ulbra,
-- fora do CRM, que aparece só como presença do CPF no portador 166.
--
-- Régua escolhida por ela: a MESMA do relatório 2026/1 (`_relatorio_2026_1_eleg`)
-- e, além dela, fora também qualquer título com liquidação na Prime depois do
-- vencimento + 30 — inclusive a liquidação anterior à entrada no CRM, que era a
-- faixa em dúvida. Resultado: 17.121 títulos / 4.946 alunos / R$ 10.020.167,05.
--
--   camada                                        títulos   alunos        valor
--   critério bruto (só portador + mensalidade)      28.213    7.861   17.898.363,47
--   régua do relatório 2026/1                       18.322    5.257   11.061.762,42
--   régua 2026/1 + sem liquidação na Prime  <=      17.121    4.946   10.020.167,05
--
-- O QUE O 166 PODE E O QUE NÃO PODE PROVAR: a lista do portador existe por CPF,
-- nunca por título (`prime_extrato` não coleta o 166 — por isso `de_acordo`
-- jamais casa, e `recuperacao_historica` tem cpf e aluno_id 100% nulos). Logo a
-- exclusão é por ALUNO e o valor correspondente é TETO de exposição, não prova
-- título a título. Por isso ele não desaparece da tela: sai do saldo em aberto e
-- aparece em linha própria, "negociado direto com a Ulbra, a confirmar".
--
-- DUAS RÉGUAS, DE PROPÓSITO, como manda a metodologia da página:
--   SITUAÇÃO ATUAL (saldo em aberto) = Prime — portador 195 e liquidação, pela
--     coleta MAIS RECENTE de cada boleto entre as duas tabelas espelho.
--   HISTÓRICO (carteira residual, negociado, recebido) = CRM, sem filtro de
--     portador: acordo quebrado devolve a mensalidade ao portador, então filtrar
--     portador no histórico apagaria conversão que aconteceu de verdade.
--
-- SEMESTRE é sempre a SÉRIE de cobrança da Prime (`prime_titulo_semestre`),
-- nunca o mês do vencimento — matrícula antecipada erra o semestre. Aqui NÃO há
-- o fallback por vencimento que a função de semestre usa: quem não tem série
-- fica no bloco `sem_semestre` e não é distribuído por estimativa.
--
-- Mensalidade = tipo_boleto de Graduação (presencial/online/híbrido, inclusive a
-- grafia corrompida "GraduaÁ„o") ou de Pós Lato Sensu. Extensão, tipo "Acordo" e
-- parcela de acordo ficam fora.
--
-- ADITIVA: não altera `carteira_cobertura_historica` (que segue no banco e volta
-- a ser a fonte da tela se esta for revertida). Só leitura.
-- Reversível: drop function public.carteira_saldo_historico_por_ano().
-- ============================================================================
create or replace function public.carteira_saldo_historico_por_ano()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with ex as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b,
           max(portador) portador, max(liquidado_em) liq, max(coletado_em) col
      from public.prime_extrato group by 1
  ),
  ts as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b,
           max(carrier_id) carrier, max(semestre) semestre, max(liquidado_em) liq, max(coletado_em) col
      from public.prime_titulo_semestre group by 1
  ),
  vinc as (select distinct titulo_id from public.acordo_titulo_vinculo),
  parc_boleto as (
    select distinct regexp_replace(boleto, '\D', '', 'g') b
      from public.parcelas where coalesce(boleto,'') <> ''
  ),
  pag_titulo as (
    select distinct regexp_replace(titulo_numero, '\D', '', 'g') b
      from public.pagamentos where coalesce(titulo_numero,'') <> ''
  ),
  m166 as (
    select distinct lpad(regexp_replace(cpf, '\D', '', 'g'), 11, '0') cpf
      from public.prime_portador_membro where portador = 166
  ),
  acordo_ativo as (select distinct aluno_id from public.acordos where status = 'ATIVO' and aluno_id is not null),
  conf as (
    select distinct aluno_id from public.solicitacoes_confirmacao_pagamento
     where status = 'AGUARDANDO_CONFIRMACAO'
  ),
  caso_fora as (
    select distinct aluno_id from public.casos
     where public.normalizar_status_acionamento(coalesce(status_atual, status_acionamento, status_jornada))
           = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'])
  ),
  pago_julho as (
    select aluno_id, sum(valor_pago) pago from public.pagamentos
     where data_pagamento >= date '2026-07-01' and aluno_id is not null group by 1
  ),
  -- Mensalidades de graduação e pós, com a situação atual do boleto na Prime
  -- resolvida pela coleta MAIS RECENTE entre as duas tabelas espelho.
  t as (
    select t.id, t.aluno_id,
           lpad(regexp_replace(coalesce(nullif(t.cpf,''), al.cpf, ''), '\D', '', 'g'), 11, '0') cpf,
           t.valor_original vo,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo,
           t.situacao, t.status, t.vencimento, t.created_at::date entrada, t.origem_liquidacao, t.acordo_id,
           ts.semestre, left(ts.semestre, 4) ano,
           case when ex.col is null then ts.carrier
                when ts.col is null or ex.col >= ts.col then ex.portador
                else ts.carrier end portador,
           case when ex.col is null then ts.liq
                when ts.col is null or ex.col >= ts.col then ex.liq
                else ts.liq end liq,
           (t.acordo_id is not null or v.titulo_id is not null) negociado,
           case
             when t.tipo_boleto ilike 'Cursos de Gradua%Presencial' then 'Graduação Presencial'
             when t.tipo_boleto ilike 'Cursos de Gradua%Online'     then 'Graduação Online'
             when t.tipo_boleto ilike 'Cursos de Gradua%brido'      then 'Graduação Híbrido'
             when t.tipo_boleto ilike 'Cursos de P%s Gradua%'       then 'Pós-Graduação (Lato Sensu)'
           end curso,
           (pb.b is not null) eh_boleto_de_parcela,
           (pg.b is not null) tem_pagamento_no_titulo
      from public.acordos_titulos t
      left join public.alunos al on al.id = t.aluno_id
      left join ts on ts.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
      left join ex on ex.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
      left join vinc v on v.titulo_id = t.id
      left join parc_boleto pb on pb.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
      left join pag_titulo pg on pg.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and (t.tipo_boleto ilike 'Cursos de Gradua%' or t.tipo_boleto ilike 'Cursos de P%s Gradua%')
  ),
  -- Candidatas: mensalidade original em aberto, no portador 195, sem liquidação
  -- na Prime depois do vencimento + 30. Inclui quem não tem série, para o bloco
  -- "sem semestre" nascer da MESMA régua.
  cand as (
    select * from t
     where upper(coalesce(situacao,'')) = 'ABERTO'
       and lower(coalesce(status,'')) = 'em_aberto'
       and not negociado
       and acordo_id is null
       and not eh_boleto_de_parcela
       and not tem_pagamento_no_titulo
       and origem_liquidacao is null
       and saldo > 0
       and portador = 195
       and not coalesce(liq > vencimento + 30, false)
       and (semestre in ('2024/1','2024/2','2025/1','2025/2') or semestre is null)
  ),
  devido as (select aluno_id, sum(saldo) total from cand group by 1),
  cand_marcada as (
    select c.*,
           (m.cpf is not null and aa.aluno_id is null) sai_166,
           (cf.aluno_id is not null) sai_confirmacao,
           (cx.aluno_id is not null) sai_caso,
           (coalesce(pj.pago, 0) >= d.total) sai_pago
      from cand c
      left join m166 m on m.cpf = c.cpf
      left join acordo_ativo aa on aa.aluno_id = c.aluno_id
      left join conf cf on cf.aluno_id = c.aluno_id::text
      left join caso_fora cx on cx.aluno_id = c.aluno_id
      left join devido d on d.aluno_id = c.aluno_id
      left join pago_julho pj on pj.aluno_id = c.aluno_id
  ),
  aberto as (
    select * from cand_marcada
     where not (sai_166 or sai_confirmacao or sai_caso or sai_pago)
  ),
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas
      from public.parcelas group by 1
  ),
  acordo as (
    select a.id,
           case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                when a.status = 'QUITADO' then 1 else 0 end ratio
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  -- Histórico da safra: carteira residual, negociado e recebido. SEM filtro de
  -- portador — conversão é história, e acordo quebrado devolve o título ao
  -- portador; filtrar aqui apagaria conversão que aconteceu de verdade.
  hist as (
    select t.ano,
           count(*) titulos,
           count(distinct t.cpf) cpfs,
           round(sum(t.vo), 2) valor_original,
           round(coalesce(sum(t.vo) filter (where t.negociado), 0), 2) negociado,
           round(coalesce(sum(case when t.negociado then t.vo * coalesce(ac.ratio, 0)
                                   when upper(coalesce(t.situacao,'')) = 'PAGO' then greatest(t.vo - t.saldo, 0)
                                   else 0 end), 0), 2) recebido,
           min(t.entrada) entrada_de, max(t.entrada) entrada_ate
      from t left join acordo ac on ac.id = t.acordo_id
     where t.ano in ('2024','2025')
     group by t.ano
  ),
  coleta as (
    select greatest((select max(coletado_em) from public.prime_extrato),
                    (select max(coletado_em) from public.prime_titulo_semestre))::date dia
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'prime_coletado_em', (select dia from coleta),
    'criterio', 'Mensalidade original em aberto, portador 195 (Reativa Recuperação de Crédito), semestre pela série de cobrança da Prime. Fora: acordo e parcela de acordo, título com liquidação na Prime após o vencimento + 30 dias, CPF no portador 166 sem acordo ativo no CRM, confirmação de pagamento pendente, caso cancelado ou jurídico, e aluno cujos pagamentos desde 01/07/2026 cobrem todo o aberto.',
    'anos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ano', h.ano,
        'carteira', jsonb_build_object('titulos', h.titulos, 'cpfs', h.cpfs, 'valor_original', h.valor_original,
                                       'entrada_de', h.entrada_de, 'entrada_ate', h.entrada_ate),
        'negociado', h.negociado,
        'recebido', h.recebido,
        'aberto', (select jsonb_build_object(
                     'alunos', count(distinct cpf), 'mensalidades', count(*),
                     'valor', round(coalesce(sum(saldo),0), 2), 'valor_original', round(coalesce(sum(vo),0), 2))
                     from aberto a where a.ano = h.ano),
        'cursos', (select coalesce(jsonb_agg(jsonb_build_object(
                       'curso', curso, 'alunos', alunos, 'mensalidades', mensalidades, 'valor', valor
                     ) order by valor desc), '[]'::jsonb)
                     from (select curso, count(distinct cpf) alunos, count(*) mensalidades, round(sum(saldo), 2) valor
                             from aberto a where a.ano = h.ano group by curso) c),
        'ulbra_166', (select jsonb_build_object(
                        'alunos', count(distinct cpf), 'mensalidades', count(*), 'valor', round(coalesce(sum(saldo),0), 2))
                        from cand_marcada cm where cm.ano = h.ano and cm.sai_166),
        'liquidado_no_prime', (select jsonb_build_object(
                        'mensalidades', count(*), 'valor', round(coalesce(sum(saldo),0), 2))
                        from t where t.ano = h.ano
                          and upper(coalesce(t.situacao,'')) = 'ABERTO' and lower(coalesce(t.status,'')) = 'em_aberto'
                          and not t.negociado and t.portador = 195
                          and coalesce(t.liq > t.vencimento + 30, false))
      ) order by h.ano) from hist h), '[]'::jsonb),
    -- Sem série na Prime: mesma régua, mas nunca distribuído por estimativa.
    'sem_semestre', (select jsonb_build_object(
                       'alunos', count(distinct cpf), 'mensalidades', count(*),
                       'valor', round(coalesce(sum(saldo),0), 2))
                       from aberto where semestre is null)
  ) into v;

  return v;
end;
$function$;

revoke all on function public.carteira_saldo_historico_por_ano() from public, anon;
grant execute on function public.carteira_saldo_historico_por_ano() to authenticated;

-- Confere o que foi medido na leitura de 17/09/2026: dois anos, e o saldo em
-- aberto ajustado somando 17.121 mensalidades / R$ 10.020.167,05. Tolerância no
-- valor porque baixa e negociação mexem nele a qualquer momento.
do $$
declare v jsonb; v_mens int; v_valor numeric;
begin
  v := public.carteira_saldo_historico_por_ano();
  if jsonb_array_length(v->'anos') <> 2 then
    raise exception 'esperava 2 anos, veio %', jsonb_array_length(v->'anos');
  end if;
  select sum((a->'aberto'->>'mensalidades')::int), sum((a->'aberto'->>'valor')::numeric)
    into v_mens, v_valor
    from jsonb_array_elements(v->'anos') a;
  if v_mens not between 16000 and 18500 then
    raise exception 'mensalidades em aberto fora da faixa medida: %', v_mens;
  end if;
  if v_valor not between 9000000 and 11500000 then
    raise exception 'valor em aberto fora da faixa medida: %', v_valor;
  end if;
end $$;
