-- =====================================================================
-- SAÚDE COMPLETA DA CARTEIRA — backend núcleo (somente leitura/análise)
-- Fonte única: vw_saude_carteira. Resumo, matrizes e detalhamento leem
-- da MESMA view => reconciliação (indicador = detalhamento) por construção.
--
-- Regras canônicas ancoradas (NÃO reinventar):
--   * Elegibilidade da carteira: NOT caso_encerrado_operacional(...)
--   * Saldo vencido/total: colunas persistidas casos.saldo_vencido / saldo_total
--   * Último acionamento válido: casos.data_ultimo_acionamento
--     (mantido por fn_atualizar_ultimo_acionamento via eh_tipo_acionamento)
--   * Estabelecimento: alunos.unidade normalizado (saude_carteira_norm_unidade)
--   * Titularidade: coalesce(casos.operador_email, alunos.responsavel_atual_email)
--   * Acordo em dia/vencido/quebrado: DERIVADO das parcelas (não há status)
--       em dia = ATIVO, 0 parcela VENCIDA aberta
--       vencido = ATIVO, >=1 parcela VENCIDA aberta
--       quebrado = ATIVO, parcela VENCIDA mais antiga há > 30 dias
--   * Crítico/Urgente: coluna criticidade COM gate saldo_vencido > 0
--   * CPF único (cpf_conta): dígitos de casos.cpf_limpo, senão alunos.cpf
--     (chave INTERNA de contagem; NUNCA exposta no detalhamento)
-- Nenhuma escrita em dados operacionais. Objetos novos e aditivos.
-- Rulings da gestão (Amanda, 2026-08-04): estabelecimento normalizado;
-- titularidade coalesce(operador_email, responsavel_atual_email);
-- retorno vencido caso-level; acordo derivado das parcelas (quebrado > 30d).
-- =====================================================================

-- 1) Normalização canônica de estabelecimento (colapsa encoding/nome-longo,
--    preserva estabelecimentos distintos). Validada contra produção: 35 -> 23.
create or replace function public.saude_carteira_norm_unidade(p_unidade text)
returns text language plpgsql immutable set search_path to 'public' as $$
declare u0 text;
begin
  if p_unidade is null or trim(p_unidade) = '' then return '(SEM ESTABELECIMENTO)'; end if;
  u0 := upper(regexp_replace(unaccent(trim(p_unidade)), '\s+', ' ', 'g'));
  return case
    when u0 like '%POP%' then 'ULBRA POP'
    when u0 like '%EAD%' then 'EAD'
    when u0 like '%CANOAS%' then 'CAMPUS CANOAS'
    when u0 like '%PALMAS%' and u0 like '%MEDICINA%' then 'ULBRA MEDICINA - PALMAS'
    when u0 like '%PALMAS%' or u0 like '%CEULP%' then 'CENTRO UNIV. PALMAS/TO'
    when u0 like '%MANAUS%' and u0 like '%MEDICINA%' then 'ULBRA MEDICINA - MANAUS'
    when u0 like '%MANAUS%' or u0 like '%CEULM%' then 'CENTRO UNIV. MANAUS/AM'
    when u0 like '%SANTAR%' and u0 like '%MEDICINA%' then 'ULBRA MEDICINA - SANTAREM'
    when u0 like '%SANTAR%' or u0 like '%CEULS%' then 'CENTRO UNIV. SANTAREM/PA'
    when u0 like '%ITUMBIARA%' then 'ILES ITUMBIARA/GO'
    when u0 like '%TORRES%' then 'CAMPUS TORRES'
    when u0 like '%SANTA MARIA%' then 'CAMPUS SANTA MARIA'
    when u0 like '%CACHOEIRA%' then 'CAMPUS CACHOEIRA DO SUL'
    when u0 like '%JERONIMO%' then 'CAMPUS SAO JERONIMO'
    when u0 like '%GUAIBA%' then 'CAMPUS GUAIBA'
    when u0 like '%CARAZINHO%' then 'CAMPUS CARAZINHO'
    when u0 like '%SAJ%' then 'ULBRA MEDICINA - SAJ'
    when u0 like '%MEDICINA%' and u0 like '%POA%' then 'ULBRA MEDICINA - POA'
    when u0 like '%GRAVATA%' and u0 like '%MEDICINA%' then 'ULBRA MEDICINA - GRAVATAI'
    when u0 like '%GRAVATA%II%' then 'CAMPUS GRAVATAI II'
    when u0 like '%GRAVATA%' then 'CAMPUS GRAVATAI'
    else u0
  end;
end; $$;

-- 2) View base única — uma linha por caso, enriquecida.
create or replace view public.vw_saude_carteira as
with acc as (
  select ac.aluno_id,
         count(*) filter (where ac.status = 'ATIVO') as acordos_ativos,
         bool_or(p.status = 'VENCIDA') as tem_parcela_vencida,
         min(p.vencimento) filter (where p.status = 'VENCIDA') as parcela_vencida_mais_antiga,
         min(p.vencimento) filter (where p.status = 'A_VENCER') as proxima_parcela_a_vencer
    from public.acordos ac
    left join public.parcelas p on p.acordo_id = ac.id and p.status in ('VENCIDA','A_VENCER')
   where ac.status = 'ATIVO'
   group by ac.aluno_id
)
select
  c.id as caso_id, c.caso_codigo, c.aluno_id,
  coalesce(c.cpf_mascarado, a.cpf_mascarado) as cpf_mascarado,
  coalesce(nullif(regexp_replace(coalesce(c.cpf_limpo,''),'[^0-9]','','g'),''),
           nullif(regexp_replace(coalesce(a.cpf,''),'[^0-9]','','g'),'')) as cpf_conta,
  public.saude_carteira_norm_unidade(a.unidade) as estabelecimento,
  coalesce(nullif(trim(c.operador_email),''), nullif(trim(a.responsavel_atual_email),'')) as operador_email,
  coalesce(nullif(trim(c.operador_nome),''),  nullif(trim(a.responsavel_atual_nome),''))  as operador_nome,
  coalesce(c.saldo_vencido, 0)::numeric as saldo_vencido,
  coalesce(c.saldo_total, 0)::numeric as saldo_total,
  c.situacao_operacional, c.criticidade, c.dias_atraso, c.proximo_vencimento, c.data_retorno,
  c.data_ultimo_acionamento, c.status_acionamento as tipo_ultimo_acionamento,
  c.proxima_acao_automatica as proxima_acao,
  case when c.data_ultimo_acionamento is null then null else greatest(0, (current_date - c.data_ultimo_acionamento)) end as dias_sem_acionamento,
  (c.data_ultimo_acionamento is null) as nunca_acionado,
  case
    when c.data_ultimo_acionamento is null then 'NUNCA'
    when (current_date - c.data_ultimo_acionamento) <= 1  then '1D'
    when (current_date - c.data_ultimo_acionamento) <= 3  then '2_3D'
    when (current_date - c.data_ultimo_acionamento) <= 5  then '4_5D'
    when (current_date - c.data_ultimo_acionamento) <= 7  then '6_7D'
    when (current_date - c.data_ultimo_acionamento) <= 15 then '8_15D'
    when (current_date - c.data_ultimo_acionamento) <= 30 then '16_30D'
    else 'MAIS_30D'
  end as faixa_tempo_sem_acionamento,
  case
    when coalesce(c.dias_atraso,0) <= 0 then 'A_VENCER'
    when c.dias_atraso <= 30  then '1_30'
    when c.dias_atraso <= 60  then '31_60'
    when c.dias_atraso <= 90  then '61_90'
    when c.dias_atraso <= 180 then '91_180'
    when c.dias_atraso <= 365 then '181_365'
    else 'MAIS_365'
  end as faixa_atraso,
  (c.data_retorno is not null and c.data_retorno < current_date) as retorno_vencido,
  (coalesce(nullif(trim(a.telefone),''), nullif(trim(a.telefone_resp1),''), nullif(trim(a.telefone_resp2),'')) is null) as sem_telefone,
  (nullif(trim(a.telefone),'') is not null)::int + (nullif(trim(a.telefone_resp1),'') is not null)::int + (nullif(trim(a.telefone_resp2),'') is not null)::int as qtd_telefones,
  (a.email is null or trim(a.email) = '') as sem_email,
  (coalesce(nullif(trim(c.operador_email),''), nullif(trim(a.responsavel_atual_email),'')) is null) as sem_responsavel,
  case
    when coalesce(acc.acordos_ativos,0) = 0 then 'SEM_ACORDO'
    when acc.tem_parcela_vencida and acc.parcela_vencida_mais_antiga < (current_date - 30) then 'QUEBRADO'
    when acc.tem_parcela_vencida then 'VENCIDO'
    else 'EM_DIA'
  end as acordo_situacao,
  acc.proxima_parcela_a_vencer, acc.parcela_vencida_mais_antiga,
  (upper(coalesce(c.criticidade,'')) = 'CRITICO' and coalesce(c.saldo_vencido,0) > 0) as critico_canonico,
  (upper(coalesce(c.criticidade,'')) = 'URGENTE' and coalesce(c.saldo_vencido,0) > 0) as urgente_canonico,
  public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada) as encerrado,
  c.caso_atualizado_em as ultima_atualizacao
from public.casos c
left join public.alunos a on a.id = c.aluno_id
left join acc on acc.aluno_id = c.aluno_id;

comment on view public.vw_saude_carteira is 'Saude Completa da Carteira: fonte unica por caso; regras canonicas ancoradas. cpf_conta e chave interna de contagem (NAO expor no detalhamento).';
revoke all on public.vw_saude_carteira from public, anon, authenticated;

-- 3) RPC de resumo (cards + por estabelecimento + matrizes + operadores).
--    VOLATILE: necessário para CREATE TEMP TABLE (materializa a view 1x/chamada).
create or replace function public.saude_carteira_resumo(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
declare
  v_incluir_encerrados boolean := coalesce((p_filtros->>'incluir_encerrados')::boolean, false);
  v_min_dias int := coalesce((p_filtros->>'min_dias_sem_acionamento')::int, 5);
  v_estab text := nullif(p_filtros->>'estabelecimento','');
  v_operador text := nullif(p_filtros->>'operador_email','');
  v_totais jsonb; v_estabs jsonb; v_mtx_faixa jsonb; v_mtx_tempo jsonb; v_operadores jsonb;
begin
  create temporary table tmp_sc on commit drop as
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
      count(*) as total from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.estabelecimento) into v_mtx_tempo from (
    select estabelecimento,
      count(*) filter (where faixa_tempo_sem_acionamento='NUNCA') as nunca,
      count(*) filter (where faixa_tempo_sem_acionamento='1D') as d1, count(*) filter (where faixa_tempo_sem_acionamento='2_3D') as d2_3,
      count(*) filter (where faixa_tempo_sem_acionamento='4_5D') as d4_5, count(*) filter (where faixa_tempo_sem_acionamento='6_7D') as d6_7,
      count(*) filter (where faixa_tempo_sem_acionamento='8_15D') as d8_15, count(*) filter (where faixa_tempo_sem_acionamento='16_30D') as d16_30,
      count(*) filter (where faixa_tempo_sem_acionamento='MAIS_30D') as d_mais_30, count(*) as total
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
    'operadores', coalesce(v_operadores,'[]'::jsonb), 'filtros', p_filtros, 'gerado_em', now());
end; $$;

-- Permissão: revogado de public/anon. O grant a papéis autenticados fica
-- PENDENTE até o scoping por operador estar embutido na RPC (segurança:
-- operador não pode ter visão global). Hoje só service_role executa.
revoke all on function public.saude_carteira_resumo(jsonb) from public, anon;
