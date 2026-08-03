-- ============================================================================
-- FECHAMENTO MENSAL DA REMUNERACAO DOS OPERADORES
-- Fundacao: acesso exclusivo Amanda gestora, tabelas, RLS, log e RPC de calculo
-- ----------------------------------------------------------------------------
-- Regras-chave:
--  * Acesso EXCLUSIVO de amanda.seibel@aelbra.com.br (nao reutiliza
--    usuario_e_gestao* / calibragem_e_gestao, que autorizam Fernanda/Amanda ADM).
--  * Comissao incide sobre HONORARIOS confirmados (pagamentos.valor_honorario),
--    nunca sobre valor recuperado.
--  * Reconciliacao com a mesma base da Projecao (public.pagamentos, data oficial
--    pagamentos.data_pagamento, faixas em public.metas_projecao).
--  * NAO altera pagamentos, honorarios, acordos, projecao ou qualquer dado vivo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. FUNCAO DE ACESSO EXCLUSIVO (somente Amanda gestora)
-- ----------------------------------------------------------------------------
create or replace function public.usuario_pode_acessar_fechamento_remuneracao()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  -- Chamadas de sistema (migracoes, cron, service_role) permitidas.
  if em = '' then
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;
  -- Somente Amanda gestora, e apenas se ativa no cadastro.
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (
       select 1 from public.usuarios u
       where lower(u.email) = em and u.ativo is true
     );
end;
$$;

comment on function public.usuario_pode_acessar_fechamento_remuneracao() is
  'Acesso EXCLUSIVO ao Fechamento de Remuneracao: somente amanda.seibel@aelbra.com.br (+ service_role/sistema). NAO autoriza Fernanda, Amanda ADM, operadores ou demais gestao.';

-- ----------------------------------------------------------------------------
-- 2. LOG DE ACESSO / TENTATIVAS (sem senhas ou tokens)
-- ----------------------------------------------------------------------------
create table if not exists public.fechamento_remuneracao_acesso_log (
  id          uuid primary key default gen_random_uuid(),
  email       text,
  autorizado  boolean not null,
  acao        text not null,
  detalhe     text,
  criado_em   timestamptz not null default now()
);

alter table public.fechamento_remuneracao_acesso_log enable row level security;
-- Apenas Amanda le o log; ninguem escreve pelo cliente (insert via RPC definer).
drop policy if exists fral_select_amanda on public.fechamento_remuneracao_acesso_log;
create policy fral_select_amanda on public.fechamento_remuneracao_acesso_log
  for select using (public.usuario_pode_acessar_fechamento_remuneracao());

create or replace function public.fechamento_log_acesso(
  p_autorizado boolean, p_acao text, p_detalhe text default null
) returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  insert into public.fechamento_remuneracao_acesso_log(email, autorizado, acao, detalhe)
  values (lower(coalesce((auth.jwt() ->> 'email'), current_user)), p_autorizado, p_acao, p_detalhe);
exception when others then
  null; -- log nunca deve quebrar a operacao
end;
$$;

-- Guard reutilizavel: bloqueia + registra tentativa nao autorizada.
create or replace function public.fechamento_exigir_acesso(p_acao text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.usuario_pode_acessar_fechamento_remuneracao() then
    perform public.fechamento_log_acesso(false, p_acao, 'acesso negado');
    raise exception 'Acesso negado ao Fechamento de Remuneracao (exclusivo Amanda gestora).'
      using errcode = '42501';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. CONFIGURACAO HISTORICA POR BENEFICIARIO E COMPETENCIA
-- ----------------------------------------------------------------------------
create table if not exists public.fechamento_remuneracao_config (
  id                    uuid primary key default gen_random_uuid(),
  competencia           date not null,                 -- 1o dia do mes
  beneficiario_email    text not null,
  beneficiario_nome     text,
  tipo_vinculo          text not null default 'contratual',   -- contratual|salario_base|pro_labore|outro
  nome_exibicao_fixo    text not null default 'Valor fixo contratual',
  valor_fixo            numeric not null default 0,
  elegivel_comissao     boolean not null default true,
  regra_comissao        text not null default 'faixa',        -- faixa|percentual_fixo|nenhuma
  percentual_fixo       numeric,                               -- usado quando regra=percentual_fixo
  elegivel_premiacao    boolean not null default true,
  vigencia_inicio       date,
  vigencia_fim          date,
  observacao            text,
  criado_por            text,
  criado_em             timestamptz not null default now(),
  alterado_por          text,
  alterado_em           timestamptz,
  constraint frc_competencia_dia1 check (date_trunc('month', competencia)::date = competencia),
  constraint frc_tipo_vinculo_valido check (tipo_vinculo in ('contratual','salario_base','pro_labore','outro')),
  constraint frc_regra_valida check (regra_comissao in ('faixa','percentual_fixo','nenhuma')),
  unique (competencia, beneficiario_email)
);

-- ----------------------------------------------------------------------------
-- 4. PREMIACOES DA COMPETENCIA
-- ----------------------------------------------------------------------------
create table if not exists public.fechamento_remuneracao_premiacao (
  id                  uuid primary key default gen_random_uuid(),
  competencia         date not null,
  beneficiario_email  text not null,
  beneficiario_nome   text,
  tipo                text not null default 'premiacao_campanha',
  nome_campanha       text,
  descricao           text,
  criterio            text,
  valor               numeric not null,
  origem              text,
  comprovante_ref     text,
  observacao          text,
  criado_por          text,
  criado_em           timestamptz not null default now(),
  alterado_por        text,
  alterado_em         timestamptz,
  constraint frp_competencia_dia1 check (date_trunc('month', competencia)::date = competencia),
  constraint frp_valor_positivo check (valor >= 0),
  constraint frp_tipo_valido check (tipo in (
    'premiacao_campanha','premio_ranking','premio_meta','premio_individual',
    'premio_equipe','premio_extraordinario','outro'))
);

-- ----------------------------------------------------------------------------
-- 5. AJUSTES / BONUS / CORRECOES / DESCONTOS / ESTORNOS
-- ----------------------------------------------------------------------------
create table if not exists public.fechamento_remuneracao_ajuste (
  id                  uuid primary key default gen_random_uuid(),
  competencia         date not null,
  beneficiario_email  text not null,
  beneficiario_nome   text,
  tipo                text not null,                 -- bonus|correcao_positiva|correcao_negativa|desconto|estorno|outro
  natureza            text not null,                 -- positivo|negativo
  valor               numeric not null,             -- sempre magnitude positiva
  motivo              text not null,
  documento_ref       text,
  criado_por          text,
  criado_em           timestamptz not null default now(),
  constraint fra_competencia_dia1 check (date_trunc('month', competencia)::date = competencia),
  constraint fra_valor_positivo check (valor >= 0),
  constraint fra_natureza_valida check (natureza in ('positivo','negativo')),
  constraint fra_tipo_valido check (tipo in (
    'bonus','correcao_positiva','correcao_negativa','desconto','estorno','outro')),
  constraint fra_motivo_preenchido check (length(btrim(motivo)) > 0)
);

-- ----------------------------------------------------------------------------
-- 6. CABECALHO DO FECHAMENTO (versionado por competencia)
-- ----------------------------------------------------------------------------
create table if not exists public.fechamento_remuneracao (
  id                    uuid primary key default gen_random_uuid(),
  competencia           date not null,
  versao                integer not null default 1,
  status                text not null default 'EM_APURACAO',  -- EM_APURACAO|EM_REVISAO|FECHADO|REABERTO
  periodo_inicio        date not null,
  periodo_fim           date not null,
  -- Totais congelados no fechamento
  total_fixo            numeric,
  total_recuperado      numeric,
  total_honorario       numeric,
  total_comissao        numeric,
  total_premiacao       numeric,
  total_bonus           numeric,
  total_correcoes       numeric,
  total_desconto        numeric,
  total_estorno         numeric,
  total_final           numeric,
  valor_sem_operador    numeric,
  honorario_sem_operador numeric,
  qtd_sem_operador      integer,
  hash_sintetico        text,
  hash_analitico        text,
  gerado_por            text,
  gerado_em             timestamptz not null default now(),
  fechado_por           text,
  fechado_em            timestamptz,
  reaberto_por          text,
  reaberto_em           timestamptz,
  motivo                text,
  constraint fr_status_valido check (status in ('EM_APURACAO','EM_REVISAO','FECHADO','REABERTO')),
  constraint fr_competencia_dia1 check (date_trunc('month', competencia)::date = competencia),
  unique (competencia, versao)
);

-- Snapshot por beneficiario (congelado no fechamento)
create table if not exists public.fechamento_remuneracao_linha (
  id                  uuid primary key default gen_random_uuid(),
  fechamento_id       uuid not null references public.fechamento_remuneracao(id) on delete cascade,
  competencia         date not null,
  versao              integer not null,
  posicao             integer,
  beneficiario_email  text,
  beneficiario_nome   text,
  tipo_vinculo        text,
  nome_exibicao_fixo  text,
  valor_fixo          numeric,
  qtd_pagamentos      integer,
  valor_recuperado    numeric,
  honorarios          numeric,
  faixa               text,
  percentual          numeric,
  comissao            numeric,
  premiacoes          numeric,
  bonus_correcoes     numeric,
  descontos_estornos  numeric,
  total_final         numeric,
  falta_proxima_faixa numeric,
  situacao            text,
  observacao          text,
  elegivel_comissao   boolean
);

-- Snapshot das faixas usadas (congelado)
create table if not exists public.fechamento_remuneracao_faixa (
  id             uuid primary key default gen_random_uuid(),
  fechamento_id  uuid not null references public.fechamento_remuneracao(id) on delete cascade,
  competencia    date not null,
  m1_valor numeric, m1_percentual numeric,
  m2_valor numeric, m2_percentual numeric,
  m3_valor numeric, m3_percentual numeric,
  m4_valor numeric, m4_percentual numeric,
  origem         text,
  congelado_em   timestamptz not null default now()
);

-- Snapshot analitico dos pagamentos considerados (congelado)
create table if not exists public.fechamento_remuneracao_pagamento (
  id                    uuid primary key default gen_random_uuid(),
  fechamento_id         uuid not null references public.fechamento_remuneracao(id) on delete cascade,
  competencia           date not null,
  pagamento_id          uuid,
  data_pagamento        date,
  operador_email        text,
  operador_nome         text,
  aluno_mascarado       text,
  tipo_pagamento        text,
  numero_parcela        text,
  importacao_id         uuid,
  valor_recuperado      numeric,
  honorarios            numeric,
  elegivel_comissao     boolean,
  motivo_exclusao       text
);

-- ----------------------------------------------------------------------------
-- 7. RLS EXCLUSIVA em todas as tabelas (somente Amanda)
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'fechamento_remuneracao_config',
    'fechamento_remuneracao_premiacao',
    'fechamento_remuneracao_ajuste',
    'fechamento_remuneracao',
    'fechamento_remuneracao_linha',
    'fechamento_remuneracao_faixa',
    'fechamento_remuneracao_pagamento'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I on public.%I;', t||'_amanda_all', t);
    execute format($f$create policy %I on public.%I
      for all
      using (public.usuario_pode_acessar_fechamento_remuneracao())
      with check (public.usuario_pode_acessar_fechamento_remuneracao());$f$, t||'_amanda_all', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 8. RPC CENTRAL DE CALCULO (previa, nao persiste) - reconcilia com a Projecao
-- ----------------------------------------------------------------------------
create or replace function public.calcular_fechamento_remuneracao(p_competencia date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_mes    text := to_char(p_competencia, 'YYYY-MM');
  v_ini    date := date_trunc('month', p_competencia)::date;
  v_prox   date := (date_trunc('month', p_competencia) + interval '1 month')::date;
  v_fim    date := (v_prox - interval '1 day')::date;
  v_equipe8 text[] := array[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br'];
  v_adm    text := 'cobranca07@aelbra.com.br';
  v_gestao text[] := array['amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br'];
  v_m1 numeric; v_m1p numeric; v_m2 numeric; v_m2p numeric;
  v_m3 numeric; v_m3p numeric; v_m4 numeric; v_m4p numeric;
  v_tem_faixa boolean;
  v_benef jsonb := '[]'::jsonb;
  v_nao_eleg jsonb := '[]'::jsonb;
  v_sem jsonb;
  r record;
  v_cfg record;
  v_valor_fixo numeric; v_tipo_vinc text; v_nome_fixo text; v_elig boolean;
  v_regra text; v_pctfix numeric; v_elig_prem boolean;
  v_pct numeric; v_faixa text; v_comissao numeric; v_prox_faixa numeric; v_falta numeric;
  v_prem numeric; v_bonus numeric; v_correcoes numeric; v_desc numeric; v_estorno numeric;
  v_total_final numeric; v_situacao text;
  -- totais
  t_fixo numeric := 0; t_rec numeric := 0; t_hon numeric := 0; t_com numeric := 0;
  t_prem numeric := 0; t_bonus numeric := 0; t_corr numeric := 0; t_desc numeric := 0;
  t_est numeric := 0; t_final numeric := 0;
  -- reconciliacao
  v_proj jsonb; v_proj_rec numeric; v_proj_hon numeric;
  v_all_rec numeric; v_all_hon numeric; v_all_qtd int;
begin
  perform public.fechamento_exigir_acesso('calcular_previa');

  -- Faixas oficiais da competencia
  select coalesce(m1_valor,0),coalesce(m1_percentual,0),coalesce(m2_valor,0),coalesce(m2_percentual,0),
         coalesce(m3_valor,0),coalesce(m3_percentual,0),coalesce(m4_valor,0),coalesce(m4_percentual,0)
    into v_m1,v_m1p,v_m2,v_m2p,v_m3,v_m3p,v_m4,v_m4p
  from public.metas_projecao where mes_referencia = v_mes;
  v_tem_faixa := found and coalesce(v_m1p,0)+coalesce(v_m2p,0)+coalesce(v_m3p,0)+coalesce(v_m4p,0) > 0;
  v_m1:=coalesce(v_m1,0); v_m1p:=coalesce(v_m1p,0); v_m2:=coalesce(v_m2,0); v_m2p:=coalesce(v_m2p,0);
  v_m3:=coalesce(v_m3,0); v_m3p:=coalesce(v_m3p,0); v_m4:=coalesce(v_m4,0); v_m4p:=coalesce(v_m4p,0);

  -- Producao do mes por operador (mesma base/filtro da Projecao)
  for r in
    with prod as (
      select lower(operador_email) as email,
             max(operador_nome) as nome,
             count(*) as qtd,
             coalesce(sum(valor_pago),0) as recuperado,
             coalesce(sum(valor_honorario),0) as honorarios
      from public.pagamentos
      where data_pagamento >= v_ini and data_pagamento < v_prox
        and operador_email is not null
      group by lower(operador_email)
    ),
    cfg as (
      select lower(beneficiario_email) as email from public.fechamento_remuneracao_config
      where competencia = v_ini
    )
    select coalesce(prod.email, cfg.email) as email,
           prod.nome, coalesce(prod.qtd,0) as qtd,
           coalesce(prod.recuperado,0) as recuperado,
           coalesce(prod.honorarios,0) as honorarios
    from prod full outer join cfg on prod.email = cfg.email
    order by 1
  loop
    -- Config historica (se houver)
    select * into v_cfg from public.fechamento_remuneracao_config
      where competencia = v_ini and lower(beneficiario_email) = r.email;

    if found then
      v_valor_fixo := coalesce(v_cfg.valor_fixo,0);
      v_tipo_vinc  := v_cfg.tipo_vinculo;
      v_nome_fixo  := v_cfg.nome_exibicao_fixo;
      v_elig       := v_cfg.elegivel_comissao;
      v_regra      := v_cfg.regra_comissao;
      v_pctfix     := v_cfg.percentual_fixo;
      v_elig_prem  := v_cfg.elegivel_premiacao;
    else
      v_valor_fixo := 0;
      v_tipo_vinc  := 'contratual';
      v_nome_fixo  := 'Valor fixo contratual';
      v_elig_prem  := true;
      if r.email = v_adm then
        v_elig := true; v_regra := 'percentual_fixo'; v_pctfix := 8;
      elsif r.email = any(v_equipe8) then
        v_elig := true; v_regra := 'faixa'; v_pctfix := null;
      elsif r.email = any(v_gestao) then
        v_elig := false; v_regra := 'nenhuma'; v_pctfix := null;
      else
        v_elig := false; v_regra := 'nenhuma'; v_pctfix := null;
      end if;
    end if;

    -- GESTAO sem config explicita e sem elegibilidade -> nao entra na folha
    if r.email = any(v_gestao) and not (found and v_cfg.elegivel_comissao) and v_valor_fixo = 0 then
      if r.qtd > 0 then
        v_nao_eleg := v_nao_eleg || jsonb_build_object(
          'email', r.email, 'nome', r.nome, 'qtd_pagamentos', r.qtd,
          'valor_recuperado', r.recuperado, 'honorarios', r.honorarios,
          'motivo', 'Gestao fora da remuneracao operacional');
      end if;
      continue;
    end if;

    -- Comissao sobre HONORARIOS
    v_pct := 0; v_faixa := 'Sem faixa'; v_comissao := 0; v_prox_faixa := null; v_falta := null;
    if v_elig then
      if v_regra = 'percentual_fixo' then
        v_pct := coalesce(v_pctfix,0);
        v_faixa := 'Percentual fixo ('||v_pct||'%)';
        v_comissao := round(r.honorarios * v_pct/100.0, 2);
      elsif v_regra = 'faixa' then
        if not v_tem_faixa then
          v_faixa := 'FAIXAS NAO CONFIGURADAS';
          v_comissao := null;   -- bloqueia calculo
        else
          v_pct := case
            when v_m4>0 and r.honorarios>=v_m4 then v_m4p
            when v_m3>0 and r.honorarios>=v_m3 then v_m3p
            when v_m2>0 and r.honorarios>=v_m2 then v_m2p
            when v_m1>0 and r.honorarios>=v_m1 then v_m1p else 0 end;
          v_faixa := case
            when v_m4>0 and r.honorarios>=v_m4 then 'Faixa 4 ('||v_m4p||'%)'
            when v_m3>0 and r.honorarios>=v_m3 then 'Faixa 3 ('||v_m3p||'%)'
            when v_m2>0 and r.honorarios>=v_m2 then 'Faixa 2 ('||v_m2p||'%)'
            when v_m1>0 and r.honorarios>=v_m1 then 'Faixa 1 ('||v_m1p||'%)'
            else 'Abaixo da faixa minima (0%)' end;
          v_comissao := round(r.honorarios * v_pct/100.0, 2);
          v_prox_faixa := case
            when v_m2>0 and r.honorarios<v_m2 then v_m2
            when v_m3>0 and r.honorarios<v_m3 then v_m3
            when v_m4>0 and r.honorarios<v_m4 then v_m4 else null end;
          v_falta := case when v_prox_faixa is null then 0 else round(v_prox_faixa - r.honorarios,2) end;
        end if;
      end if;
    end if;

    -- Premiacoes (somente se elegivel a premiacao)
    select coalesce(sum(valor),0) into v_prem from public.fechamento_remuneracao_premiacao
      where competencia = v_ini and lower(beneficiario_email) = r.email;
    if not v_elig_prem then v_prem := 0; end if;

    -- Ajustes
    select
      coalesce(sum(valor) filter (where tipo='bonus'),0),
      coalesce(sum(valor) filter (where tipo in ('correcao_positiva')),0)
        - coalesce(sum(valor) filter (where tipo in ('correcao_negativa')),0),
      coalesce(sum(valor) filter (where tipo='desconto'),0),
      coalesce(sum(valor) filter (where tipo='estorno'),0)
    into v_bonus, v_correcoes, v_desc, v_estorno
    from public.fechamento_remuneracao_ajuste
      where competencia = v_ini and lower(beneficiario_email) = r.email;

    v_total_final := coalesce(v_valor_fixo,0) + coalesce(v_comissao,0) + coalesce(v_prem,0)
                     + coalesce(v_bonus,0) + coalesce(v_correcoes,0)
                     - coalesce(v_desc,0) - coalesce(v_estorno,0);

    v_situacao := case
      when v_comissao is null then 'BLOQUEADO: faixas nao configuradas'
      when not v_elig then 'Sem comissao'
      when v_falta is not null and v_falta > 0 then 'Faltam R$ '||to_char(v_falta,'FM999G999G990D00')||' p/ proxima faixa'
      else 'OK' end;

    v_benef := v_benef || jsonb_build_object(
      'email', r.email, 'nome', coalesce(r.nome, r.email),
      'tipo_vinculo', v_tipo_vinc, 'nome_exibicao_fixo', v_nome_fixo,
      'valor_fixo', v_valor_fixo, 'elegivel_comissao', v_elig, 'regra_comissao', v_regra,
      'qtd_pagamentos', r.qtd, 'valor_recuperado', r.recuperado, 'honorarios', r.honorarios,
      'faixa', v_faixa, 'percentual', v_pct, 'comissao', v_comissao,
      'premiacoes', v_prem, 'bonus', v_bonus, 'correcoes', v_correcoes,
      'descontos', v_desc, 'estornos', v_estorno,
      'total_final', v_total_final, 'falta_proxima_faixa', v_falta, 'situacao', v_situacao);

    t_fixo := t_fixo + coalesce(v_valor_fixo,0);
    t_rec  := t_rec + coalesce(r.recuperado,0);
    t_hon  := t_hon + coalesce(r.honorarios,0);
    t_com  := t_com + coalesce(v_comissao,0);
    t_prem := t_prem + coalesce(v_prem,0);
    t_bonus:= t_bonus + coalesce(v_bonus,0);
    t_corr := t_corr + coalesce(v_correcoes,0);
    t_desc := t_desc + coalesce(v_desc,0);
    t_est  := t_est + coalesce(v_estorno,0);
    t_final:= t_final + coalesce(v_total_final,0);
  end loop;

  -- SEM OPERADOR
  select jsonb_build_object(
      'qtd', count(*),
      'valor_recuperado', coalesce(sum(valor_pago),0),
      'honorarios', coalesce(sum(valor_honorario),0),
      'motivo', 'Pagamento sem atribuicao segura de operador')
    into v_sem
  from public.pagamentos
  where data_pagamento >= v_ini and data_pagamento < v_prox and operador_email is null;

  -- Reconciliacao com a Projecao (mesma base)
  select coalesce(sum(valor_pago),0), coalesce(sum(valor_honorario),0), count(*)
    into v_all_rec, v_all_hon, v_all_qtd
  from public.pagamentos
  where data_pagamento >= v_ini and data_pagamento < v_prox;

  begin
    v_proj := public.projecao_calcular_filial(v_mes);
    v_proj_rec := coalesce((v_proj->>'acumulado_mes')::numeric, (v_proj->>'recuperado_mes')::numeric, v_all_rec);
    v_proj_hon := coalesce((v_proj->>'honorario_mes')::numeric, v_all_hon);
  exception when others then
    v_proj_rec := v_all_rec; v_proj_hon := v_all_hon;
  end;

  return jsonb_build_object(
    'competencia', v_mes,
    'periodo_inicio', v_ini, 'periodo_fim', v_fim,
    'faixas_configuradas', v_tem_faixa,
    'faixas', jsonb_build_object('m1_valor',v_m1,'m1_percentual',v_m1p,'m2_valor',v_m2,'m2_percentual',v_m2p,
                                 'm3_valor',v_m3,'m3_percentual',v_m3p,'m4_valor',v_m4,'m4_percentual',v_m4p),
    'beneficiarios', v_benef,
    'nao_elegiveis', v_nao_eleg,
    'sem_operador', v_sem,
    'totais', jsonb_build_object(
      'total_fixo', t_fixo, 'total_recuperado', t_rec, 'total_honorario', t_hon,
      'total_comissao', t_com, 'total_premiacao', t_prem, 'total_bonus', t_bonus,
      'total_correcoes', t_corr, 'total_desconto', t_desc, 'total_estorno', t_est,
      'total_final', t_final,
      'valor_sem_operador', (v_sem->>'valor_recuperado')::numeric,
      'honorario_sem_operador', (v_sem->>'honorarios')::numeric,
      'qtd_sem_operador', (v_sem->>'qtd')::int),
    'reconciliacao', jsonb_build_object(
      'fechamento_recuperado_total', v_all_rec,
      'fechamento_honorario_total', v_all_hon,
      'projecao_recuperado', v_proj_rec,
      'projecao_honorario', v_proj_hon,
      'diff_recuperado', round(coalesce(v_all_rec,0) - coalesce(v_proj_rec,0), 2),
      'diff_honorario', round(coalesce(v_all_hon,0) - coalesce(v_proj_hon,0), 2),
      'ok', round(coalesce(v_all_rec,0) - coalesce(v_proj_rec,0), 2) = 0
        and round(coalesce(v_all_hon,0) - coalesce(v_proj_hon,0), 2) = 0),
    'gerado_em', now()
  );
end;
$$;

comment on function public.calcular_fechamento_remuneracao(date) is
  'Calcula a PREVIA do fechamento de remuneracao (nao persiste). Comissao = honorarios x faixa. Reconcilia com a Projecao. Acesso exclusivo Amanda.';

-- Revoga acesso amplo; concede apenas a authenticated (guard interno filtra Amanda).
revoke all on function public.usuario_pode_acessar_fechamento_remuneracao() from public;
revoke all on function public.calcular_fechamento_remuneracao(date) from public;
grant execute on function public.calcular_fechamento_remuneracao(date) to authenticated;
grant execute on function public.usuario_pode_acessar_fechamento_remuneracao() to authenticated;
