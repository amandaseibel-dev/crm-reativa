-- ============================================================================
-- EFETIVIDADE POR ANO — a função para de estourar o tempo limite
-- ----------------------------------------------------------------------------
-- Amanda, 17/09/2026, abrindo a aba em produção: "canceling statement due to
-- statement timeout"; depois, "otimize o processo".
--
-- O TETO É REAL E É DE 8 SEGUNDOS: `alter role authenticated set
-- statement_timeout = '8s'`. A versão aplicada hoje (`20260917184347`) levava
-- **69.722 ms** medidos com `explain (analyze)` em produção, então a aba
-- simplesmente não carregava — as cinco RPCs são aguardadas juntas no front e
-- uma que estoura derruba a tela inteira.
--
-- MEDIDO, TRÊS CAUSAS (nenhuma era o volume da carteira):
--
--   1. `devido` (total em aberto por aluno) era uma CTE e o planejador a
--      reavaliava por linha: `Nested Loop Left Join` com **194.105.376** linhas
--      descartadas no filtro. Agora o total sai de `sum(saldo) over (partition
--      by aluno_id)` na mesma passagem — nenhum join.
--   2. `regexp_replace` nos DOIS lados do casamento com a Prime impedia o uso
--      de `prime_titulo_semestre_pkey` e `ix_prime_extrato_boleto`. Conferido
--      em produção: as três colunas (`acordos_titulos.documento`,
--      `prime_titulo_semestre.boleto`, `prime_extrato.boleto`) têm **zero**
--      caracteres não dígitos, `boleto` é único nas duas tabelas da Prime
--      (399.506 linhas = 399.506 boletos) e o casamento cru dá exatamente o
--      mesmo que o normalizado (47.167 de 47.370). O join virou direto, em
--      `lateral`, e passou a usar índice.
--   3. As CTEs auxiliares não estavam materializadas, então agregações como
--      `pago_julho` eram refeitas a cada linha. Todas passam a ser
--      `as materialized`, e os agregados por ano saem uma vez, em CTE própria.
--
--   4. `select ... into` no PL/pgSQL DESLIGA O PARALELISMO. A primeira medição
--      desta correção (1.814 ms) usava 2 workers e mentia: executada como
--      função, a versão sem `limit 1` levou 8.239 ms e a trava abortou a
--      aplicação — o que salvou a tela de continuar quebrada. Toda medição
--      daqui em diante é com `max_parallel_workers_per_gather = 0`.
--
-- MEDIDO EM PRODUÇÃO, na condição real (sem paralelismo):
--
--   versão em produção (20260917184347)   37.620 ms  (e 69.722 ms com 2 workers)
--   esta correção, sem `limit 1`           5.961 ms  → 8.239 ms como função
--   esta correção, com `limit 1`           3.861 ms  <- o que entra aqui
--
-- O bloco `do` no fim EXIGE menos de 6 s medidos na execução REAL da função: se
-- um dia alguém reintroduzir o problema, a migration falha em vez de devolver
-- uma tela em branco. Foi assim que a tentativa anterior foi barrada.
--
-- O PAYLOAD É IDÊNTICO, CAMPO POR CAMPO, e foi conferido contra a versão em
-- produção e contra os payloads já validados na tela:
--   2024  aberto 1.991 alunos / 6.411 mensalidades / R$ 3.714.151,57 ·
--         carteira 8.469 / 2.528 / R$ 5.159.080,84 · negociado R$ 61.212,46 ·
--         recebido R$ 44.921,85 · 166 R$ 613.246,31 · liquidado 886 / R$ 687.635,40
--   2025  aberto 2.967 / 10.710 / R$ 6.306.015,48 ·
--         carteira 20.851 / 5.683 / R$ 15.197.034,48 · negociado R$ 443.712,53 ·
--         recebido R$ 338.011,03 · 166 R$ 5.074.170,88 · liquidado 1.911 / R$ 1.599.179,48
--   sem semestre 191 alunos / 486 mensalidades / R$ 81.464,89
--
-- NENHUMA REGRA DE NEGÓCIO MUDA e o front NÃO muda: mesmas chaves, mesmos
-- valores. Só o caminho até eles.
--
-- Só leitura. Reversível: reaplicar o corpo de `20260917184347` (ledger).
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

  with pag_titulo as materialized (
    select distinct titulo_numero b from public.pagamentos where coalesce(titulo_numero,'') <> ''
  ),
  m166 as materialized (
    select distinct lpad(regexp_replace(cpf, '\D', '', 'g'), 11, '0') cpf
      from public.prime_portador_membro where portador = 166
  ),
  acordo_ativo as materialized (
    select distinct aluno_id from public.acordos where status = 'ATIVO' and aluno_id is not null
  ),
  conf as materialized (
    select distinct aluno_id from public.solicitacoes_confirmacao_pagamento
     where status = 'AGUARDANDO_CONFIRMACAO'
  ),
  caso_fora as materialized (
    select distinct aluno_id from public.casos
     where public.normalizar_status_acionamento(coalesce(status_atual, status_acionamento, status_jornada))
           = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'])
  ),
  pago_julho as materialized (
    select aluno_id, sum(valor_pago) pago from public.pagamentos
     where data_pagamento >= date '2026-07-01' and aluno_id is not null group by 1
  ),
  -- Mensalidades de graduação e pós. O casamento com a Prime é DIRETO em
  -- `boleto = documento`, dentro de `lateral`, para entrar pelo índice; a
  -- situação atual (portador e liquidação) vem da coleta MAIS RECENTE entre as
  -- duas tabelas espelho.
  --
  -- O `limit 1` NÃO é cosmético e não muda resultado (`boleto` é único nas duas
  -- tabelas): é ele que obriga o planejador a buscar por índice uma vez por
  -- título. Sem ele, e sem paralelismo — que é a condição real da função —, o
  -- plano virava merge join varrendo as duas tabelas da Prime INTEIRAS
  -- (400.091 e 399.505 linhas) e o tempo saltava de 3,9 s para 6,0 s.
  t as materialized (
    select t.id, t.aluno_id,
           lpad(regexp_replace(coalesce(nullif(t.cpf,''), al.cpf, ''), '\D', '', 'g'), 11, '0') cpf,
           t.valor_original vo,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo,
           t.situacao, t.status, t.vencimento, t.created_at::date entrada, t.origem_liquidacao, t.acordo_id,
           ts.semestre, left(ts.semestre, 4) ano,
           case when ex.boleto is null then ts.carrier_id
                when ts.boleto is null or ex.coletado_em >= ts.coletado_em then ex.portador
                else ts.carrier_id end portador,
           case when ex.boleto is null then ts.liquidado_em
                when ts.boleto is null or ex.coletado_em >= ts.coletado_em then ex.liquidado_em
                else ts.liquidado_em end liq,
           (t.acordo_id is not null
            or exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id)) negociado,
           case
             when t.tipo_boleto ilike 'Cursos de Gradua%Presencial' then 'Graduação Presencial'
             when t.tipo_boleto ilike 'Cursos de Gradua%Online'     then 'Graduação Online'
             when t.tipo_boleto ilike 'Cursos de Gradua%brido'      then 'Graduação Híbrido'
             when t.tipo_boleto ilike 'Cursos de P%s Gradua%'       then 'Pós-Graduação (Lato Sensu)'
           end curso,
           exists (select 1 from public.parcelas p where p.boleto = t.documento) eh_boleto_de_parcela,
           (pg.b is not null) tem_pagamento_no_titulo
      from public.acordos_titulos t
      left join public.alunos al on al.id = t.aluno_id
      left join lateral (select s.semestre, s.carrier_id, s.liquidado_em, s.coletado_em, s.boleto
                           from public.prime_titulo_semestre s where s.boleto = t.documento limit 1) ts on true
      left join lateral (select e.portador, e.liquidado_em, e.coletado_em, e.boleto
                           from public.prime_extrato e where e.boleto = t.documento limit 1) ex on true
      left join pag_titulo pg on pg.b = t.documento
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and (t.tipo_boleto ilike 'Cursos de Gradua%' or t.tipo_boleto ilike 'Cursos de P%s Gradua%')
  ),
  -- `devido_total` por janela: era aqui que nascia o nested loop de 194 milhões.
  cand as materialized (
    select *, sum(saldo) over (partition by aluno_id) devido_total
      from t
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
  cand_marcada as materialized (
    select c.*,
           (m.cpf is not null and aa.aluno_id is null) sai_166,
           (cf.aluno_id is not null) sai_confirmacao,
           (cx.aluno_id is not null) sai_caso,
           (coalesce(pj.pago, 0) >= c.devido_total) sai_pago
      from cand c
      left join m166 m on m.cpf = c.cpf
      left join acordo_ativo aa on aa.aluno_id = c.aluno_id
      left join conf cf on cf.aluno_id = c.aluno_id::text
      left join caso_fora cx on cx.aluno_id = c.aluno_id
      left join pago_julho pj on pj.aluno_id = c.aluno_id
  ),
  aberto as materialized (
    select * from cand_marcada
     where not (sai_166 or sai_confirmacao or sai_caso or sai_pago)
  ),
  parc as materialized (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas
      from public.parcelas group by 1
  ),
  acordo as materialized (
    select a.id,
           case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                when a.status = 'QUITADO' then 1 else 0 end ratio
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  -- Histórico da safra: carteira residual, negociado e recebido. SEM filtro de
  -- portador — conversão é história, e acordo quebrado devolve o título ao
  -- portador; filtrar aqui apagaria conversão que aconteceu de verdade.
  hist as materialized (
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
  -- Os agregados por ano saem UMA vez cada, em vez de um subplano por ano.
  por_ano_aberto as materialized (
    select ano, count(distinct cpf) alunos, count(*) mensalidades,
           round(sum(saldo), 2) valor, round(sum(vo), 2) valor_original
      from aberto where ano is not null group by ano
  ),
  por_ano_curso as materialized (
    select ano, curso, count(distinct cpf) alunos, count(*) mensalidades, round(sum(saldo), 2) valor
      from aberto where ano is not null group by ano, curso
  ),
  por_ano_166 as materialized (
    select ano, count(distinct cpf) alunos, count(*) mensalidades, round(sum(saldo), 2) valor
      from cand_marcada where sai_166 and ano is not null group by ano
  ),
  por_ano_liq as materialized (
    select ano, count(*) mensalidades, round(sum(saldo), 2) valor
      from t
     where ano is not null
       and upper(coalesce(situacao,'')) = 'ABERTO' and lower(coalesce(status,'')) = 'em_aberto'
       and not negociado and portador = 195
       and coalesce(liq > vencimento + 30, false)
     group by ano
  ),
  coleta as materialized (
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
        'aberto', coalesce((select jsonb_build_object('alunos', x.alunos, 'mensalidades', x.mensalidades,
                                                     'valor', x.valor, 'valor_original', x.valor_original)
                              from por_ano_aberto x where x.ano = h.ano),
                           jsonb_build_object('alunos', 0, 'mensalidades', 0, 'valor', 0, 'valor_original', 0)),
        'cursos', coalesce((select jsonb_agg(jsonb_build_object('curso', c.curso, 'alunos', c.alunos,
                                                               'mensalidades', c.mensalidades, 'valor', c.valor)
                                             order by c.valor desc)
                              from por_ano_curso c where c.ano = h.ano), '[]'::jsonb),
        'ulbra_166', coalesce((select jsonb_build_object('alunos', y.alunos, 'mensalidades', y.mensalidades,
                                                        'valor', y.valor)
                                from por_ano_166 y where y.ano = h.ano),
                              jsonb_build_object('alunos', 0, 'mensalidades', 0, 'valor', 0)),
        'liquidado_no_prime', coalesce((select jsonb_build_object('mensalidades', z.mensalidades, 'valor', z.valor)
                                          from por_ano_liq z where z.ano = h.ano),
                                       jsonb_build_object('mensalidades', 0, 'valor', 0))
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

-- A trava que faltava: além de conferir o conteúdo, EXIGE tempo abaixo de 6 s.
-- O teto do `authenticated` é 8 s; quem reintroduzir o nested loop de 194
-- milhões vai ver a migration falhar, não a tela em branco.
do $$
declare
  t0 timestamptz := clock_timestamp();
  v jsonb;
  v_ms numeric;
  v_mens int;
  v_valor numeric;
begin
  v := public.carteira_saldo_historico_por_ano();
  v_ms := extract(epoch from (clock_timestamp() - t0)) * 1000;

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
  if (v->'anos'->0->'cursos') is null or jsonb_array_length(v->'anos'->0->'cursos') = 0 then
    raise exception 'o bloco de cursos voltou vazio';
  end if;
  if (v->'sem_semestre'->>'mensalidades') is null then
    raise exception 'o bloco sem_semestre nao voltou';
  end if;
  if v_ms > 6000 then
    raise exception 'a funcao levou % ms, acima do limite de 6000 ms (teto do authenticated e 8000)', round(v_ms);
  end if;

  raise notice 'carteira_saldo_historico_por_ano: % ms, % mensalidades em aberto, R$ %', round(v_ms), v_mens, v_valor;
end $$;
