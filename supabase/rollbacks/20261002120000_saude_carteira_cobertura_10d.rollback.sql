-- ROLLBACK de 20261002120000_saude_carteira_cobertura_10d.
--
-- Devolve view, matview e RPC ao estado de producao de 02/10/2026:
--   * view sem as colunas cobertura_em / dias_sem_cobertura / nunca_coberto
--     e sem a CTE `cob` (corpo derivado da propria migration, para as duas
--     copias nao divergirem);
--   * matview recriada com os 8 indices originais (sem ix_mv_sc_cobertura)
--     e o grant a service_role;
--   * RPC restaurada byte a byte, md5 8422578045ac92a66b9d45829bdd31bb,
--     capturada de producao por pg_get_functiondef antes da migration.
--
-- A view precisa de DROP, nao de `create or replace`: replace nao remove
-- coluna. A matview depende da view, entao cai primeiro.
--
-- Nada aqui toca casos.data_ultimo_acionamento, fidelizacao ou regra
-- financeira -- pelo mesmo motivo que a migration nao tocou: nunca foram
-- alterados por ela.
--
-- Depois do rollback a tela perde as chaves de cobertura no payload. O front
-- trata a ausencia sem quebrar (cai para a leitura operacional).

begin;

drop materialized view if exists public.mv_saude_carteira;
drop view if exists public.vw_saude_carteira;

create view public.vw_saude_carteira as
 WITH acc AS (
         SELECT ac.aluno_id,
            count(*) FILTER (WHERE ac.status = 'ATIVO'::text) AS acordos_ativos,
            bool_or(p.status = 'VENCIDA'::text) AS tem_parcela_vencida,
            min(p.vencimento) FILTER (WHERE p.status = 'VENCIDA'::text) AS parcela_vencida_mais_antiga,
            min(p.vencimento) FILTER (WHERE p.status = 'A_VENCER'::text) AS proxima_parcela_a_vencer
           FROM acordos ac
             LEFT JOIN parcelas p ON p.acordo_id = ac.id AND (p.status = ANY (ARRAY['VENCIDA'::text, 'A_VENCER'::text]))
          WHERE ac.status = 'ATIVO'::text
          GROUP BY ac.aluno_id
        ), tit AS (
         SELECT t.aluno_id,
            min(t.vencimento) AS titulo_vencido_mais_antigo
           FROM acordos_titulos t
          WHERE t.situacao = 'ABERTO'::text AND t.status = 'em_aberto'::text AND t.acordo_id IS NULL AND t.vencimento < CURRENT_DATE
          GROUP BY t.aluno_id
        )
        )
 SELECT c.id AS caso_id,
    c.caso_codigo,
    c.aluno_id,
    COALESCE(c.cpf_mascarado, a.cpf_mascarado) AS cpf_mascarado,
    COALESCE(NULLIF(regexp_replace(COALESCE(c.cpf_limpo, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text), NULLIF(regexp_replace(COALESCE(a.cpf, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text)) AS cpf_conta,
    saude_carteira_norm_unidade(a.unidade) AS estabelecimento,
    COALESCE(NULLIF(TRIM(BOTH FROM c.operador_email), ''::text), NULLIF(TRIM(BOTH FROM a.responsavel_atual_email), ''::text)) AS operador_email,
    COALESCE(NULLIF(TRIM(BOTH FROM c.operador_nome), ''::text), NULLIF(TRIM(BOTH FROM a.responsavel_atual_nome), ''::text)) AS operador_nome,
    COALESCE(c.saldo_vencido, 0::numeric) AS saldo_vencido,
    COALESCE(c.saldo_total, 0::numeric) AS saldo_total,
    c.situacao_operacional,
    c.criticidade,
    CURRENT_DATE - LEAST(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga) AS dias_atraso,
    c.proximo_vencimento,
    c.data_retorno,
    c.data_ultimo_acionamento,
    c.status_acionamento AS tipo_ultimo_acionamento,
    c.proxima_acao_automatica AS proxima_acao,
        CASE
            WHEN c.data_ultimo_acionamento IS NULL THEN NULL::integer
            ELSE GREATEST(0, CURRENT_DATE - c.data_ultimo_acionamento)
        END AS dias_sem_acionamento,
    c.data_ultimo_acionamento IS NULL AS nunca_acionado,
        CASE
            WHEN c.data_ultimo_acionamento IS NULL THEN 'NUNCA'::text
            WHEN (CURRENT_DATE - c.data_ultimo_acionamento) <= 1 THEN '1D'::text
            WHEN (CURRENT_DATE - c.data_ultimo_acionamento) <= 3 THEN '2_3D'::text
            WHEN (CURRENT_DATE - c.data_ultimo_acionamento) <= 5 THEN '4_5D'::text
            WHEN (CURRENT_DATE - c.data_ultimo_acionamento) <= 7 THEN '6_7D'::text
            WHEN (CURRENT_DATE - c.data_ultimo_acionamento) <= 15 THEN '8_15D'::text
            WHEN (CURRENT_DATE - c.data_ultimo_acionamento) <= 30 THEN '16_30D'::text
            ELSE 'MAIS_30D'::text
        END AS faixa_tempo_sem_acionamento,
        CASE
            WHEN COALESCE(CURRENT_DATE - LEAST(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga), 0) <= 0 THEN 'A_VENCER'::text
            WHEN (CURRENT_DATE - LEAST(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 30 THEN '1_30'::text
            WHEN (CURRENT_DATE - LEAST(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 60 THEN '31_60'::text
            WHEN (CURRENT_DATE - LEAST(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 90 THEN '61_90'::text
            WHEN (CURRENT_DATE - LEAST(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 180 THEN '91_180'::text
            WHEN (CURRENT_DATE - LEAST(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 365 THEN '181_365'::text
            ELSE 'MAIS_365'::text
        END AS faixa_atraso,
    c.data_retorno IS NOT NULL AND c.data_retorno < CURRENT_DATE AS retorno_vencido,
    COALESCE(NULLIF(TRIM(BOTH FROM a.telefone), ''::text), NULLIF(TRIM(BOTH FROM a.telefone_resp1), ''::text), NULLIF(TRIM(BOTH FROM a.telefone_resp2), ''::text)) IS NULL AS sem_telefone,
    (NULLIF(TRIM(BOTH FROM a.telefone), ''::text) IS NOT NULL)::integer + (NULLIF(TRIM(BOTH FROM a.telefone_resp1), ''::text) IS NOT NULL)::integer + (NULLIF(TRIM(BOTH FROM a.telefone_resp2), ''::text) IS NOT NULL)::integer AS qtd_telefones,
    a.email IS NULL OR TRIM(BOTH FROM a.email) = ''::text AS sem_email,
    COALESCE(NULLIF(TRIM(BOTH FROM c.operador_email), ''::text), NULLIF(TRIM(BOTH FROM a.responsavel_atual_email), ''::text)) IS NULL AS sem_responsavel,
        CASE
            WHEN COALESCE(acc.acordos_ativos, 0::bigint) = 0 THEN 'SEM_ACORDO'::text
            WHEN acc.tem_parcela_vencida AND acc.parcela_vencida_mais_antiga < (CURRENT_DATE - 30) THEN 'QUEBRADO'::text
            WHEN acc.tem_parcela_vencida THEN 'VENCIDO'::text
            ELSE 'EM_DIA'::text
        END AS acordo_situacao,
    acc.proxima_parcela_a_vencer,
    acc.parcela_vencida_mais_antiga,
    upper(COALESCE(c.criticidade, ''::text)) = 'CRITICO'::text AND COALESCE(c.saldo_vencido, 0::numeric) > 0::numeric AS critico_canonico,
    upper(COALESCE(c.criticidade, ''::text)) = 'URGENTE'::text AND COALESCE(c.saldo_vencido, 0::numeric) > 0::numeric AS urgente_canonico,
    COALESCE(c.encerrado_operacional, false) OR caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada) AS encerrado,
    c.caso_atualizado_em AS ultima_atualizacao,
        CASE
            WHEN c.data_ultimo_acionamento IS NOT NULL THEN c.data_ultimo_acionamento + 10
            ELSE NULL::date
        END AS fidelizado_ate,
        CASE
            WHEN c.data_ultimo_acionamento IS NOT NULL THEN c.data_ultimo_acionamento + 10 - CURRENT_DATE
            ELSE NULL::integer
        END AS dias_fidelizacao,
    caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) AS protegido,
        CASE
            WHEN COALESCE(NULLIF(TRIM(BOTH FROM c.operador_email), ''::text), NULLIF(TRIM(BOTH FROM a.responsavel_atual_email), ''::text)) IS NULL THEN 'LIVRE'::text
            WHEN caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) THEN 'PROTEGIDA'::text
            WHEN c.data_ultimo_acionamento IS NULL THEN 'EXPIRADA'::text
            WHEN (c.data_ultimo_acionamento + 10 - CURRENT_DATE) < 0 THEN 'EXPIRADA'::text
            WHEN (c.data_ultimo_acionamento + 10 - CURRENT_DATE) = 0 THEN 'ULTIMO_DIA'::text
            WHEN (c.data_ultimo_acionamento + 10 - CURRENT_DATE) = 1 THEN 'URGENTE'::text
            WHEN (c.data_ultimo_acionamento + 10 - CURRENT_DATE) <= 3 THEN 'ATENCAO'::text
            ELSE 'ATIVA'::text
        END AS fidelizacao_situacao
   FROM casos c
     LEFT JOIN alunos a ON a.id = c.aluno_id
     LEFT JOIN acc ON acc.aluno_id = c.aluno_id
     LEFT JOIN tit ON tit.aluno_id = c.aluno_id;;

create materialized view public.mv_saude_carteira as select * from public.vw_saude_carteira;

create unique index ux_mv_saude_carteira_caso on public.mv_saude_carteira using btree (caso_id);
create index ix_mv_sc_encerrado on public.mv_saude_carteira using btree (encerrado);
create index ix_mv_sc_estab     on public.mv_saude_carteira using btree (estabelecimento);
create index ix_mv_sc_operador  on public.mv_saude_carteira using btree (operador_email);
create index ix_mv_sc_faixa     on public.mv_saude_carteira using btree (faixa_atraso);
create index ix_mv_sc_tempo     on public.mv_saude_carteira using btree (faixa_tempo_sem_acionamento);
create index ix_mv_sc_acordo    on public.mv_saude_carteira using btree (acordo_situacao);
create index ix_mv_sc_fidel     on public.mv_saude_carteira using btree (fidelizacao_situacao);

grant select on public.mv_saude_carteira to service_role;

-- O rollback recria a matview, entao herda o mesmo ALTER DEFAULT PRIVILEGES que
-- concede tudo a `authenticated`. Sem esta linha, desfazer a cobertura abriria a
-- carteira inteira para qualquer usuario autenticado, contornando o escopo por
-- operador das RPCs SECURITY DEFINER. Ver a nota na migration correspondente.
revoke all on public.mv_saude_carteira from authenticated;

CREATE OR REPLACE FUNCTION public.saude_carteira_resumo_impl(p_filtros jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_incluir_encerrados boolean := coalesce((v_f->>'incluir_encerrados')::boolean, false);
  v_min_dias int := coalesce((v_f->>'min_dias_sem_acionamento')::int, 5);
  v_estab text := nullif(v_f->>'estabelecimento','');
  v_operador text := nullif(v_f->>'operador_email','');
  v_totais jsonb; v_estabs jsonb; v_mtx_faixa jsonb; v_mtx_tempo jsonb; v_operadores jsonb;
  v_origem jsonb; v_alunos uuid[];
begin
  drop table if exists tmp_sc; create temporary table tmp_sc on commit drop as
  select * from public.mv_saude_carteira v
  where (v_incluir_encerrados or v.encerrado = false)
    and (v_estab is null or v.estabelecimento = v_estab)
    and (v_operador is null or v.operador_email is not distinct from v_operador);

  select array_agg(distinct aluno_id) into v_alunos from tmp_sc where aluno_id is not null;
  v_origem := public.saude_carteira_saldo_por_origem(coalesce(v_alunos, array[]::uuid[]));

  select jsonb_build_object(
    'casos_ativos', count(*), 'cpfs_unicos', count(distinct aluno_id),
    'saldo_vencido', coalesce(sum(saldo_vencido),0), 'saldo_total', coalesce(sum(saldo_total),0),
    'nunca_acionados', count(*) filter (where nunca_acionado),
    'sem_acionamento_limite', count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias),
    'pct_sem_acionamento', round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1), 1),
    'retornos_vencidos', count(*) filter (where retorno_vencido),
    'sem_telefone', count(*) filter (where sem_telefone), 'sem_responsavel', count(*) filter (where sem_responsavel),
    'criticos', count(*) filter (where critico_canonico), 'urgentes', count(*) filter (where urgente_canonico),
    'acordos_em_dia', count(*) filter (where acordo_situacao = 'EM_DIA'),
    'acordos_vencidos', count(*) filter (where acordo_situacao = 'VENCIDO'),
    'acordos_quebrados', count(*) filter (where acordo_situacao = 'QUEBRADO'),
    'acordos_em_dia_sem_acompanhamento', count(*) filter (where acordo_situacao='EM_DIA' and (data_retorno is null or data_retorno < current_date)),
    'casos_revisao', count(*) filter (where cpf_conta is null or aluno_id is null),
    'fidelizacao_ativa', count(*) filter (where fidelizacao_situacao='ATIVA'),
    'fidelizacao_vence_3d', count(*) filter (where fidelizacao_situacao in ('ATENCAO','URGENTE','ULTIMO_DIA')),
    'fidelizacao_vence_amanha', count(*) filter (where fidelizacao_situacao='URGENTE'),
    'fidelizacao_expira_hoje', count(*) filter (where fidelizacao_situacao='ULTIMO_DIA'),
    'fidelizacao_expirada', count(*) filter (where fidelizacao_situacao='EXPIRADA'),
    'casos_livres', count(*) filter (where fidelizacao_situacao='LIVRE'),
    'saldo_livres', coalesce(sum(saldo_total) filter (where fidelizacao_situacao='LIVRE'),0),
    'protegidas', count(*) filter (where fidelizacao_situacao='PROTEGIDA'),
    'min_dias_sem_acionamento', v_min_dias
  ) into v_totais from tmp_sc;

  select jsonb_agg(t order by t.sem_acionamento_limite desc) into v_estabs from (
    select estabelecimento, count(*) as casos_ativos, count(distinct aluno_id) as cpfs_unicos,
      coalesce(sum(saldo_vencido),0) as saldo_vencido, coalesce(sum(saldo_total),0) as saldo_total,
      count(*) filter (where nunca_acionado) as nunca_acionados,
      count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) as sem_acionamento_limite,
      round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1),1) as pct_sem_acionamento,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 7) as sem_ac_7,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 15) as sem_ac_15,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 30) as sem_ac_30,
      count(*) filter (where retorno_vencido) as retornos_vencidos,
      count(*) filter (where sem_telefone) as sem_telefone, count(*) filter (where sem_responsavel) as sem_responsavel,
      count(*) filter (where critico_canonico) as criticos, count(*) filter (where urgente_canonico) as urgentes,
      count(*) filter (where acordo_situacao='EM_DIA') as acordos_em_dia,
      count(*) filter (where acordo_situacao='VENCIDO') as acordos_vencidos,
      count(*) filter (where acordo_situacao='QUEBRADO') as acordos_quebrados,
      count(*) filter (where fidelizacao_situacao='LIVRE') as casos_livres,
      coalesce(sum(saldo_total) filter (where fidelizacao_situacao='LIVRE'),0) as saldo_livres,
      count(*) filter (where fidelizacao_situacao='ATIVA') as fidelizacao_ativa,
      count(*) filter (where fidelizacao_situacao='EXPIRADA') as fidelizacao_expirada,
      count(*) filter (where cpf_conta is null or aluno_id is null) as casos_revisao
    from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.estabelecimento) into v_mtx_faixa from (
    select estabelecimento,
      count(*) filter (where faixa_atraso='A_VENCER') as a_vencer,
      count(*) filter (where faixa_atraso='1_30') as f1_30, count(*) filter (where faixa_atraso='31_60') as f31_60,
      count(*) filter (where faixa_atraso='61_90') as f61_90, count(*) filter (where faixa_atraso='91_180') as f91_180,
      count(*) filter (where faixa_atraso='181_365') as f181_365, count(*) filter (where faixa_atraso='MAIS_365') as f_mais_365,
      count(distinct aluno_id) as cpfs, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) as total
    from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.estabelecimento) into v_mtx_tempo from (
    select estabelecimento,
      count(*) filter (where faixa_tempo_sem_acionamento='NUNCA') as nunca,
      count(*) filter (where faixa_tempo_sem_acionamento='1D') as d1, count(*) filter (where faixa_tempo_sem_acionamento='2_3D') as d2_3,
      count(*) filter (where faixa_tempo_sem_acionamento='4_5D') as d4_5, count(*) filter (where faixa_tempo_sem_acionamento='6_7D') as d6_7,
      count(*) filter (where faixa_tempo_sem_acionamento='8_15D') as d8_15, count(*) filter (where faixa_tempo_sem_acionamento='16_30D') as d16_30,
      count(*) filter (where faixa_tempo_sem_acionamento='MAIS_30D') as d_mais_30,
      count(distinct aluno_id) as cpfs, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) as total
    from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.casos_ativos desc) into v_operadores from (
    select coalesce(operador_email,'(SEM RESPONSAVEL)') as operador_email, count(*) as casos_ativos,
      count(distinct aluno_id) as cpfs_unicos, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) filter (where nunca_acionado) as nunca_acionados,
      count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) as sem_acionamento_limite,
      round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1),1) as pct_sem_acionamento,
      count(*) filter (where retorno_vencido) as retornos_vencidos, count(*) filter (where sem_telefone) as sem_telefone,
      count(*) filter (where critico_canonico) as criticos, count(*) filter (where urgente_canonico) as urgentes,
      count(*) filter (where acordo_situacao='EM_DIA') as acordos_em_dia,
      count(*) filter (where acordo_situacao='VENCIDO') as acordos_vencidos,
      count(*) filter (where fidelizacao_situacao='ATIVA') as fidelizacao_ativa,
      count(*) filter (where fidelizacao_situacao='EXPIRADA') as fidelizacao_expirada
    from tmp_sc group by coalesce(operador_email,'(SEM RESPONSAVEL)')
  ) t;

  return jsonb_build_object('totais', v_totais, 'estabelecimentos', coalesce(v_estabs,'[]'::jsonb),
    'matriz_faixa_atraso', coalesce(v_mtx_faixa,'[]'::jsonb),
    'matriz_tempo_sem_acionamento', coalesce(v_mtx_tempo,'[]'::jsonb),
    'operadores', coalesce(v_operadores,'[]'::jsonb),
    'saldo_por_origem', v_origem,
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'atualizado_em', (select atualizado_em from public.saude_carteira_mv_meta where id),
    'filtros', v_f, 'gerado_em', now());
end; $function$;

-- RPC de drill-down de volta ao estado de producao: os dois indicadores de
-- cobertura saem do CASE. md5 9274651f85f497d95ebb98df73774a3f, derivado da
-- versao da migration pela remocao das duas linhas -- nao e copia manual.

CREATE OR REPLACE FUNCTION public.saude_carteira_detalhes(p_filtros jsonb DEFAULT '{}'::jsonb, p_limite integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_incluir_encerrados boolean := coalesce((v_f->>'incluir_encerrados')::boolean, false);
  v_min_dias int := coalesce((v_f->>'min_dias_sem_acionamento')::int, 5);
  v_estab text := nullif(v_f->>'estabelecimento','');
  v_operador text := nullif(v_f->>'operador_email','');
  v_faixa_atraso text := nullif(v_f->>'faixa_atraso','');
  v_faixa_tempo text := nullif(v_f->>'faixa_tempo','');
  v_acordo text := nullif(v_f->>'acordo_situacao','');
  v_fidel text := nullif(v_f->>'fidelizacao','');
  v_indicador text := nullif(v_f->>'indicador','');
  v_ordem text := coalesce(nullif(v_f->>'ordenar_por',''),'saldo_vencido');
  v_dir text := case when lower(coalesce(v_f->>'ordem_dir','desc'))='asc' then 'asc' else 'desc' end;
  v_lim int := least(greatest(coalesce(p_limite,50),1),50000);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_total int; v_rows jsonb;
begin
  drop table if exists tmp_det; create temporary table tmp_det on commit drop as
  select * from public.mv_saude_carteira v
  where (v_incluir_encerrados or v.encerrado = false)
    and (v_estab is null or v.estabelecimento = v_estab)
    and (v_operador is null or v.operador_email is not distinct from v_operador)
    and (v_faixa_atraso is null or v.faixa_atraso = v_faixa_atraso)
    and (v_faixa_tempo is null or v.faixa_tempo_sem_acionamento = v_faixa_tempo)
    and (v_acordo is null or v.acordo_situacao = v_acordo)
    and (v_fidel is null or v.fidelizacao_situacao = v_fidel)
    and (v_indicador is null or case v_indicador
        when 'nunca_acionados' then v.nunca_acionado
        when 'sem_acionamento_limite' then (v.nunca_acionado or v.dias_sem_acionamento >= v_min_dias)
        when 'retornos_vencidos' then v.retorno_vencido
        when 'sem_telefone' then v.sem_telefone
        when 'sem_responsavel' then v.sem_responsavel
        when 'criticos' then v.critico_canonico
        when 'urgentes' then v.urgente_canonico
        when 'acordos_em_dia' then v.acordo_situacao='EM_DIA'
        when 'acordos_vencidos' then v.acordo_situacao='VENCIDO'
        when 'acordos_quebrados' then v.acordo_situacao='QUEBRADO'
        when 'acordos_em_dia_sem_acompanhamento' then (v.acordo_situacao='EM_DIA' and (v.data_retorno is null or v.data_retorno < current_date))
        when 'casos_revisao' then (v.cpf_conta is null or v.aluno_id is null)
        when 'casos_livres' then v.fidelizacao_situacao='LIVRE'
        when 'fidelizacao_ativa' then v.fidelizacao_situacao='ATIVA'
        when 'fidelizacao_expirada' then v.fidelizacao_situacao='EXPIRADA'
        when 'fidelizacao_vence_3d' then v.fidelizacao_situacao in ('ATENCAO','URGENTE','ULTIMO_DIA')
        when 'fidelizacao_expira_hoje' then v.fidelizacao_situacao='ULTIMO_DIA'
        when 'fidelizacao_vence_amanha' then v.fidelizacao_situacao='URGENTE'
        else true end);
  select count(*) into v_total from tmp_det;
  select jsonb_agg(row_to_json(x)) into v_rows from (
    select estabelecimento, caso_id, caso_codigo,
      case when cpf_conta is null then null else '***' || right(regexp_replace(cpf_conta,'\D','','g'),3) end as aluno_mascarado,
      operador_email, faixa_atraso, dias_atraso, parcela_vencida_mais_antiga,
      qtd_telefones, saldo_vencido, saldo_total, acordo_situacao, criticidade,
      data_ultimo_acionamento as ultimo_acionamento, dias_sem_acionamento,
      tipo_ultimo_acionamento, data_retorno as proximo_retorno, retorno_vencido,
      proxima_acao, (not sem_telefone) as possui_telefone, situacao_operacional,
      ultima_atualizacao, critico_canonico, urgente_canonico,
      fidelizado_ate, dias_fidelizacao, fidelizacao_situacao
    from tmp_det
    order by
      case when v_dir='asc' then
        case v_ordem when 'saldo_vencido' then saldo_vencido when 'saldo_total' then saldo_total
          when 'dias_sem_acionamento' then coalesce(dias_sem_acionamento,999999)::numeric
          when 'dias_fidelizacao' then coalesce(dias_fidelizacao,-999)::numeric
          when 'dias_atraso' then coalesce(dias_atraso,0)::numeric else saldo_vencido end
      end asc nulls last,
      case when v_dir='desc' then
        case v_ordem when 'saldo_vencido' then saldo_vencido when 'saldo_total' then saldo_total
          when 'dias_sem_acionamento' then coalesce(dias_sem_acionamento,-1)::numeric
          when 'dias_fidelizacao' then coalesce(dias_fidelizacao,999)::numeric
          when 'dias_atraso' then coalesce(dias_atraso,0)::numeric else saldo_vencido end
      end desc nulls last,
      caso_id
    limit v_lim offset v_off
  ) x;
  return jsonb_build_object('total', v_total, 'limite', v_lim, 'offset', v_off,
    'rows', coalesce(v_rows,'[]'::jsonb),
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'atualizado_em', (select atualizado_em from public.saude_carteira_mv_meta where id),
    'filtros', v_f, 'gerado_em', now());
end; $function$;

commit;
