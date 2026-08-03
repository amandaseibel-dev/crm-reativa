-- =====================================================================
-- SAÚDE COMPLETA DA CARTEIRA — mascaramento seguro do identificador do aluno
-- casos.cpf_mascarado NÃO é realmente mascarado (guarda dígitos crus). O
-- detalhamento passa a expor apenas os 3 últimos dígitos de cpf_conta
-- ("***NNN"), nunca o CPF/telefone completos. cpf_conta permanece interno.
-- Única função que retorna linhas: saude_carteira_detalhes.
-- =====================================================================
create or replace function public.saude_carteira_detalhes(
  p_filtros jsonb default '{}'::jsonb, p_limite integer default 50, p_offset integer default 0
) returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
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
        else true end);
  select count(*) into v_total from tmp_det;
  select jsonb_agg(row_to_json(x)) into v_rows from (
    select estabelecimento, caso_id, caso_codigo,
      -- mascaramento seguro: só os 3 últimos dígitos (cpf_conta nunca é exposto)
      case when cpf_conta is null then null else '***' || right(regexp_replace(cpf_conta,'\D','','g'),3) end as aluno_mascarado,
      operador_email, faixa_atraso, dias_atraso, parcela_vencida_mais_antiga,
      qtd_telefones, saldo_vencido, saldo_total, acordo_situacao, criticidade,
      data_ultimo_acionamento as ultimo_acionamento, dias_sem_acionamento,
      tipo_ultimo_acionamento, data_retorno as proximo_retorno, retorno_vencido,
      proxima_acao, (not sem_telefone) as possui_telefone, situacao_operacional,
      ultima_atualizacao, critico_canonico, urgente_canonico
    from tmp_det
    order by
      case when v_dir='asc' then
        case v_ordem when 'saldo_vencido' then saldo_vencido when 'saldo_total' then saldo_total
          when 'dias_sem_acionamento' then coalesce(dias_sem_acionamento,999999)::numeric
          when 'dias_atraso' then coalesce(dias_atraso,0)::numeric else saldo_vencido end
      end asc nulls last,
      case when v_dir='desc' then
        case v_ordem when 'saldo_vencido' then saldo_vencido when 'saldo_total' then saldo_total
          when 'dias_sem_acionamento' then coalesce(dias_sem_acionamento,-1)::numeric
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
end; $$;
revoke all on function public.saude_carteira_detalhes(jsonb,integer,integer) from public, anon;
grant execute on function public.saude_carteira_detalhes(jsonb,integer,integer) to authenticated;
