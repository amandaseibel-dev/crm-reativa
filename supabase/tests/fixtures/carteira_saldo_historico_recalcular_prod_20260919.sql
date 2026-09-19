CREATE OR REPLACE FUNCTION public.carteira_saldo_historico_recalcular()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t0 timestamptz := clock_timestamp();
  v_payload jsonb;
  v_ms integer;
  v_tecnico boolean := (current_setting('request.jwt.claims', true) is null)
                        or coalesce(auth.role(),'') = 'service_role';
begin
  if not v_tecnico and not coalesce(public.usuario_e_gestao(), false) then
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
    'sem_semestre', (select jsonb_build_object(
                       'alunos', count(distinct cpf), 'mensalidades', count(*),
                       'valor', round(coalesce(sum(saldo),0), 2))
                       from aberto where semestre is null)
  ) into v_payload;

  v_ms := round(extract(epoch from (clock_timestamp() - t0)) * 1000);

  -- Snapshot velho só é substituído por um novo COMPLETO: dois anos e o bloco
  -- de cursos preenchido. Cálculo pela metade não apaga a última boa foto.
  if jsonb_array_length(v_payload->'anos') <> 2
     or jsonb_array_length(coalesce(v_payload->'anos'->0->'cursos','[]'::jsonb)) = 0 then
    raise exception 'recalculo incompleto: % anos', jsonb_array_length(v_payload->'anos');
  end if;

  insert into public.carteira_saldo_historico_snapshot (id, payload, gerado_em, duracao_ms, origem)
  values (1, v_payload, now(), v_ms, case when v_tecnico then 'rotina' else 'gestao' end)
  on conflict (id) do update
    set payload = excluded.payload, gerado_em = excluded.gerado_em,
        duracao_ms = excluded.duracao_ms, origem = excluded.origem;

  return jsonb_build_object('ok', true, 'duracao_ms', v_ms,
                            'mensalidades', (select sum((a->'aberto'->>'mensalidades')::int)
                                               from jsonb_array_elements(v_payload->'anos') a));
end;
$function$
