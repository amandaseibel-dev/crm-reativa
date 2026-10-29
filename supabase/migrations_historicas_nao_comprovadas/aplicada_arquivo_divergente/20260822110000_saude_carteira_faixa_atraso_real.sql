-- ============================================================================
-- SAÚDE DA CARTEIRA — FAIXA DE ATRASO REAL
-- ----------------------------------------------------------------------------
-- casos.dias_atraso vem da carga e está defasado (527/528 casos de um operador
-- apareciam "A vencer" com R$ 1,98M vencido). dias_atraso/faixa_atraso da view
-- passam a ser calculados pelo vencimento em aberto mais antigo: título original
-- (acordos_titulos ABERTO/em_aberto sem acordo) ou parcela vencida do acordo.
-- Mesma regra da RPC calibragem_efetividade_carteira. Colunas/ordem/tipos
-- preservados (create or replace; mv_saude_carteira só precisa de refresh).
-- ============================================================================
begin;
create or replace view public.vw_saude_carteira as
with acc as (
  select ac.aluno_id,
    count(*) filter (where ac.status='ATIVO') as acordos_ativos,
    bool_or(p.status='VENCIDA') as tem_parcela_vencida,
    min(p.vencimento) filter (where p.status='VENCIDA') as parcela_vencida_mais_antiga,
    min(p.vencimento) filter (where p.status='A_VENCER') as proxima_parcela_a_vencer
  from acordos ac left join parcelas p on p.acordo_id=ac.id and p.status in ('VENCIDA','A_VENCER')
  where ac.status='ATIVO' group by ac.aluno_id
),
-- título original (mensalidade) vencido e em aberto mais antigo por aluno
tit as (
  select t.aluno_id, min(t.vencimento) titulo_vencido_mais_antigo
  from acordos_titulos t
  where t.situacao='ABERTO' and t.status='em_aberto' and t.acordo_id is null
    and t.vencimento < current_date
  group by t.aluno_id
)
select c.id as caso_id, c.caso_codigo, c.aluno_id,
  coalesce(c.cpf_mascarado, a.cpf_mascarado) as cpf_mascarado,
  coalesce(nullif(regexp_replace(coalesce(c.cpf_limpo,''),'[^0-9]','','g'),''), nullif(regexp_replace(coalesce(a.cpf,''),'[^0-9]','','g'),'')) as cpf_conta,
  saude_carteira_norm_unidade(a.unidade) as estabelecimento,
  coalesce(nullif(trim(c.operador_email),''), nullif(trim(a.responsavel_atual_email),'')) as operador_email,
  coalesce(nullif(trim(c.operador_nome),''), nullif(trim(a.responsavel_atual_nome),'')) as operador_nome,
  coalesce(c.saldo_vencido,0) as saldo_vencido, coalesce(c.saldo_total,0) as saldo_total,
  c.situacao_operacional, c.criticidade, (current_date - least(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga))::int as dias_atraso, c.proximo_vencimento, c.data_retorno,
  c.data_ultimo_acionamento, c.status_acionamento as tipo_ultimo_acionamento, c.proxima_acao_automatica as proxima_acao,
  case when c.data_ultimo_acionamento is null then null else greatest(0, current_date - c.data_ultimo_acionamento) end as dias_sem_acionamento,
  c.data_ultimo_acionamento is null as nunca_acionado,
  case
    when c.data_ultimo_acionamento is null then 'NUNCA'
    when (current_date - c.data_ultimo_acionamento) <= 1 then '1D'
    when (current_date - c.data_ultimo_acionamento) <= 3 then '2_3D'
    when (current_date - c.data_ultimo_acionamento) <= 5 then '4_5D'
    when (current_date - c.data_ultimo_acionamento) <= 7 then '6_7D'
    when (current_date - c.data_ultimo_acionamento) <= 15 then '8_15D'
    when (current_date - c.data_ultimo_acionamento) <= 30 then '16_30D'
    else 'MAIS_30D' end as faixa_tempo_sem_acionamento,
  case
    when coalesce((current_date - least(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)),0) <= 0 then 'A_VENCER'
    when (current_date - least(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 30 then '1_30' when (current_date - least(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 60 then '31_60'
    when (current_date - least(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 90 then '61_90' when (current_date - least(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 180 then '91_180'
    when (current_date - least(tit.titulo_vencido_mais_antigo, acc.parcela_vencida_mais_antiga)) <= 365 then '181_365' else 'MAIS_365' end as faixa_atraso,
  (c.data_retorno is not null and c.data_retorno < current_date) as retorno_vencido,
  (coalesce(nullif(trim(a.telefone),''), nullif(trim(a.telefone_resp1),''), nullif(trim(a.telefone_resp2),'')) is null) as sem_telefone,
  (nullif(trim(a.telefone),'') is not null)::int + (nullif(trim(a.telefone_resp1),'') is not null)::int + (nullif(trim(a.telefone_resp2),'') is not null)::int as qtd_telefones,
  (a.email is null or trim(a.email)='') as sem_email,
  (coalesce(nullif(trim(c.operador_email),''), nullif(trim(a.responsavel_atual_email),'')) is null) as sem_responsavel,
  case
    when coalesce(acc.acordos_ativos,0)=0 then 'SEM_ACORDO'
    when acc.tem_parcela_vencida and acc.parcela_vencida_mais_antiga < (current_date-30) then 'QUEBRADO'
    when acc.tem_parcela_vencida then 'VENCIDO' else 'EM_DIA' end as acordo_situacao,
  acc.proxima_parcela_a_vencer, acc.parcela_vencida_mais_antiga,
  (upper(coalesce(c.criticidade,''))='CRITICO' and coalesce(c.saldo_vencido,0)>0) as critico_canonico,
  (upper(coalesce(c.criticidade,''))='URGENTE' and coalesce(c.saldo_vencido,0)>0) as urgente_canonico,
  caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada) as encerrado,
  c.caso_atualizado_em as ultima_atualizacao,
  -- FIDELIZAÇÃO (10 dias a partir do último acionamento válido)
  case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate,
  case when c.data_ultimo_acionamento is not null then (c.data_ultimo_acionamento + 10) - current_date end as dias_fidelizacao,
  caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado) as protegido,
  case
    when coalesce(nullif(trim(c.operador_email),''), nullif(trim(a.responsavel_atual_email),'')) is null then 'LIVRE'
    when caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado) then 'PROTEGIDA'
    when c.data_ultimo_acionamento is null then 'EXPIRADA'
    when (c.data_ultimo_acionamento + 10) - current_date < 0 then 'EXPIRADA'
    when (c.data_ultimo_acionamento + 10) - current_date = 0 then 'ULTIMO_DIA'
    when (c.data_ultimo_acionamento + 10) - current_date = 1 then 'URGENTE'
    when (c.data_ultimo_acionamento + 10) - current_date <= 3 then 'ATENCAO'
    else 'ATIVA' end as fidelizacao_situacao
from casos c
left join alunos a on a.id=c.aluno_id
left join acc on acc.aluno_id=c.aluno_id
left join tit on tit.aluno_id=c.aluno_id;
refresh materialized view concurrently public.mv_saude_carteira;
update public.saude_carteira_mv_meta set atualizado_em=now() where id;
commit;
