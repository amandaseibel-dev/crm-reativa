-- ============================================================================
-- Ações Massivas — PENETRAÇÃO POR ANO DA DÍVIDA + SITUAÇÃO DE MENSALIDADES E
-- ACORDOS (visão gerencial). Somente LEITURA e AGREGAÇÃO — não altera saldos,
-- pagamentos, acordos, parcelas, responsáveis ou dados operacionais.
-- ----------------------------------------------------------------------------
-- BASE COMPLETA (carteira ativa): TODOS os casos (atribuídos + livres,
--   fidelização ativa ou expirada). casos é 1:1 por aluno. Exclui encerrados/
--   quitados/cancelados/jurídico (caso_encerrado_operacional) e opt-out
--   (casos.nao_acionar). Só entra quem tem dívida ativa (título original em
--   aberto OU parcela de acordo ATIVO em aberto).
--
-- ANO DA DÍVIDA = ano do VENCIMENTO da dívida real:
--   * mensalidade original em aberto (acordos_titulos, não superada por acordo)
--     -> ano do vencimento do título;
--   * parcela de acordo ATIVO (parcelas VENCIDA/A_VENCER) -> ano do vencimento
--     da parcela.
--   Sem vencimento confiável -> "SEM ANO IDENTIFICADO".
--   NÃO mistura saldo vencido x futuro x mensalidade original x parcela de
--   acordo; título superado por acordo NÃO é somado (evita dupla contagem).
--
-- SITUAÇÃO calculada pelas PARCELAS/TÍTULOS reais (não só status do acordo):
--   acordo_situacao canônico (igual vw_saude_carteira):
--     SEM_ACORDO  -> 0 acordos ATIVO
--     QUEBRADO    -> parcela VENCIDA mais antiga < hoje-30
--     VENCIDO     -> tem parcela VENCIDA (>= hoje-30)
--     EM_DIA      -> acordo ATIVO sem parcela vencida
--   (QUITADO/CANCELADO vêm de acordos.status.)
--   parcelas.status: A_VENCER | VENCIDA | PAGO | CANCELADA ; is_entrada = entrada.
--
-- ACIONAMENTO MANUAL = aluno_movimentacoes com eh_tipo_acionamento(), exceto
--   tipos massivos e autor SISTEMA. MASSIVO = destinatários ENVIADO/PREPARADO
--   (+ movimentações tipo massivo); rascunho/agendada/cancelada/excluído/erro
--   não contam.
--
-- Segurança: SECURITY DEFINER, search_path fixo, gate usuario_e_gestao() por
--   JWT, EXECUTE revogado de public/anon. Saída agregada e mascarada.
-- ============================================================================

create index if not exists ix_acordos_titulos_aluno_venc
  on public.acordos_titulos (aluno_id, vencimento);
create index if not exists ix_parcelas_acordo_status_venc
  on public.parcelas (acordo_id, status, vencimento);
create index if not exists ix_aluno_mov_tipo_data
  on public.aluno_movimentacoes (tipo, registrado_em);
create index if not exists ix_amd_status_campanha
  on public.acoes_massivas_destinatarios (status, campanha_id);

-- ----------------------------------------------------------------------------
-- Núcleo interno: popula tabelas TEMPORÁRIAS reutilizadas pela visão agregada e
-- pelo detalhamento. Recebe filtros normalizados + limites de período.
--   tmp_pen_base  : 1 linha/aluno da base ativa (flags de situação)
--   tmp_pen_debt  : 1 linha/(aluno, ano, fonte, bucket) com saldo
--   tmp_pen_ba    : 1 linha/(aluno, ano) agregada (mens/acordo, vencido/futuro)
--   tmp_pen_acted : distinct (aluno, ano, canal 'M'/'X') no período
--   tmp_pen_manual/tmp_pen_massivo/tmp_pen_massivo_ev
-- ----------------------------------------------------------------------------
create or replace function public._penetracao_ano_montar(
  p_ini        timestamptz,
  p_fim        timestamptz,
  p_filtros    jsonb,
  p_hoje       date
) returns void language plpgsql volatile security definer
set search_path to 'public' set statement_timeout to '90s' as $$
declare
  v_unidade    text := nullif(p_filtros->>'unidade','');
  v_curso      text := nullif(p_filtros->>'curso','');
  v_sit        text := nullif(p_filtros->>'situacao_academica','');
  v_operador   text := nullif(p_filtros->>'operador_email','');
  v_criticidade text := nullif(p_filtros->>'criticidade','');
  v_carteira   text := nullif(p_filtros->>'carteira','');      -- 'livre' | 'atribuido'
  v_fidel      text := nullif(p_filtros->>'fidelizacao','');   -- 'ativa' | 'expirada'
  v_saldo_min  numeric := nullif(p_filtros->>'saldo_min','')::numeric;   -- saldo total
  v_saldo_max  numeric := nullif(p_filtros->>'saldo_max','')::numeric;
  v_venc_min   numeric := nullif(p_filtros->>'saldo_vencido_min','')::numeric;
  v_venc_max   numeric := nullif(p_filtros->>'saldo_vencido_max','')::numeric;
  v_pv_min     int := nullif(p_filtros->>'parcelas_vencidas_min','')::int;
  v_atraso_min int := nullif(p_filtros->>'atraso_min','')::int;
  v_atraso_max int := nullif(p_filtros->>'atraso_max','')::int;
  v_com_acordo text := nullif(p_filtros->>'com_acordo','');    -- 'com' | 'sem'
  v_situacoes  jsonb := case when jsonb_typeof(p_filtros->'situacoes')='array' then p_filtros->'situacoes' else '[]'::jsonb end;
begin
  -- Agregado de mensalidades ORIGINAIS em aberto (não superadas por acordo).
  drop table if exists tmp_pen_tit;
  create temporary table tmp_pen_tit on commit drop as
  select t.aluno_id,
         bool_or(t.vencimento <  p_hoje) as tem_venc,
         bool_or(t.vencimento >= p_hoje) as tem_fut,
         round(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento <  p_hoje)::numeric,2) as saldo_venc,
         round(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento >= p_hoje)::numeric,2) as saldo_fut,
         min(t.vencimento) filter (where t.vencimento < p_hoje) as venc_mais_antigo
  from public.acordos_titulos t
  where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
    and coalesce(lower(t.status),'') not in ('quitada')
    and t.vencimento is not null
    and not exists (
      select 1 from public.acordo_titulo_vinculo v
      join public.acordos a on a.id = v.acordo_id
      where v.titulo_id = t.id and coalesce(v.ativo,true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
    and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
  group by t.aluno_id;

  -- Agregado de PARCELAS de acordos ATIVO (situação real).
  drop table if exists tmp_pen_parc;
  create temporary table tmp_pen_parc on commit drop as
  select a.aluno_id,
         bool_or(p.status='VENCIDA') as tem_parc_venc,
         bool_or(p.status='A_VENCER') as tem_parc_fut,
         bool_or(p.is_entrada and p.status='VENCIDA') as tem_entrada_venc,
         bool_or(p.status='A_VENCER' and p.vencimento = p_hoje) as tem_parc_hoje,
         count(*) filter (where p.status='VENCIDA')::int as qtd_parc_venc,
         min(p.vencimento) filter (where p.status='VENCIDA') as venc_parc_antiga,
         min(p.vencimento) filter (where p.status='A_VENCER' and p.vencimento >= p_hoje) as prox_parc,
         round(sum(p.valor) filter (where p.status='VENCIDA')::numeric,2)  as saldo_parc_venc,
         round(sum(p.valor) filter (where p.status='A_VENCER')::numeric,2) as saldo_parc_fut
  from public.acordos a
  join public.parcelas p on p.acordo_id = a.id and p.status in ('VENCIDA','A_VENCER')
  where a.status='ATIVO'
  group by a.aluno_id;

  -- Flags de acordo por aluno (ativo/cancelado/quitado + negociação de título).
  drop table if exists tmp_pen_aflags;
  create temporary table tmp_pen_aflags on commit drop as
  select a.aluno_id,
         count(*) filter (where a.status='ATIVO')::int as cnt_ativo,
         bool_or(a.status='CANCELADO') as tem_cancelado,
         bool_or(a.status='QUITADO')   as tem_quitado,
         bool_or(a.status='ATIVO' and coalesce(a.entrada_paga,false)=false
                 and coalesce(a.valor_entrada,0) > 0 and a.data_entrada is not null
                 and a.data_entrada < p_hoje) as tem_entrada_venc_ac
  from public.acordos a group by a.aluno_id;

  drop table if exists tmp_pen_negoc;
  create temporary table tmp_pen_negoc on commit drop as
  select distinct v.titulo_id, t2.aluno_id
  from public.acordo_titulo_vinculo v
  join public.acordos a on a.id=v.acordo_id and coalesce(v.ativo,true) and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
  join public.acordos_titulos t2 on t2.id = v.titulo_id;

  -- BASE ATIVA (todos os casos; dívida ativa; sem encerrado/quitado/opt-out).
  drop table if exists tmp_pen_base;
  create temporary table tmp_pen_base on commit drop as
  select a.id as aluno_id,
         coalesce(c.total_em_aberto,0) as saldo_total,
         c.criticidade,
         c.operador_email,
         (c.data_retorno is not null and c.data_retorno > p_hoje) as em_retorno,
         a.unidade, a.curso, a.situacao_academica,
         a.data_ultimo_acionamento,
         (a.data_ultimo_acionamento is not null and a.data_ultimo_acionamento::date + 10 >= p_hoje) as fidel_ativa,
         coalesce(tt.tem_venc,false) as mens_venc,
         coalesce(tt.tem_fut,false)  as mens_fut,
         coalesce(tt.saldo_venc,0)   as saldo_mens_venc,
         coalesce(tt.saldo_fut,0)    as saldo_mens_fut,
         tt.venc_mais_antigo         as mens_venc_antigo,
         coalesce(pp.tem_parc_venc,false)   as ac_parc_venc,
         coalesce(pp.tem_parc_fut,false)    as ac_parc_fut,
         (coalesce(pp.tem_entrada_venc,false) or coalesce(af.tem_entrada_venc_ac,false)) as ac_entrada_venc,
         coalesce(pp.tem_parc_hoje,false)   as ac_parc_hoje,
         coalesce(pp.qtd_parc_venc,0)       as qtd_parc_venc,
         coalesce(pp.saldo_parc_venc,0)     as saldo_ac_venc,
         coalesce(pp.saldo_parc_fut,0)      as saldo_ac_fut,
         pp.venc_parc_antiga, pp.prox_parc,
         coalesce(af.cnt_ativo,0)     as acordos_ativos,
         coalesce(af.tem_cancelado,false) as tem_cancelado,
         coalesce(af.tem_quitado,false)   as tem_quitado,
         exists (select 1 from tmp_pen_negoc ng where ng.aluno_id=a.id) as mens_negociada,
         -- acordo_situacao canônico
         (case
            when coalesce(af.cnt_ativo,0)=0 then 'SEM_ACORDO'
            when coalesce(pp.tem_parc_venc,false) and pp.venc_parc_antiga < (p_hoje-30) then 'QUEBRADO'
            when coalesce(pp.tem_parc_venc,false) then 'VENCIDO'
            else 'EM_DIA'
          end) as acordo_situacao,
         -- saldo vencido acionável (mensalidade vencida + parcela de acordo vencida)
         (coalesce(tt.saldo_venc,0) + coalesce(pp.saldo_parc_venc,0)) as saldo_vencido_total,
         -- dias de atraso da dívida mais antiga (título ou parcela)
         (p_hoje - least(coalesce(tt.venc_mais_antigo,'9999-12-31'::date),
                         coalesce(pp.venc_parc_antiga,'9999-12-31'::date))) as dias_atraso,
         (case
            when public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO' then true
            when exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                         where s.aluno_id = a.id::text
                           and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) then true
            else false end) as bloqueado_conf
  from public.alunos a
  join public.casos c on c.aluno_id = a.id
  left join tmp_pen_tit tt on tt.aluno_id = a.id
  left join tmp_pen_parc pp on pp.aluno_id = a.id
  left join tmp_pen_aflags af on af.aluno_id = a.id
  where coalesce(a.status_jornada,'') not in ('QUITADO','QUITADO_MANUAL')
    and coalesce(a.status_atual,'')   not in ('QUITADO','QUITADO_MANUAL')
    and not public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
    and not coalesce(c.nao_acionar,false)
    -- dívida ativa: mensalidade original aberta OU parcela de acordo aberta
    and (tt.aluno_id is not null or pp.aluno_id is not null or coalesce(c.total_em_aberto,0) > 0)
    and (v_unidade    is null or a.unidade = v_unidade)
    and (v_curso      is null or a.curso = v_curso)
    and (v_sit        is null or a.situacao_academica = v_sit)
    and (v_criticidade is null or c.criticidade = v_criticidade)
    and (v_operador   is null or c.operador_email = v_operador)
    and (v_carteira is null
         or (v_carteira='livre' and c.operador_email is null)
         or (v_carteira='atribuido' and c.operador_email is not null))
    and (v_saldo_min  is null or coalesce(c.total_em_aberto,0) >= v_saldo_min)
    and (v_saldo_max  is null or coalesce(c.total_em_aberto,0) <= v_saldo_max);

  -- filtros dependentes de flags calculadas
  if v_fidel = 'ativa' then delete from tmp_pen_base where not fidel_ativa; end if;
  if v_fidel = 'expirada' then delete from tmp_pen_base where fidel_ativa; end if;
  if v_venc_min is not null then delete from tmp_pen_base where saldo_vencido_total < v_venc_min; end if;
  if v_venc_max is not null then delete from tmp_pen_base where saldo_vencido_total > v_venc_max; end if;
  if v_pv_min is not null then delete from tmp_pen_base where qtd_parc_venc < v_pv_min; end if;
  if v_atraso_min is not null then delete from tmp_pen_base where coalesce(dias_atraso,-1) < v_atraso_min; end if;
  if v_atraso_max is not null then delete from tmp_pen_base where coalesce(dias_atraso, 2147483647) > v_atraso_max; end if;
  if v_com_acordo='com' then delete from tmp_pen_base where acordos_ativos = 0; end if;
  if v_com_acordo='sem' then delete from tmp_pen_base where acordos_ativos > 0; end if;

  -- filtro de SITUAÇÃO (multi-seleção, OR entre as opções marcadas)
  if jsonb_array_length(v_situacoes) > 0 then
    delete from tmp_pen_base b where not (
         (v_situacoes ? 'mens_vencida'            and b.mens_venc)
      or (v_situacoes ? 'mens_a_vencer'           and b.mens_fut)
      or (v_situacoes ? 'mens_em_dia'             and b.mens_fut and not b.mens_venc)
      or (v_situacoes ? 'mens_vencida_sem_acordo' and b.mens_venc and b.acordos_ativos=0)
      or (v_situacoes ? 'mens_negociada'          and b.mens_negociada)
      or (v_situacoes ? 'somente_originais'       and (b.mens_venc or b.mens_fut) and not b.mens_negociada)
      or (v_situacoes ? 'sem_mensalidade_ativa'   and not b.mens_venc and not b.mens_fut)
      or (v_situacoes ? 'acordo_em_dia'           and b.acordo_situacao='EM_DIA')
      or (v_situacoes ? 'acordo_parcela_vencida'  and b.ac_parc_venc)
      or (v_situacoes ? 'acordo_entrada_vencida'  and b.ac_entrada_venc)
      or (v_situacoes ? 'acordo_parcela_hoje'     and b.ac_parc_hoje)
      or (v_situacoes ? 'acordo_parcela_a_vencer' and b.ac_parc_fut)
      or (v_situacoes ? 'acordo_prox_3'           and b.prox_parc is not null and b.prox_parc <= p_hoje+3)
      or (v_situacoes ? 'acordo_prox_5'           and b.prox_parc is not null and b.prox_parc <= p_hoje+5)
      or (v_situacoes ? 'acordo_prox_7'           and b.prox_parc is not null and b.prox_parc <= p_hoje+7)
      or (v_situacoes ? 'acordo_quebrado'         and b.acordo_situacao='QUEBRADO')
      or (v_situacoes ? 'acordo_cancelado'        and b.tem_cancelado and b.acordos_ativos=0)
      or (v_situacoes ? 'acordo_quitado'          and b.tem_quitado and b.acordos_ativos=0)
      or (v_situacoes ? 'sem_acordo_ativo'        and b.acordos_ativos=0)
    );
  end if;

  -- Dívida por (aluno, ano) — mensalidade original + parcela de acordo, separado.
  drop table if exists tmp_pen_debt;
  create temporary table tmp_pen_debt on commit drop as
    -- mensalidades originais (não superadas)
    select t.aluno_id, extract(year from t.vencimento)::int as ano,
           case when t.vencimento < p_hoje
                then coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) else 0 end as mens_venc,
           case when t.vencimento >= p_hoje
                then coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) else 0 end as mens_fut,
           0::numeric as ac_venc, 0::numeric as ac_fut, 0 as qtd_pv
    from public.acordos_titulos t
    join tmp_pen_base b on b.aluno_id = t.aluno_id
    where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
      and coalesce(lower(t.status),'') not in ('quitada')
      and t.vencimento is not null
      and not exists (select 1 from public.acordo_titulo_vinculo v
        join public.acordos a on a.id=v.acordo_id
        where v.titulo_id=t.id and coalesce(v.ativo,true) and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
      and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
  union all
    -- parcelas de acordo ativo
    select a.aluno_id, extract(year from p.vencimento)::int as ano,
           0::numeric, 0::numeric,
           case when p.status='VENCIDA'  then p.valor else 0 end as ac_venc,
           case when p.status='A_VENCER' then p.valor else 0 end as ac_fut,
           case when p.status='VENCIDA'  then 1 else 0 end as qtd_pv
    from public.acordos a
    join public.parcelas p on p.acordo_id=a.id and p.status in ('VENCIDA','A_VENCER')
    join tmp_pen_base b on b.aluno_id = a.aluno_id
    where a.status='ATIVO' and p.vencimento is not null;

  drop table if exists tmp_pen_ba;
  create temporary table tmp_pen_ba on commit drop as
  select b.aluno_id, d.ano,
         round(coalesce(sum(d.mens_venc),0)::numeric,2) as saldo_mens_venc,
         round(coalesce(sum(d.mens_fut),0)::numeric,2)  as saldo_mens_fut,
         round(coalesce(sum(d.ac_venc),0)::numeric,2)   as saldo_ac_venc,
         round(coalesce(sum(d.ac_fut),0)::numeric,2)    as saldo_ac_fut,
         coalesce(sum(d.qtd_pv),0)::int                 as qtd_parc_venc,
         b.bloqueado_conf, b.em_retorno, b.data_ultimo_acionamento,
         b.acordo_situacao, b.saldo_total
  from tmp_pen_base b
  left join tmp_pen_debt d on d.aluno_id = b.aluno_id
  group by b.aluno_id, d.ano, b.bloqueado_conf, b.em_retorno, b.data_ultimo_acionamento, b.acordo_situacao, b.saldo_total;

  -- Eventos MANUAIS no período.
  drop table if exists tmp_pen_manual;
  create temporary table tmp_pen_manual on commit drop as
  select m.aluno_id::text as aid, count(*)::int as n, max(m.registrado_em) as ult
  from public.aluno_movimentacoes m
  where public.eh_tipo_acionamento(m.tipo)
    and m.tipo not in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')
    and coalesce(upper(m.registrado_por_email),'') <> 'SISTEMA'
    and (p_ini is null or m.registrado_em >= p_ini)
    and (p_fim is null or m.registrado_em <  p_fim)
    and exists (select 1 from tmp_pen_base b where b.aluno_id::text = m.aluno_id::text)
  group by m.aluno_id::text;

  -- Eventos MASSIVOS no período (destinatários processados + movimentações).
  drop table if exists tmp_pen_massivo_ev;
  create temporary table tmp_pen_massivo_ev on commit drop as
    select d.aluno_id::text as aid,
           nullif(g.filtros->>'ano_vencimento','')::int as ano_exp,
           coalesce(d.enviado_em, d.criado_em) as ts
    from public.acoes_massivas_destinatarios d
    join public.acoes_massivas_agendamentos g on g.id = d.campanha_id
    where d.status in ('ENVIADO','PREPARADO')
      and g.status not in ('RASCUNHO','AGENDADO','CANCELADO','FALHOU')
      and (p_ini is null or coalesce(d.enviado_em, d.criado_em) >= p_ini)
      and (p_fim is null or coalesce(d.enviado_em, d.criado_em) <  p_fim)
      and exists (select 1 from tmp_pen_base b where b.aluno_id::text = d.aluno_id::text)
  union all
    select m.aluno_id::text as aid, null::int as ano_exp, m.registrado_em as ts
    from public.aluno_movimentacoes m
    where m.tipo in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')
      and (p_ini is null or m.registrado_em >= p_ini)
      and (p_fim is null or m.registrado_em <  p_fim)
      and exists (select 1 from tmp_pen_base b where b.aluno_id::text = m.aluno_id::text);

  drop table if exists tmp_pen_massivo;
  create temporary table tmp_pen_massivo on commit drop as
  select aid, count(*)::int as n, max(ts) as ult from tmp_pen_massivo_ev group by aid;

  -- Matriz distinct (aluno, ano, canal). Manual/massivo sem ano explícito ->
  -- inferido para todos os anos ativos do aluno; massivo com ano explícito que
  -- casa um ano ativo -> só naquele ano.
  drop table if exists tmp_pen_acted;
  create temporary table tmp_pen_acted on commit drop as
    select ba.aluno_id, ba.ano, 'M'::text as canal
    from tmp_pen_ba ba join tmp_pen_manual mm on mm.aid = ba.aluno_id::text
  union
    select ba.aluno_id, ba.ano, 'X'::text as canal
    from tmp_pen_ba ba
    join tmp_pen_massivo_ev me on me.aid = ba.aluno_id::text
    where me.ano_exp is null
       or me.ano_exp is not distinct from ba.ano
       or not exists (select 1 from tmp_pen_ba bx
            where bx.aluno_id = ba.aluno_id and bx.ano is not distinct from me.ano_exp);
end;
$$;
revoke all on function public._penetracao_ano_montar(timestamptz,timestamptz,jsonb,date) from public, anon;

-- ----------------------------------------------------------------------------
-- Helper: p_filtros -> limites de período (America/Sao_Paulo).
-- ----------------------------------------------------------------------------
create or replace function public._penetracao_ano_periodo(p_filtros jsonb, p_hoje date)
returns table(ini timestamptz, fim timestamptz) language plpgsql immutable
set search_path to 'public' as $$
declare
  v_periodo text := coalesce(nullif(p_filtros->>'periodo',''), 'tudo');
  v_di date := nullif(p_filtros->>'data_ini','')::date;
  v_df date := nullif(p_filtros->>'data_fim','')::date;
  v_tz text := 'America/Sao_Paulo';
begin
  if v_periodo = 'hoje' then
    ini := timezone(v_tz, p_hoje::timestamp);            fim := timezone(v_tz, (p_hoje + 1)::timestamp);
  elsif v_periodo = '7d' then
    ini := timezone(v_tz, (p_hoje - 6)::timestamp);      fim := timezone(v_tz, (p_hoje + 1)::timestamp);
  elsif v_periodo = '30d' then
    ini := timezone(v_tz, (p_hoje - 29)::timestamp);     fim := timezone(v_tz, (p_hoje + 1)::timestamp);
  elsif v_periodo = 'mes_atual' then
    ini := timezone(v_tz, date_trunc('month', p_hoje)::timestamp);
    fim := timezone(v_tz, (date_trunc('month', p_hoje) + interval '1 month')::timestamp);
  elsif v_periodo = 'mes_anterior' then
    ini := timezone(v_tz, (date_trunc('month', p_hoje) - interval '1 month')::timestamp);
    fim := timezone(v_tz, date_trunc('month', p_hoje)::timestamp);
  elsif v_periodo = 'custom' then
    ini := case when v_di is null then null else timezone(v_tz, v_di::timestamp) end;
    fim := case when v_df is null then null else timezone(v_tz, (v_df + 1)::timestamp) end;
  else
    ini := null; fim := null;
  end if;
  return next;
end;
$$;
revoke all on function public._penetracao_ano_periodo(jsonb,date) from public, anon;

-- ----------------------------------------------------------------------------
-- RPC PRINCIPAL — visão agregada por ano da dívida.
-- ----------------------------------------------------------------------------
create or replace function public.acoes_massivas_penetracao_por_ano(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer
set search_path to 'public' set statement_timeout to '90s' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_hoje  date  := (timezone('America/Sao_Paulo', now()))::date;
  v_ini timestamptz; v_fim timestamptz;
  v_matriz jsonb; v_cards jsonb; v_atrib jsonb;
begin
  if v_email = '' then raise exception 'Acesso negado: nao autenticado.' using errcode = '42501'; end if;
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: perfil nao autorizado.' using errcode = '42501'; end if;

  select ini, fim into v_ini, v_fim from public._penetracao_ano_periodo(p_filtros, v_hoje);
  perform public._penetracao_ano_montar(v_ini, v_fim, p_filtros, v_hoje);

  -- Matriz por ano.
  with base as (
    select ba.ano,
           count(distinct ba.aluno_id) as base_ativa,
           count(distinct ba.aluno_id) filter (where not ba.bloqueado_conf and not ba.em_retorno) as base_acionavel,
           count(distinct ba.aluno_id) filter (where ba.bloqueado_conf) as bloqueados_conf,
           count(distinct ba.aluno_id) filter (where ba.saldo_mens_venc > 0) as alunos_mens_venc,
           round(sum(ba.saldo_mens_venc)::numeric,2) as saldo_mens_venc,
           count(distinct ba.aluno_id) filter (where ba.acordo_situacao='EM_DIA' and ba.saldo_ac_fut > 0) as alunos_ac_em_dia,
           round(sum(ba.saldo_ac_fut) filter (where ba.acordo_situacao='EM_DIA')::numeric,2) as saldo_ac_em_dia_fut,
           count(distinct ba.aluno_id) filter (where ba.saldo_ac_venc > 0) as alunos_ac_venc,
           round(sum(ba.saldo_ac_venc)::numeric,2) as saldo_ac_venc,
           sum(ba.qtd_parc_venc)::bigint as qtd_parc_venc,
           count(distinct ba.aluno_id) filter (where ba.acordo_situacao='QUEBRADO') as alunos_ac_quebrado,
           round(sum(ba.saldo_mens_venc + ba.saldo_ac_venc)::numeric,2) as saldo_vencido_ano,
           round(sum(ba.saldo_mens_fut + ba.saldo_ac_fut)::numeric,2) as saldo_futuro_ano,
           max(ba.data_ultimo_acionamento) as ult_acion,
           round(avg(case when ba.data_ultimo_acionamento is not null then (v_hoje - ba.data_ultimo_acionamento::date) end)::numeric,1) as dias_medios
    from tmp_pen_ba ba group by ba.ano
  ),
  act as (
    select ba.ano,
           count(distinct ba.aluno_id) filter (where ac.canal_m and not ac.canal_x) as so_manual,
           count(distinct ba.aluno_id) filter (where ac.canal_x and not ac.canal_m) as so_massivo,
           count(distinct ba.aluno_id) filter (where ac.canal_m and ac.canal_x)     as ambos,
           count(distinct ba.aluno_id) filter (where ac.canal_m or ac.canal_x)      as algum
    from tmp_pen_ba ba
    left join lateral (
      select bool_or(canal='M') as canal_m, bool_or(canal='X') as canal_x
      from tmp_pen_acted t where t.aluno_id = ba.aluno_id and t.ano is not distinct from ba.ano
    ) ac on true
    group by ba.ano
  ),
  nunca as (
    select ba.ano,
           count(distinct ba.aluno_id) filter (where not ba.bloqueado_conf and na.aluno_id is null) as nunca_acionado,
           round(sum((ba.saldo_mens_venc+ba.saldo_ac_venc)) filter (where not ba.bloqueado_conf and na.aluno_id is null)::numeric,2) as saldo_nunca
    from tmp_pen_ba ba
    left join (select distinct aluno_id, ano from tmp_pen_acted) na
      on na.aluno_id = ba.aluno_id and na.ano is not distinct from ba.ano
    group by ba.ano
  ),
  acoes as (
    select ba.ano, coalesce(sum(mm.n),0)::bigint as acoes_manuais, coalesce(sum(xx.n),0)::bigint as acoes_massivas
    from tmp_pen_ba ba
    left join tmp_pen_manual  mm on mm.aid = ba.aluno_id::text
    left join tmp_pen_massivo xx on xx.aid = ba.aluno_id::text
    group by ba.ano
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ano', base.ano, 'ano_label', coalesce(base.ano::text,'SEM ANO'),
           'base_ativa', base.base_ativa, 'base_acionavel', base.base_acionavel,
           'saldo_vencido', base.saldo_vencido_ano, 'saldo_futuro', base.saldo_futuro_ano,
           'alunos_mens_vencida', base.alunos_mens_venc, 'saldo_mens_vencida', base.saldo_mens_venc,
           'alunos_acordo_em_dia', base.alunos_ac_em_dia, 'saldo_acordo_em_dia_futuro', base.saldo_ac_em_dia_fut,
           'alunos_acordo_parc_vencida', base.alunos_ac_venc, 'saldo_acordo_vencido', base.saldo_ac_venc,
           'qtd_parcelas_acordo_vencidas', base.qtd_parc_venc,
           'alunos_acordo_quebrado', base.alunos_ac_quebrado,
           'so_manual', coalesce(act.so_manual,0), 'so_massivo', coalesce(act.so_massivo,0),
           'ambos', coalesce(act.ambos,0), 'algum', coalesce(act.algum,0),
           'nunca_acionado', coalesce(nunca.nunca_acionado,0), 'saldo_nunca', coalesce(nunca.saldo_nunca,0),
           'bloqueados_conf', base.bloqueados_conf,
           'acoes_manuais', coalesce(acoes.acoes_manuais,0), 'acoes_massivas', coalesce(acoes.acoes_massivas,0),
           'ult_acionamento', base.ult_acion, 'dias_medios_sem_acionamento', base.dias_medios,
           'pen_manual',  case when base.base_ativa>0 then round((coalesce(act.so_manual,0)+coalesce(act.ambos,0))::numeric/base.base_ativa,4) else 0 end,
           'pen_massivo', case when base.base_ativa>0 then round((coalesce(act.so_massivo,0)+coalesce(act.ambos,0))::numeric/base.base_ativa,4) else 0 end,
           'pen_total',   case when base.base_ativa>0 then round(coalesce(act.algum,0)::numeric/base.base_ativa,4) else 0 end,
           'sem_penetracao', case when base.base_ativa>0 then round(coalesce(nunca.nunca_acionado,0)::numeric/base.base_ativa,4) else 0 end
         ) order by base.ano nulls last), '[]'::jsonb) into v_matriz
  from base
  left join act on act.ano is not distinct from base.ano
  left join nunca on nunca.ano is not distinct from base.ano
  left join acoes on acoes.ano is not distinct from base.ano;

  -- Cards gerais (aluno-level, sem duplicar por ano).
  with tot as (
    select count(*) as base_ativa,
           count(*) filter (where blq) as bloqueados,
           count(*) filter (where em_ret and not blq) as bloq_temp,
           count(*) filter (where not blq and not em_ret) as acionavel,
           count(*) filter (where saldo_venc = 0) as sem_vencido,
           round(sum(saldo_venc)::numeric,2) as saldo_vencido,
           round(sum(saldo_fut)::numeric,2)  as saldo_futuro
    from (
      select b.aluno_id, bool_or(b.bloqueado_conf) as blq, bool_or(b.em_retorno) as em_ret,
             sum(b.saldo_mens_venc+b.saldo_ac_venc) as saldo_venc,
             sum(b.saldo_mens_fut+b.saldo_ac_fut) as saldo_fut
      from tmp_pen_ba b group by b.aluno_id
    ) z
  ),
  ac as (select count(distinct aluno_id) as manual from tmp_pen_acted where canal='M'),
  ax as (select count(distinct aluno_id) as massivo from tmp_pen_acted where canal='X'),
  al as (select count(distinct aluno_id) as algum from tmp_pen_acted),
  nv as (
    select count(*) as nunca, round(sum(saldo_venc)::numeric,2) as saldo_nunca
    from (
      select b.aluno_id, sum(b.saldo_mens_venc+b.saldo_ac_venc) as saldo_venc,
             bool_or(b.bloqueado_conf) as blq, bool_or(t.aluno_id is not null) as acted
      from tmp_pen_ba b
      left join (select distinct aluno_id from tmp_pen_acted) t on t.aluno_id=b.aluno_id
      group by b.aluno_id
    ) z where not blq and not acted
  )
  select jsonb_build_object(
           'base_ativa', tot.base_ativa, 'base_acionavel', tot.acionavel,
           'bloqueados_confirmacao', tot.bloqueados, 'bloqueados_temporario', tot.bloq_temp,
           'nao_elegivel_cobranca', tot.sem_vencido,
           'saldo_vencido', tot.saldo_vencido, 'saldo_futuro', tot.saldo_futuro,
           'acionados_manual', ac.manual, 'acionados_massivo', ax.massivo, 'acionados_algum', al.algum,
           'nunca_acionados', nv.nunca, 'saldo_nunca_acionado', nv.saldo_nunca,
           'pen_manual',  case when tot.base_ativa>0 then round(ac.manual::numeric/tot.base_ativa,4) else 0 end,
           'pen_massivo', case when tot.base_ativa>0 then round(ax.massivo::numeric/tot.base_ativa,4) else 0 end,
           'pen_total',   case when tot.base_ativa>0 then round(al.algum::numeric/tot.base_ativa,4) else 0 end
         ) into v_cards
  from tot, ac, ax, al, nv;

  -- Atribuição de ano dos acionamentos (explícito / inferido / sem ano).
  with ev as (
    select mev.ano_exp,
           exists (select 1 from tmp_pen_ba ar where ar.aluno_id::text=mev.aid and ar.ano is not null) as tem_ano,
           exists (select 1 from tmp_pen_ba ar where ar.aluno_id::text=mev.aid and ar.ano is not distinct from mev.ano_exp) as casa_ano
    from tmp_pen_massivo_ev mev
    union all
    select null::int,
           exists (select 1 from tmp_pen_ba ar where ar.aluno_id::text=mm.aid and ar.ano is not null),
           false
    from tmp_pen_manual mm
  )
  select jsonb_build_object(
           'ano_explicito', count(*) filter (where ano_exp is not null and casa_ano),
           'ano_inferido',  count(*) filter (where tem_ano and not (ano_exp is not null and casa_ano)),
           'sem_ano',       count(*) filter (where not tem_ano)
         ) into v_atrib from ev;

  return jsonb_build_object(
    'gerado_em', now(), 'periodo', coalesce(nullif(p_filtros->>'periodo',''),'tudo'),
    'periodo_ini', v_ini, 'periodo_fim', v_fim,
    'cards', v_cards, 'matriz', v_matriz, 'atribuicao', v_atrib
  );
end;
$$;
revoke all on function public.acoes_massivas_penetracao_por_ano(jsonb) from public, anon;
grant execute on function public.acoes_massivas_penetracao_por_ano(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- RPC DETALHE — lista mascarada de um ano + categoria.
-- categoria: nunca | manual | massivo | ambos | bloqueados
-- ----------------------------------------------------------------------------
create or replace function public.acoes_massivas_penetracao_ano_detalhe(
  p_ano integer default null, p_categoria text default 'nunca',
  p_filtros jsonb default '{}'::jsonb, p_limite integer default 100, p_offset integer default 0
) returns jsonb language plpgsql volatile security definer
set search_path to 'public' set statement_timeout to '90s' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_hoje date := (timezone('America/Sao_Paulo', now()))::date;
  v_ini timestamptz; v_fim timestamptz;
  v_cat text := lower(coalesce(nullif(p_categoria,''),'nunca'));
  v_lim int := least(greatest(coalesce(p_limite,100),1),500);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_total int; v_rows jsonb;
begin
  if v_email = '' then raise exception 'Acesso negado: nao autenticado.' using errcode = '42501'; end if;
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: perfil nao autorizado.' using errcode = '42501'; end if;
  if v_cat not in ('nunca','manual','massivo','ambos','bloqueados') then
    raise exception 'Categoria inválida.' using errcode = '22023'; end if;

  select ini, fim into v_ini, v_fim from public._penetracao_ano_periodo(p_filtros, v_hoje);
  perform public._penetracao_ano_montar(v_ini, v_fim, p_filtros, v_hoje);

  drop table if exists tmp_pen_det;
  create temporary table tmp_pen_det on commit drop as
  select ba.aluno_id, ba.ano,
         round((ba.saldo_mens_venc+ba.saldo_ac_venc)::numeric,2) as saldo_vencido,
         round((ba.saldo_mens_fut+ba.saldo_ac_fut)::numeric,2) as saldo_futuro,
         ba.acordo_situacao, ba.bloqueado_conf,
         coalesce(mm.aid is not null,false) as tem_manual,
         coalesce(xx.aid is not null,false) as tem_massivo,
         case when mm.ult is not null and (xx.ult is null or mm.ult>=xx.ult) then 'MANUAL'
              when xx.ult is not null then 'MASSIVO' else null end as origem_ult
  from tmp_pen_ba ba
  left join tmp_pen_manual mm on mm.aid = ba.aluno_id::text
  left join tmp_pen_massivo xx on xx.aid = ba.aluno_id::text
  where ba.ano is not distinct from p_ano;

  select count(*) into v_total from tmp_pen_det d
  where case v_cat
          when 'nunca' then not d.bloqueado_conf and not d.tem_manual and not d.tem_massivo
          when 'manual' then d.tem_manual and not d.tem_massivo
          when 'massivo' then d.tem_massivo and not d.tem_manual
          when 'ambos' then d.tem_manual and d.tem_massivo
          when 'bloqueados' then d.bloqueado_conf end;

  select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) into v_rows from (
    select split_part(coalesce(a.nome,'-'),' ',1)||' ***' as nome_mascarado,
      case when a.matricula is null or a.matricula='' then null
           else '***'||right(regexp_replace(a.matricula,'\D','','g'),3) end as matricula_mascarada,
      a.curso, a.situacao_academica, a.unidade as estabelecimento,
      d.ano, d.saldo_vencido as saldo, d.saldo_futuro,
      d.acordo_situacao,
      (v_hoje - (select min(t.vencimento) from public.acordos_titulos t
                 where t.aluno_id=a.id and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                   and coalesce(lower(t.status),'') not in ('quitada') and t.vencimento < v_hoje)) as dias_atraso,
      coalesce(a.responsavel_atual_email,'— livre —') as responsavel,
      a.data_ultimo_acionamento, d.origem_ult as origem_ultimo_acionamento,
      case when a.data_ultimo_acionamento is null then null else (v_hoje - a.data_ultimo_acionamento::date) end as dias_sem_acionamento
    from tmp_pen_det d
    join public.alunos a on a.id = d.aluno_id
    where case v_cat
            when 'nunca' then not d.bloqueado_conf and not d.tem_manual and not d.tem_massivo
            when 'manual' then d.tem_manual and not d.tem_massivo
            when 'massivo' then d.tem_massivo and not d.tem_manual
            when 'ambos' then d.tem_manual and d.tem_massivo
            when 'bloqueados' then d.bloqueado_conf end
    order by d.saldo_vencido desc nulls last, a.id
    limit v_lim offset v_off
  ) x;

  return jsonb_build_object('total', v_total, 'limite', v_lim, 'offset', v_off,
                            'ano', p_ano, 'categoria', v_cat, 'itens', v_rows);
end;
$$;
revoke all on function public.acoes_massivas_penetracao_ano_detalhe(integer,text,jsonb,integer,integer) from public, anon;
grant execute on function public.acoes_massivas_penetracao_ano_detalhe(integer,text,jsonb,integer,integer) to authenticated;
