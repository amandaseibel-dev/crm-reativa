-- ============================================================================
-- Ações Massivas — PENETRAÇÃO DOS ACIONAMENTOS POR ANO DA DÍVIDA (gerencial)
-- ----------------------------------------------------------------------------
-- Objetivo: mostrar quanto da carteira ATIVA ACIONÁVEL já recebeu acionamento
-- manual e/ou massivo em cada ANO DA DÍVIDA, para a gestão decidir onde
-- concentrar as próximas ações. Somente LEITURA e AGREGAÇÃO — não altera
-- pagamentos, saldos, acordos, responsáveis, criticidade ou dados operacionais.
--
-- UNIDADE DE MEDIÇÃO: aluno_id + ano_da_divida.
--   * ano_da_divida = ano do VENCIMENTO de título ativo em aberto
--     (public.acordos_titulos, situacao ABERTO/NEGOCIADO, status <> quitada).
--     NUNCA usa ano de pagamento / acordo / acionamento / importação.
--   * aluno com vários títulos no mesmo ano  -> conta 1x no ano, soma o saldo.
--   * aluno com dívidas em anos diferentes    -> aparece 1x em cada ano.
--   * sem vencimento confiável                 -> bucket "SEM ANO IDENTIFICADO".
--
-- BASE ATIVA (carteira acionável atual): caso "pool" (operador_email IS NULL),
--   saldo canônico casos.total_em_aberto > 0, exclui encerrados/quitados/
--   cancelados/jurídico (caso_encerrado_operacional), acordo ATIVO e opt-out
--   (casos.nao_acionar). Confirmação de pagamento aparece SEPARADA (bloqueados),
--   fora do público acionável — mesma definição canônica usada na prévia.
--
-- ACIONAMENTO MANUAL (ação humana válida): public.aluno_movimentacoes cujo tipo
--   passa em public.eh_tipo_acionamento(), EXCLUINDO os tipos massivos e o autor
--   técnico 'SISTEMA'. (cron/importação/mudança de status não são tipos de
--   acionamento, logo já ficam fora.)
-- ACIONAMENTO MASSIVO (PROCESSADO): destinatários realmente processados
--   (acoes_massivas_destinatarios.status IN ENVIADO/PREPARADO) de campanhas não
--   RASCUNHO/AGENDADO/CANCELADO/FALHOU, mais movimentações de tipo massivo.
--   Rascunho, prévia, agendada, cancelada, excluído e erro NÃO contam.
--
-- Segurança: SECURITY DEFINER, search_path fixo, gate public.usuario_e_gestao()
--   por JWT, EXECUTE revogado de public/anon. Saída agregada e mascarada.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Índices de apoio (idempotentes) — a consulta varre acordos_titulos por
-- aluno/vencimento e movimentações/destinatários por data.
-- ----------------------------------------------------------------------------
create index if not exists ix_acordos_titulos_aluno_venc
  on public.acordos_titulos (aluno_id, vencimento);
create index if not exists ix_aluno_mov_tipo_data
  on public.aluno_movimentacoes (tipo, registrado_em);
create index if not exists ix_amd_status_campanha
  on public.acoes_massivas_destinatarios (status, campanha_id);

-- ----------------------------------------------------------------------------
-- Núcleo interno reutilizado pela visão agregada e pelo detalhamento.
-- Popula tabelas TEMPORÁRIAS (on commit drop):
--   tmp_pen_base : 1 linha por aluno da base ativa
--   tmp_pen_ba   : 1 linha por (aluno, ano) — ano NULL = SEM ANO
--   tmp_pen_acted: distinct (aluno, ano, canal 'M'/'X') dentro do período
--   tmp_pen_ev   : eventos (para contagem explícito/inferido/sem-ano)
-- Recebe filtros já normalizados + limites de período (timestamptz, ou NULL).
-- ----------------------------------------------------------------------------
create or replace function public._penetracao_ano_montar(
  p_ini        timestamptz,
  p_fim        timestamptz,
  p_unidade    text,
  p_curso      text,
  p_sit        text,
  p_operador   text,
  p_criticidade text,
  p_saldo_min  numeric,
  p_saldo_max  numeric,
  p_atraso_min integer,
  p_atraso_max integer,
  p_hoje       date
) returns void language plpgsql volatile security definer
set search_path to 'public' set statement_timeout to '60s' as $$
begin
  -- Base ativa (pool acionável) + flag de bloqueio por confirmação + atraso.
  drop table if exists tmp_pen_base;
  create temporary table tmp_pen_base on commit drop as
  select a.id as aluno_id,
         coalesce(c.total_em_aberto, 0) as saldo_total,
         c.criticidade,
         a.unidade,
         a.curso,
         a.situacao_academica,
         a.data_ultimo_acionamento,
         (p_hoje - (
            select min(t.vencimento) from public.acordos_titulos t
            where t.aluno_id = a.id
              and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
              and coalesce(lower(t.status),'') not in ('quitada')
              and t.vencimento < p_hoje
         )) as dias_atraso,
         (case
            when public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO' then true
            when exists (
              select 1 from public.solicitacoes_confirmacao_pagamento s
              where s.aluno_id = a.id::text
                and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
            ) then true
            else false
          end) as bloqueado_conf
  from public.alunos a
  join public.casos c on c.aluno_id = a.id and c.operador_email is null
  where a.responsavel_atual_email is null
    and coalesce(a.status_jornada,'') not in ('QUITADO','QUITADO_MANUAL')
    and coalesce(a.status_atual,'')   not in ('QUITADO','QUITADO_MANUAL')
    and not public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
    and not exists (select 1 from public.acordos ac where ac.aluno_id = a.id and ac.status = 'ATIVO')
    and coalesce(c.total_em_aberto, 0) > 0
    and not coalesce(c.nao_acionar, false)
    and (p_unidade    is null or a.unidade = p_unidade)
    and (p_curso      is null or a.curso = p_curso)
    and (p_sit        is null or a.situacao_academica = p_sit)
    and (p_criticidade is null or c.criticidade = p_criticidade)
    and (p_saldo_min  is null or coalesce(c.total_em_aberto,0) >= p_saldo_min)
    and (p_saldo_max  is null or coalesce(c.total_em_aberto,0) <= p_saldo_max);

  -- Filtro de faixa de atraso (aplicado após o cálculo do min-vencimento).
  if p_atraso_min is not null then
    delete from tmp_pen_base where coalesce(dias_atraso, -1) < p_atraso_min;
  end if;
  if p_atraso_max is not null then
    delete from tmp_pen_base where coalesce(dias_atraso, 2147483647) > p_atraso_max;
  end if;
  -- p_operador: a base acionável é sempre pool (sem responsável vinculado).
  -- Mantido por compatibilidade de assinatura; não restringe a base.

  -- (aluno, ano) — ano NULL = SEM ANO IDENTIFICADO. Saldo do ano = soma dos
  -- títulos ativos daquele ano; SEM ANO herda o saldo canônico do aluno.
  drop table if exists tmp_pen_anoreal;
  create temporary table tmp_pen_anoreal on commit drop as
  select b.aluno_id,
         extract(year from t.vencimento)::int as ano,
         round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))::numeric, 2) as saldo_ano
  from tmp_pen_base b
  join public.acordos_titulos t on t.aluno_id = b.aluno_id
  where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
    and coalesce(lower(t.status),'') not in ('quitada')
    and t.vencimento is not null
  group by b.aluno_id, extract(year from t.vencimento)::int;

  drop table if exists tmp_pen_ba;
  create temporary table tmp_pen_ba on commit drop as
  select b.aluno_id,
         ta.ano,
         coalesce(ta.saldo_ano, b.saldo_total) as saldo_ano,
         b.bloqueado_conf,
         b.data_ultimo_acionamento
  from tmp_pen_base b
  left join tmp_pen_anoreal ta on ta.aluno_id = b.aluno_id;

  -- Eventos MANUAIS no período (ação humana válida).
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

  -- Eventos MASSIVOS no período — destinatários processados (+ ano explícito da
  -- campanha, se houver) e movimentações de tipo massivo (ano sempre inferido).
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

  -- Aluno massivo agregado (para distinct/contagem).
  drop table if exists tmp_pen_massivo;
  create temporary table tmp_pen_massivo on commit drop as
  select aid, count(*)::int as n, max(ts) as ult
  from tmp_pen_massivo_ev group by aid;

  -- Matriz distinct (aluno, ano, canal). Manual e massivo sem ano explícito são
  -- INFERIDOS para todos os anos ativos do aluno; massivo com ano explícito que
  -- casa um ano ativo do aluno é atribuído só àquele ano.
  drop table if exists tmp_pen_acted;
  create temporary table tmp_pen_acted on commit drop as
    select ba.aluno_id, ba.ano, 'M'::text as canal
    from tmp_pen_ba ba
    join tmp_pen_manual mm on mm.aid = ba.aluno_id::text
  union
    select ba.aluno_id, ba.ano, 'X'::text as canal
    from tmp_pen_ba ba
    join tmp_pen_massivo_ev me on me.aid = ba.aluno_id::text
    where me.ano_exp is null
       or me.ano_exp is not distinct from ba.ano
       or not exists (  -- ano explícito que não casa nenhum ano ativo -> infere
            select 1 from tmp_pen_ba bx
            where bx.aluno_id = ba.aluno_id and bx.ano is not distinct from me.ano_exp);
end;
$$;
revoke all on function public._penetracao_ano_montar(timestamptz,timestamptz,text,text,text,text,text,numeric,numeric,integer,integer,date) from public, anon;

-- ----------------------------------------------------------------------------
-- Helper: normaliza p_filtros -> limites de período (America/Sao_Paulo).
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
    ini := timezone(v_tz, p_hoje::timestamp);
    fim := timezone(v_tz, (p_hoje + 1)::timestamp);
  elsif v_periodo = '7d' then
    ini := timezone(v_tz, (p_hoje - 6)::timestamp);  fim := timezone(v_tz, (p_hoje + 1)::timestamp);
  elsif v_periodo = '30d' then
    ini := timezone(v_tz, (p_hoje - 29)::timestamp); fim := timezone(v_tz, (p_hoje + 1)::timestamp);
  elsif v_periodo = 'mes_atual' then
    ini := timezone(v_tz, date_trunc('month', p_hoje)::timestamp);
    fim := timezone(v_tz, (date_trunc('month', p_hoje) + interval '1 month')::timestamp);
  elsif v_periodo = 'mes_anterior' then
    ini := timezone(v_tz, (date_trunc('month', p_hoje) - interval '1 month')::timestamp);
    fim := timezone(v_tz, date_trunc('month', p_hoje)::timestamp);
  elsif v_periodo = 'custom' then
    ini := case when v_di is null then null else timezone(v_tz, v_di::timestamp) end;
    fim := case when v_df is null then null else timezone(v_tz, (v_df + 1)::timestamp) end;
  else -- 'tudo' / histórico completo
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
set search_path to 'public' set statement_timeout to '60s' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_hoje  date  := (timezone('America/Sao_Paulo', now()))::date;
  v_ini timestamptz; v_fim timestamptz;
  v_matriz jsonb; v_cards jsonb; v_atrib jsonb;
begin
  if v_email = '' then raise exception 'Acesso negado: nao autenticado.' using errcode = '42501'; end if;
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: perfil nao autorizado.' using errcode = '42501'; end if;

  select ini, fim into v_ini, v_fim from public._penetracao_ano_periodo(p_filtros, v_hoje);

  perform public._penetracao_ano_montar(
    v_ini, v_fim,
    nullif(p_filtros->>'unidade',''), nullif(p_filtros->>'curso',''),
    nullif(p_filtros->>'situacao_academica',''), nullif(p_filtros->>'operador_email',''),
    nullif(p_filtros->>'criticidade',''),
    nullif(p_filtros->>'saldo_min','')::numeric, nullif(p_filtros->>'saldo_max','')::numeric,
    nullif(p_filtros->>'atraso_min','')::int, nullif(p_filtros->>'atraso_max','')::int,
    v_hoje
  );

  -- Matriz por ano (uma linha por ano; ano NULL -> "SEM ANO").
  with anos as (
    select ba.ano,
           count(distinct ba.aluno_id) as base_ativa,
           count(distinct ba.aluno_id) filter (where ba.bloqueado_conf) as bloqueados_conf,
           round(sum(ba.saldo_ano)::numeric, 2) as saldo_ativo,
           count(distinct ba.aluno_id) filter (where ba.data_ultimo_acionamento is not null) as com_ult,
           round(avg(case when ba.data_ultimo_acionamento is not null
                          then (v_hoje - ba.data_ultimo_acionamento::date) end)::numeric, 1) as dias_medios,
           max(ba.data_ultimo_acionamento) as ult_acion
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
           round(sum(ba.saldo_ano) filter (where not ba.bloqueado_conf and na.aluno_id is null)::numeric, 2) as saldo_nunca
    from tmp_pen_ba ba
    left join (select distinct aluno_id, ano from tmp_pen_acted) na
      on na.aluno_id = ba.aluno_id and na.ano is not distinct from ba.ano
    group by ba.ano
  ),
  acoes as (
    select ba.ano,
           coalesce(sum(mm.n),0)::bigint as acoes_manuais,
           coalesce(sum(xx.n),0)::bigint as acoes_massivas
    from tmp_pen_ba ba
    left join tmp_pen_manual  mm on mm.aid = ba.aluno_id::text
    left join tmp_pen_massivo xx on xx.aid = ba.aluno_id::text
    group by ba.ano
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ano', case when anos.ano is null then null else anos.ano end,
           'ano_label', coalesce(anos.ano::text, 'SEM ANO'),
           'base_ativa', anos.base_ativa,
           'saldo_ativo', anos.saldo_ativo,
           'so_manual', coalesce(act.so_manual,0),
           'so_massivo', coalesce(act.so_massivo,0),
           'ambos', coalesce(act.ambos,0),
           'algum', coalesce(act.algum,0),
           'nunca_acionado', coalesce(nunca.nunca_acionado,0),
           'saldo_nunca', coalesce(nunca.saldo_nunca,0),
           'bloqueados_conf', anos.bloqueados_conf,
           'acoes_manuais', coalesce(acoes.acoes_manuais,0),
           'acoes_massivas', coalesce(acoes.acoes_massivas,0),
           'ult_acionamento', anos.ult_acion,
           'dias_medios_sem_acionamento', anos.dias_medios,
           'pen_manual',  case when anos.base_ativa>0 then round((coalesce(act.so_manual,0)+coalesce(act.ambos,0))::numeric/anos.base_ativa, 4) else 0 end,
           'pen_massivo', case when anos.base_ativa>0 then round((coalesce(act.so_massivo,0)+coalesce(act.ambos,0))::numeric/anos.base_ativa, 4) else 0 end,
           'pen_total',   case when anos.base_ativa>0 then round(coalesce(act.algum,0)::numeric/anos.base_ativa, 4) else 0 end,
           'sem_penetracao', case when anos.base_ativa>0 then round(coalesce(nunca.nunca_acionado,0)::numeric/anos.base_ativa, 4) else 0 end
         ) order by anos.ano nulls last), '[]'::jsonb)
    into v_matriz
  from anos
  left join act   on act.ano   is not distinct from anos.ano
  left join nunca on nunca.ano is not distinct from anos.ano
  left join acoes on acoes.ano is not distinct from anos.ano;

  -- Cards gerais (base total, acionável, bloqueados, penetração global).
  with tot as (
    select count(distinct aluno_id) as base_ativa,
           count(distinct aluno_id) filter (where bloqueado_conf) as bloqueados,
           count(distinct aluno_id) filter (where not bloqueado_conf) as acionavel,
           round(sum(saldo_ano)::numeric,2) as saldo_ativo
    from tmp_pen_ba
  ),
  ac as (
    select count(distinct aluno_id) as manual from tmp_pen_acted where canal='M'
  ),
  ax as (
    select count(distinct aluno_id) as massivo from tmp_pen_acted where canal='X'
  ),
  al as (
    select count(distinct aluno_id) as algum from tmp_pen_acted
  ),
  nv as (
    select count(*) as nunca,
           round(sum(aluno_saldo)::numeric,2) as saldo_nunca
    from (
      select ba.aluno_id, sum(ba.saldo_ano) as aluno_saldo, bool_or(ba.bloqueado_conf) as blq,
             bool_or(t.aluno_id is not null) as acted
      from tmp_pen_ba ba
      left join (select distinct aluno_id from tmp_pen_acted) t on t.aluno_id = ba.aluno_id
      group by ba.aluno_id
    ) ba
    where not ba.blq and not ba.acted
  )
  select jsonb_build_object(
           'base_ativa', tot.base_ativa,
           'base_acionavel', tot.acionavel,
           'bloqueados_confirmacao', tot.bloqueados,
           'saldo_ativo', tot.saldo_ativo,
           'acionados_manual', ac.manual,
           'acionados_massivo', ax.massivo,
           'acionados_algum', al.algum,
           'nunca_acionados', nv.nunca,
           'saldo_nunca_acionado', nv.saldo_nunca,
           'pen_manual',  case when tot.base_ativa>0 then round(ac.manual::numeric/tot.base_ativa,4) else 0 end,
           'pen_massivo', case when tot.base_ativa>0 then round(ax.massivo::numeric/tot.base_ativa,4) else 0 end,
           'pen_total',   case when tot.base_ativa>0 then round(al.algum::numeric/tot.base_ativa,4) else 0 end
         ) into v_cards
  from tot, ac, ax, al, nv;

  -- Atribuição de ano (explícito / inferido / sem ano possível) — nível evento.
  with ev as (
    select mev.aid, mev.ano_exp,
           exists (select 1 from tmp_pen_anoreal ar where ar.aluno_id::text = mev.aid) as tem_ano,
           exists (select 1 from tmp_pen_anoreal ar where ar.aluno_id::text = mev.aid and ar.ano is not distinct from mev.ano_exp) as casa_ano
    from tmp_pen_massivo_ev mev
    union all
    select mm.aid, null::int as ano_exp,
           exists (select 1 from tmp_pen_anoreal ar where ar.aluno_id::text = mm.aid) as tem_ano,
           false as casa_ano
    from (
      select m.aluno_id::text as aid
      from public.aluno_movimentacoes m
      where public.eh_tipo_acionamento(m.tipo)
        and m.tipo not in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')
        and coalesce(upper(m.registrado_por_email),'') <> 'SISTEMA'
        and (v_ini is null or m.registrado_em >= v_ini)
        and (v_fim is null or m.registrado_em <  v_fim)
        and exists (select 1 from tmp_pen_base b where b.aluno_id::text = m.aluno_id::text)
    ) mm
  )
  select jsonb_build_object(
           'ano_explicito', count(*) filter (where ano_exp is not null and casa_ano),
           'ano_inferido',  count(*) filter (where tem_ano and not (ano_exp is not null and casa_ano)),
           'sem_ano',       count(*) filter (where not tem_ano)
         ) into v_atrib
  from ev;

  return jsonb_build_object(
    'gerado_em', now(),
    'periodo', coalesce(nullif(p_filtros->>'periodo',''),'tudo'),
    'periodo_ini', v_ini, 'periodo_fim', v_fim,
    'cards', v_cards,
    'matriz', v_matriz,
    'atribuicao', v_atrib
  );
end;
$$;
revoke all on function public.acoes_massivas_penetracao_por_ano(jsonb) from public, anon;
grant execute on function public.acoes_massivas_penetracao_por_ano(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- RPC DETALHE — lista mascarada de um ano + categoria.
-- categoria: 'nunca' | 'manual' | 'massivo' | 'ambos' | 'bloqueados'
-- ----------------------------------------------------------------------------
create or replace function public.acoes_massivas_penetracao_ano_detalhe(
  p_ano       integer default null,   -- NULL = bucket SEM ANO
  p_categoria text    default 'nunca',
  p_filtros   jsonb   default '{}'::jsonb,
  p_limite    integer default 100,
  p_offset    integer default 0
) returns jsonb language plpgsql volatile security definer
set search_path to 'public' set statement_timeout to '60s' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_hoje  date  := (timezone('America/Sao_Paulo', now()))::date;
  v_ini timestamptz; v_fim timestamptz;
  v_cat text := lower(coalesce(nullif(p_categoria,''),'nunca'));
  v_lim int := least(greatest(coalesce(p_limite,100),1),500);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_total int; v_rows jsonb;
begin
  if v_email = '' then raise exception 'Acesso negado: nao autenticado.' using errcode = '42501'; end if;
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: perfil nao autorizado.' using errcode = '42501'; end if;
  if v_cat not in ('nunca','manual','massivo','ambos','bloqueados') then
    raise exception 'Categoria inválida.' using errcode = '22023';
  end if;

  select ini, fim into v_ini, v_fim from public._penetracao_ano_periodo(p_filtros, v_hoje);
  perform public._penetracao_ano_montar(
    v_ini, v_fim,
    nullif(p_filtros->>'unidade',''), nullif(p_filtros->>'curso',''),
    nullif(p_filtros->>'situacao_academica',''), nullif(p_filtros->>'operador_email',''),
    nullif(p_filtros->>'criticidade',''),
    nullif(p_filtros->>'saldo_min','')::numeric, nullif(p_filtros->>'saldo_max','')::numeric,
    nullif(p_filtros->>'atraso_min','')::int, nullif(p_filtros->>'atraso_max','')::int,
    v_hoje
  );

  drop table if exists tmp_pen_det;
  create temporary table tmp_pen_det on commit drop as
  select ba.aluno_id, ba.ano, ba.saldo_ano, ba.bloqueado_conf,
         coalesce(mm.aid is not null, false) as tem_manual,
         coalesce(xx.aid is not null, false) as tem_massivo,
         greatest(mm.ult, xx.ult) as ult_acion,
         case when mm.ult is not null and (xx.ult is null or mm.ult >= xx.ult) then 'MANUAL'
              when xx.ult is not null then 'MASSIVO' else null end as origem_ult
  from tmp_pen_ba ba
  left join tmp_pen_manual  mm on mm.aid = ba.aluno_id::text
  left join tmp_pen_massivo xx on xx.aid = ba.aluno_id::text
  where ba.ano is not distinct from p_ano;

  select count(*) into v_total from tmp_pen_det d
  where case v_cat
          when 'nunca'      then not d.bloqueado_conf and not d.tem_manual and not d.tem_massivo
          when 'manual'     then d.tem_manual and not d.tem_massivo
          when 'massivo'    then d.tem_massivo and not d.tem_manual
          when 'ambos'      then d.tem_manual and d.tem_massivo
          when 'bloqueados' then d.bloqueado_conf
        end;

  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_rows from (
    select
      split_part(coalesce(a.nome,'-'),' ',1) || ' ***' as nome_mascarado,
      case when a.matricula is null or a.matricula='' then null
           else '***' || right(regexp_replace(a.matricula,'\D','','g'), 3) end as matricula_mascarada,
      a.curso,
      a.situacao_academica,
      a.unidade as estabelecimento,
      d.ano,
      d.saldo_ano as saldo,
      (v_hoje - (
         select min(t.vencimento) from public.acordos_titulos t
         where t.aluno_id = a.id
           and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
           and coalesce(lower(t.status),'') not in ('quitada')
           and t.vencimento < v_hoje
      )) as dias_atraso,
      coalesce(a.responsavel_atual_email, '— livre —') as responsavel,
      a.data_ultimo_acionamento,
      d.origem_ult as origem_ultimo_acionamento,
      case when a.data_ultimo_acionamento is null then null
           else (v_hoje - a.data_ultimo_acionamento::date) end as dias_sem_acionamento
    from tmp_pen_det d
    join public.alunos a on a.id = d.aluno_id
    where case v_cat
            when 'nunca'      then not d.bloqueado_conf and not d.tem_manual and not d.tem_massivo
            when 'manual'     then d.tem_manual and not d.tem_massivo
            when 'massivo'    then d.tem_massivo and not d.tem_manual
            when 'ambos'      then d.tem_manual and d.tem_massivo
            when 'bloqueados' then d.bloqueado_conf
          end
    order by d.saldo_ano desc nulls last, a.id
    limit v_lim offset v_off
  ) x;

  return jsonb_build_object('total', v_total, 'limite', v_lim, 'offset', v_off,
                            'ano', p_ano, 'categoria', v_cat, 'itens', v_rows);
end;
$$;
revoke all on function public.acoes_massivas_penetracao_ano_detalhe(integer,text,jsonb,integer,integer) from public, anon;
grant execute on function public.acoes_massivas_penetracao_ano_detalhe(integer,text,jsonb,integer,integer) to authenticated;
