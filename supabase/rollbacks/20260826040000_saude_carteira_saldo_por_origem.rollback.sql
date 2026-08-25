-- Rollback de 20260826040000_saude_carteira_saldo_por_origem.sql
--
-- Devolve `saude_carteira_resumo_impl` ao estado anterior (sem a chave
-- `saldo_por_origem`) e remove a função de cálculo. Nenhum dado é alterado --
-- as duas funções só LEEM. A tela deixa de mostrar o corte por origem; o
-- componente SaldoPorOrigem já trata `origem` ausente devolvendo null, então
-- não quebra se o front for mais novo que o banco.

create or replace function public.saude_carteira_resumo_impl(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_incluir_encerrados boolean := coalesce((v_f->>'incluir_encerrados')::boolean, false);
  v_min_dias int := coalesce((v_f->>'min_dias_sem_acionamento')::int, 5);
  v_estab text := nullif(v_f->>'estabelecimento','');
  v_operador text := nullif(v_f->>'operador_email','');
  v_totais jsonb; v_estabs jsonb; v_mtx_faixa jsonb; v_mtx_tempo jsonb; v_operadores jsonb;
begin
  drop table if exists tmp_sc; create temporary table tmp_sc on commit drop as
  select * from public.mv_saude_carteira v
  where (v_incluir_encerrados or v.encerrado = false)
    and (v_estab is null or v.estabelecimento = v_estab)
    and (v_operador is null or v.operador_email is not distinct from v_operador);
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
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'atualizado_em', (select atualizado_em from public.saude_carteira_mv_meta where id),
    'filtros', v_f, 'gerado_em', now());
end; $function$;

drop function if exists public.saude_carteira_saldo_por_origem(uuid[]);
