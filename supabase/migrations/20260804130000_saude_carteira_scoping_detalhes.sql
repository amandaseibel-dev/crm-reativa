-- =====================================================================
-- SAÚDE COMPLETA DA CARTEIRA — escopo/autorização + detalhamento + qualidade
-- Autorização DENTRO das RPCs (não confiar no filtro do frontend).
--   * Gestão (usuario_e_gestao: amanda, cobranca04, cobranca07): visão global.
--   * Operador conhecido (usuarios/operadores ativo): escopo FORÇADO ao próprio
--     e-mail (sobrepõe qualquer filtro de operador recebido).
--   * Sem e-mail ou sem perfil: acesso negado (42501).
-- Sem SQL dinâmico. Sem CPF/telefone completos. Nenhuma escrita operacional.
-- =====================================================================

-- Helper de escopo: valida o usuário e devolve os filtros efetivos.
create or replace function public.saude_carteira_escopo(p_filtros jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_is_gestao boolean := public.usuario_e_gestao();
  v_operador_forcado text := null;
begin
  if v_email = '' then
    raise exception 'Acesso negado: nao autenticado.' using errcode = '42501';
  end if;

  if not v_is_gestao then
    -- precisa ser um usuário/operador conhecido e ativo
    if not exists (select 1 from public.usuarios u where lower(u.email)=v_email and u.ativo)
       and not exists (select 1 from public.operadores o where lower(o.email)=v_email and o.ativo) then
      raise exception 'Acesso negado: perfil nao autorizado.' using errcode = '42501';
    end if;
    v_operador_forcado := v_email;  -- escopo forçado ao próprio login
  end if;

  return jsonb_build_object(
    'email', v_email,
    'is_gestao', v_is_gestao,
    'operador_forcado', v_operador_forcado,
    -- filtros efetivos: operador é sobreposto para não-gestão
    'filtros', case when v_operador_forcado is not null
                    then coalesce(p_filtros,'{}'::jsonb) || jsonb_build_object('operador_email', v_operador_forcado)
                    else coalesce(p_filtros,'{}'::jsonb) end
  );
end;
$$;
revoke all on function public.saude_carteira_escopo(jsonb) from public, anon;

-- ---------------------------------------------------------------------
-- RPC de resumo v2 — com escopo interno + card "acordos em dia sem
-- acompanhamento programado". Reconciliação preservada (fonte única).
-- ---------------------------------------------------------------------
create or replace function public.saude_carteira_resumo(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
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
  select * from public.vw_saude_carteira v
  where (v_incluir_encerrados or v.encerrado = false)
    and (v_estab is null or v.estabelecimento = v_estab)
    and (v_operador is null or v.operador_email is not distinct from v_operador);

  select jsonb_build_object(
    'casos_ativos', count(*), 'cpfs_unicos', count(distinct cpf_conta),
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
    'min_dias_sem_acionamento', v_min_dias
  ) into v_totais from tmp_sc;

  select jsonb_agg(t order by t.sem_acionamento_limite desc) into v_estabs from (
    select estabelecimento, count(*) as casos_ativos, count(distinct cpf_conta) as cpfs_unicos,
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
      count(*) filter (where cpf_conta is null or aluno_id is null) as casos_revisao
    from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.estabelecimento) into v_mtx_faixa from (
    select estabelecimento,
      count(*) filter (where faixa_atraso='A_VENCER') as a_vencer,
      count(*) filter (where faixa_atraso='1_30') as f1_30, count(*) filter (where faixa_atraso='31_60') as f31_60,
      count(*) filter (where faixa_atraso='61_90') as f61_90, count(*) filter (where faixa_atraso='91_180') as f91_180,
      count(*) filter (where faixa_atraso='181_365') as f181_365, count(*) filter (where faixa_atraso='MAIS_365') as f_mais_365,
      count(distinct cpf_conta) as cpfs, coalesce(sum(saldo_vencido),0) as saldo_vencido,
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
      count(distinct cpf_conta) as cpfs, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) as total
    from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.casos_ativos desc) into v_operadores from (
    select coalesce(operador_email,'(SEM RESPONSAVEL)') as operador_email, count(*) as casos_ativos,
      count(distinct cpf_conta) as cpfs_unicos, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) filter (where nunca_acionado) as nunca_acionados,
      count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) as sem_acionamento_limite,
      round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1),1) as pct_sem_acionamento,
      count(*) filter (where retorno_vencido) as retornos_vencidos, count(*) filter (where sem_telefone) as sem_telefone,
      count(*) filter (where critico_canonico) as criticos, count(*) filter (where urgente_canonico) as urgentes,
      count(*) filter (where acordo_situacao='EM_DIA') as acordos_em_dia,
      count(*) filter (where acordo_situacao='VENCIDO') as acordos_vencidos
    from tmp_sc group by coalesce(operador_email,'(SEM RESPONSAVEL)')
  ) t;

  return jsonb_build_object('totais', v_totais, 'estabelecimentos', coalesce(v_estabs,'[]'::jsonb),
    'matriz_faixa_atraso', coalesce(v_mtx_faixa,'[]'::jsonb),
    'matriz_tempo_sem_acionamento', coalesce(v_mtx_tempo,'[]'::jsonb),
    'operadores', coalesce(v_operadores,'[]'::jsonb),
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'filtros', v_f, 'gerado_em', now());
end; $$;
revoke all on function public.saude_carteira_resumo(jsonb) from public, anon;

-- ---------------------------------------------------------------------
-- RPC de detalhamento — paginada, mascarada, ordenação por allowlist.
-- Aplica um "indicador" opcional (p_filtros->>'indicador') para reconciliar
-- card/célula com a lista exata.
-- ---------------------------------------------------------------------
create or replace function public.saude_carteira_detalhes(
  p_filtros jsonb default '{}'::jsonb,
  p_limite integer default 50,
  p_offset integer default 0
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
  v_lim int := least(greatest(coalesce(p_limite,50),1),500);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_total int; v_rows jsonb;
begin
  drop table if exists tmp_det; create temporary table tmp_det on commit drop as
  select * from public.vw_saude_carteira v
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

  -- ordenação por allowlist (sem SQL dinâmico): coluna de ordenação materializada
  select jsonb_agg(row_to_json(x)) into v_rows from (
    select estabelecimento, caso_id, caso_codigo, cpf_mascarado as aluno_mascarado,
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
    'filtros', v_f, 'gerado_em', now());
end; $$;
revoke all on function public.saude_carteira_detalhes(jsonb,integer,integer) from public, anon;

-- ---------------------------------------------------------------------
-- RPC de qualidade da carteira (inconsistências; somente leitura).
-- ---------------------------------------------------------------------
create or replace function public.saude_carteira_qualidade(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_operador text := nullif(v_f->>'operador_email','');
  v_r jsonb;
begin
  drop table if exists tmp_q; create temporary table tmp_q on commit drop as
  select * from public.vw_saude_carteira v
  where v.encerrado = false
    and (v_operador is null or v.operador_email is not distinct from v_operador);

  select jsonb_build_object(
    'sem_telefone', count(*) filter (where sem_telefone),
    'sem_email', count(*) filter (where sem_email),
    'sem_responsavel', count(*) filter (where sem_responsavel),
    'sem_estabelecimento', count(*) filter (where estabelecimento = '(SEM ESTABELECIMENTO)'),
    'sem_faixa_atraso', count(*) filter (where dias_atraso is null),
    'saldo_zero_ativo', count(*) filter (where coalesce(saldo_total,0) <= 0),
    'caso_sem_aluno', count(*) filter (where aluno_id is null),
    'acordo_vencido_sem_saldo', count(*) filter (where acordo_situacao='VENCIDO' and coalesce(saldo_vencido,0)=0),
    'sem_cpf', count(*) filter (where cpf_conta is null),
    'critico_sem_saldo_vencido', count(*) filter (where upper(coalesce(criticidade,''))='CRITICO' and coalesce(saldo_vencido,0)=0)
  ) into v_r from tmp_q;

  return jsonb_build_object('qualidade', v_r,
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'gerado_em', now());
end; $$;
revoke all on function public.saude_carteira_qualidade(jsonb) from public, anon;

-- Grants: agora SEGURO conceder a authenticated — autorização é interna (escopo).
grant execute on function public.saude_carteira_resumo(jsonb) to authenticated;
grant execute on function public.saude_carteira_detalhes(jsonb,integer,integer) to authenticated;
grant execute on function public.saude_carteira_qualidade(jsonb) to authenticated;
