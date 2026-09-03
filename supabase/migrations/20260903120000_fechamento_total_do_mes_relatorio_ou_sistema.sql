-- ============================================================================
-- Fechamento: o TOTAL DO MÊS fica no valor do RELATÓRIO do Prime ou no valor
-- do SISTEMA -- escolha da gestão, na aba Conferência Prime.
-- ----------------------------------------------------------------------------
-- Pedido da Amanda (03/09/2026): "preciso que o valor total fique exatamente
-- no que está na conferência (R$ 314.111,79 de honorário e R$ 4.270.236,26
-- recuperado)" e "valores dos operadores não devem ser alterados".
--
-- Então:
--   * cada OPERADOR continua com recuperado / honorário / comissão AO VIVO
--     (pagamentos do sistema) -- nada muda nas linhas deles;
--   * o TOTAL DO MÊS (base da gestão Amanda 3% / Fernanda 1,5%, cabeçalho dos
--     relatórios e o registro do fechamento definitivo) tem duas fontes
--     possíveis: o relatório do Prime da última conferência do mês
--     ("relatorio") ou os pagamentos do sistema ("sistema");
--   * sem escolha registrada, vale o RELATÓRIO assim que existe conferência no
--     mês (é o pedido); sem conferência, só existe o sistema.
--
-- Até aqui a gestão já era "fidelizada" ao honorário do Prime (migration
-- 20260805310000), mas o recuperado da gestão saía do sistema e não havia
-- como escolher. Agora a escolha existe, fica registrada (quem / quando) e
-- vale para recuperado E honorário, sempre juntos.
--
-- A reconciliação com a Projeção NÃO muda: segue comparando sistema x
-- projeção (é a prova de que o fechamento lê os mesmos pagamentos). A
-- diferença Prime x sistema aparece à parte, em `total_mes`.
-- ============================================================================

create table if not exists public.fechamento_conferencia_fonte (
  competencia date primary key,
  fonte text not null check (fonte in ('relatorio', 'sistema')),
  definido_por text not null default coalesce((auth.jwt() ->> 'email'), current_user),
  definido_em timestamptz not null default now(),
  observacao text
);
comment on table public.fechamento_conferencia_fonte is
  'Escolha da gestão, por competência, de qual valor vale como TOTAL DO MÊS no Fechamento de Remuneração: relatorio (Prime, da última Conferência Prime do mês) ou sistema (pagamentos). Não altera os operadores.';

alter table public.fechamento_conferencia_fonte enable row level security;
revoke all on public.fechamento_conferencia_fonte from anon, authenticated;

-- O fechamento definitivo guarda qual total valeu e de onde veio.
alter table public.fechamento_remuneracao add column if not exists total_mes_recuperado numeric;
alter table public.fechamento_remuneracao add column if not exists total_mes_honorario numeric;
alter table public.fechamento_remuneracao add column if not exists total_mes_fonte text;

-- ----------------------------------------------------------------------------
-- RPC: o que vale hoje como total do mês (para a aba mostrar as duas opções
-- com os números e qual está em vigor).
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_conferencia_fonte_ler(p_competencia date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_ini date := date_trunc('month', p_competencia)::date;
  v_prox date := (date_trunc('month', p_competencia) + interval '1 month')::date;
  v_esc_fonte text; v_esc_por text; v_esc_em timestamptz; v_esc_obs text;
  v_conf_id uuid; v_conf_em timestamptz; v_conf_por text; v_conf_arq text;
  v_p_vp numeric; v_p_vh numeric; v_s_vp numeric; v_s_vh numeric; v_d_vp numeric; v_d_vh numeric; v_bateu boolean;
  v_agora_vp numeric; v_agora_vh numeric; v_agora_q int;
  v_tem_conf boolean; v_tem_esc boolean;
begin
  perform public.fechamento_exigir_acesso('ler_fonte_total');

  select fonte, definido_por, definido_em, observacao
    into v_esc_fonte, v_esc_por, v_esc_em, v_esc_obs
    from public.fechamento_conferencia_fonte where competencia = v_ini;
  v_tem_esc := found;

  select id, criado_em, criado_por, arquivo_nome, total_prime_valor, total_prime_honorario,
         total_sistema_valor, total_sistema_honorario, diff_valor, diff_honorario, bateu
    into v_conf_id, v_conf_em, v_conf_por, v_conf_arq, v_p_vp, v_p_vh, v_s_vp, v_s_vh, v_d_vp, v_d_vh, v_bateu
    from public.fechamento_conferencia_prime
   where competencia = v_ini order by criado_em desc limit 1;
  v_tem_conf := found;

  select coalesce(sum(valor_pago), 0), coalesce(sum(valor_honorario), 0), count(*)
    into v_agora_vp, v_agora_vh, v_agora_q
    from public.pagamentos where data_pagamento >= v_ini and data_pagamento < v_prox;

  return jsonb_build_object(
    'competencia', to_char(v_ini, 'YYYY-MM'),
    'em_vigor', case when v_tem_conf and coalesce(v_esc_fonte, 'relatorio') = 'relatorio' then 'relatorio' else 'sistema' end,
    'escolha', case when v_tem_esc then jsonb_build_object(
        'fonte', v_esc_fonte, 'definido_por', v_esc_por, 'definido_em', v_esc_em, 'observacao', v_esc_obs) end,
    'conferencia', case when v_tem_conf then jsonb_build_object(
        'id', v_conf_id, 'criado_em', v_conf_em, 'criado_por', v_conf_por, 'arquivo_nome', v_conf_arq,
        'prime_valor', v_p_vp, 'prime_honorario', v_p_vh,
        'sistema_valor', v_s_vp, 'sistema_honorario', v_s_vh,
        'diff_valor', v_d_vp, 'diff_honorario', v_d_vh, 'bateu', v_bateu) end,
    'sistema_agora', jsonb_build_object('valor', v_agora_vp, 'honorario', v_agora_vh, 'qtd', v_agora_q),
    'competencia_fechada', exists (select 1 from public.fechamento_remuneracao
                                    where competencia = v_ini and status = 'FECHADO'));
end;
$function$;

-- ----------------------------------------------------------------------------
-- RPC: registra a escolha. "relatorio" exige conferência no mês; competência
-- FECHADA não aceita troca (reabrir antes).
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_conferencia_definir_fonte(
  p_competencia date, p_fonte text, p_observacao text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ini date := date_trunc('month', p_competencia)::date;
  v_email text := lower(coalesce((auth.jwt() ->> 'email'), current_user));
  v_anterior text;
begin
  perform public.fechamento_exigir_acesso('definir_fonte_total');
  if p_fonte not in ('relatorio', 'sistema') then
    raise exception 'Fonte inválida: use "relatorio" ou "sistema".' using errcode = '22023';
  end if;
  if exists (select 1 from public.fechamento_remuneracao where competencia = v_ini and status = 'FECHADO') then
    raise exception 'Competência % já está FECHADA: reabra o fechamento antes de trocar a fonte do total.',
      to_char(v_ini, 'MM/YYYY') using errcode = '42501';
  end if;
  if p_fonte = 'relatorio'
     and not exists (select 1 from public.fechamento_conferencia_prime where competencia = v_ini) then
    raise exception 'Não há Conferência Prime em %: rode a conferência antes de deixar o valor do relatório.',
      to_char(v_ini, 'MM/YYYY') using errcode = '22023';
  end if;

  select fonte into v_anterior from public.fechamento_conferencia_fonte where competencia = v_ini;

  insert into public.fechamento_conferencia_fonte (competencia, fonte, definido_por, definido_em, observacao)
  values (v_ini, p_fonte, v_email, now(), p_observacao)
  on conflict (competencia) do update
    set fonte = excluded.fonte, definido_por = excluded.definido_por,
        definido_em = excluded.definido_em, observacao = excluded.observacao;

  perform public.fechamento_log_acesso(true, 'definir_fonte_total',
    'competencia=' || to_char(v_ini, 'YYYY-MM') || ' fonte=' || p_fonte
    || coalesce(' (antes: ' || v_anterior || ')', ''));

  return public.fechamento_conferencia_fonte_ler(v_ini);
end;
$function$;

-- ----------------------------------------------------------------------------
-- Prévia do fechamento. Corpo = o que está em produção (03/09/2026) mais:
--   * lê a escolha (fechamento_conferencia_fonte) e os totais do Prime da
--     última conferência (valor E honorário);
--   * TOTAL DO MÊS (v_mes_rec / v_mes_hon) = Prime quando a escolha em vigor é
--     "relatorio"; senão sistema. É a base da gestão e o que a gestão exibe
--     como recuperado / honorário do mês;
--   * devolve `total_mes` (fonte, os dois lados e a diferença) e, em `totais`,
--     total_mes_recuperado / total_mes_honorario / total_mes_fonte;
--   * operadores: intocados (ao vivo). Reconciliação: intocada (sistema x
--     projeção).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calcular_fechamento_remuneracao(p_competencia date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mes text := to_char(p_competencia, 'YYYY-MM');
  v_ini date := date_trunc('month', p_competencia)::date;
  v_prox date := (date_trunc('month', p_competencia) + interval '1 month')::date;
  v_fim date := (v_prox - interval '1 day')::date;
  v_equipe8 text[] := array['cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br'];
  v_adm text := 'cobranca07@aelbra.com.br';
  v_gestao text[] := array['amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br'];
  v_m1 numeric; v_m1p numeric; v_m2 numeric; v_m2p numeric; v_m3 numeric; v_m3p numeric; v_m4 numeric; v_m4p numeric;
  v_tem_faixa boolean;
  v_benef jsonb := '[]'::jsonb; v_nao_eleg jsonb := '[]'::jsonb; v_sem jsonb;
  r record; v_cfg record;
  v_valor_fixo numeric; v_tipo_vinc text; v_nome_fixo text; v_elig boolean; v_regra text; v_pctfix numeric; v_elig_prem boolean;
  v_sal_dre numeric; v_nome_dre text; v_prem_dre numeric;
  v_tem_prime boolean := false; v_prime_ops jsonb; v_prime_total_hon numeric; v_prime_total_val numeric;
  v_conf_id uuid; v_conf_em timestamptz; v_conf_arq text;
  v_escolha text; v_usa_prime boolean := false; v_fonte_curta text;
  v_mes_rec numeric; v_mes_hon numeric;
  v_hon_prime numeric; v_val_prime numeric; v_hon_base numeric; v_rec_base numeric; v_base_gestao_hon numeric; v_fonte text;
  v_pct numeric; v_faixa text; v_comissao numeric; v_prox_faixa numeric; v_falta numeric;
  v_prem numeric; v_bonus numeric; v_correcoes numeric; v_desc numeric; v_estorno numeric;
  v_total_final numeric; v_situacao text;
  t_fixo numeric := 0; t_rec numeric := 0; t_hon numeric := 0; t_com numeric := 0;
  t_prem numeric := 0; t_bonus numeric := 0; t_corr numeric := 0; t_desc numeric := 0; t_est numeric := 0; t_final numeric := 0;
  v_proj jsonb; v_proj_rec numeric; v_proj_hon numeric; v_all_rec numeric; v_all_hon numeric; v_all_qtd int;
begin
  perform public.fechamento_exigir_acesso('calcular_previa');
  select coalesce(m1_valor,0),coalesce(m1_percentual,0),coalesce(m2_valor,0),coalesce(m2_percentual,0),
         coalesce(m3_valor,0),coalesce(m3_percentual,0),coalesce(m4_valor,0),coalesce(m4_percentual,0)
    into v_m1,v_m1p,v_m2,v_m2p,v_m3,v_m3p,v_m4,v_m4p
  from public.metas_projecao where mes_referencia = v_mes;
  v_tem_faixa := found and coalesce(v_m1p,0)+coalesce(v_m2p,0)+coalesce(v_m3p,0)+coalesce(v_m4p,0) > 0;
  v_m1:=coalesce(v_m1,0); v_m1p:=coalesce(v_m1p,0); v_m2:=coalesce(v_m2,0); v_m2p:=coalesce(v_m2p,0);
  v_m3:=coalesce(v_m3,0); v_m3p:=coalesce(v_m3p,0); v_m4:=coalesce(v_m4,0); v_m4p:=coalesce(v_m4p,0);

  -- Última Conferência Prime do mês: os totais do RELATÓRIO (valor e honorário).
  select id, criado_em, arquivo_nome, total_prime_valor, total_prime_honorario, resumo->'resumo_por_operador'
    into v_conf_id, v_conf_em, v_conf_arq, v_prime_total_val, v_prime_total_hon, v_prime_ops
  from public.fechamento_conferencia_prime
  where competencia = v_ini order by criado_em desc limit 1;
  v_tem_prime := found;

  -- Escolha da gestão para o TOTAL DO MÊS (aba Conferência Prime): relatório
  -- ou sistema. Sem escolha registrada, vale o relatório assim que existe
  -- conferência (Amanda, 03/09/2026: o total do fechamento fica exatamente
  -- no que está na conferência). Os operadores NÃO mudam com isso.
  select fonte into v_escolha from public.fechamento_conferencia_fonte where competencia = v_ini;
  v_usa_prime := v_tem_prime and coalesce(v_escolha, 'relatorio') = 'relatorio';
  v_fonte := case when v_usa_prime then 'PRIME (relatório da conferência)'
                  when v_tem_prime then 'sistema (ao vivo) - escolha da gestão'
                  else 'sistema (ao vivo)' end;
  v_fonte_curta := case when v_usa_prime then 'relatorio' else 'sistema' end;

  for r in
    with prod as (
      select lower(operador_email) as email, max(operador_nome) as nome, count(*) as qtd,
             coalesce(sum(valor_pago),0) as recuperado, coalesce(sum(valor_honorario),0) as honorarios
      from public.pagamentos where data_pagamento >= v_ini and data_pagamento < v_prox and operador_email is not null
      group by lower(operador_email)),
    cfg as (select lower(beneficiario_email) as email from public.fechamento_remuneracao_config where competencia = v_ini)
    select coalesce(prod.email, cfg.email) as email, prod.nome, coalesce(prod.qtd,0) as qtd,
           coalesce(prod.recuperado,0) as recuperado, coalesce(prod.honorarios,0) as honorarios
    from prod full outer join cfg on prod.email = cfg.email order by 1
  loop
    if r.email = any(v_gestao) then continue; end if;
    select * into v_cfg from public.fechamento_remuneracao_config
      where competencia = v_ini and lower(beneficiario_email) = r.email;
    if found then
      v_valor_fixo := coalesce(v_cfg.valor_fixo,0); v_tipo_vinc := v_cfg.tipo_vinculo;
      v_nome_fixo := v_cfg.nome_exibicao_fixo; v_elig := v_cfg.elegivel_comissao;
      v_regra := v_cfg.regra_comissao; v_pctfix := v_cfg.percentual_fixo; v_elig_prem := v_cfg.elegivel_premiacao;
    else
      v_valor_fixo := 0; v_tipo_vinc := 'contratual'; v_nome_fixo := 'Valor fixo contratual'; v_elig_prem := true;
      if r.email = v_adm then v_elig := true; v_regra := 'percentual_fixo'; v_pctfix := 8;
      elsif r.email = any(v_equipe8) then v_elig := true; v_regra := 'faixa'; v_pctfix := null;
      else v_elig := false; v_regra := 'nenhuma'; v_pctfix := null; end if;
    end if;
    select salario_base, nome into v_sal_dre, v_nome_dre from public.dre_funcionario
      where lower(operador_email) = r.email and ativo is true
      order by coalesce(data_inicio, '1900-01-01') desc limit 1;
    if v_sal_dre is not null then v_valor_fixo := v_sal_dre; end if;
    -- Operadores: base sempre AO VIVO (sistema). A escolha relatório/sistema é só do total do mês.
    v_hon_base := r.honorarios; v_rec_base := r.recuperado;
    v_pct := 0; v_faixa := 'Sem faixa'; v_comissao := 0; v_prox_faixa := null; v_falta := null;
    if v_elig then
      if v_regra = 'percentual_fixo' then
        v_pct := coalesce(v_pctfix,0); v_faixa := 'Percentual fixo ('||v_pct||'%)';
        v_comissao := trunc(v_hon_base * v_pct/100.0, 2);
      elsif v_regra = 'faixa' then
        if not v_tem_faixa then v_faixa := 'FAIXAS NAO CONFIGURADAS'; v_comissao := null;
        else
          v_pct := case when v_m4>0 and v_hon_base>=v_m4 then v_m4p when v_m3>0 and v_hon_base>=v_m3 then v_m3p
            when v_m2>0 and v_hon_base>=v_m2 then v_m2p when v_m1>0 and v_hon_base>=v_m1 then v_m1p else 0 end;
          v_faixa := case when v_m4>0 and v_hon_base>=v_m4 then 'Faixa 4 ('||v_m4p||'%)'
            when v_m3>0 and v_hon_base>=v_m3 then 'Faixa 3 ('||v_m3p||'%)'
            when v_m2>0 and v_hon_base>=v_m2 then 'Faixa 2 ('||v_m2p||'%)'
            when v_m1>0 and v_hon_base>=v_m1 then 'Faixa 1 ('||v_m1p||'%)' else 'Abaixo da faixa minima (0%)' end;
          v_comissao := trunc(v_hon_base * v_pct/100.0, 2);
          v_prox_faixa := case when v_m2>0 and v_hon_base<v_m2 then v_m2 when v_m3>0 and v_hon_base<v_m3 then v_m3
            when v_m4>0 and v_hon_base<v_m4 then v_m4 else null end;
          v_falta := case when v_prox_faixa is null then 0 else round(v_prox_faixa - v_hon_base,2) end;
        end if;
      end if;
    end if;
    if v_nome_dre is not null then
      select fo.premiacao into v_prem_dre
      from public.dre_folha fo join public.dre_funcionario f on f.id = fo.funcionario_id
      where lower(f.operador_email) = r.email and fo.competencia = v_ini
      order by fo.atualizado_em desc nulls last limit 1;
      v_prem := coalesce(v_prem_dre, 0);
    else
      select coalesce(sum(valor),0) into v_prem from public.fechamento_remuneracao_premiacao
        where competencia = v_ini and lower(beneficiario_email) = r.email;
    end if;
    if not v_elig_prem then v_prem := 0; end if;
    select coalesce(sum(valor) filter (where tipo='bonus'),0),
      coalesce(sum(valor) filter (where tipo='correcao_positiva'),0) - coalesce(sum(valor) filter (where tipo='correcao_negativa'),0),
      coalesce(sum(valor) filter (where tipo='desconto'),0), coalesce(sum(valor) filter (where tipo='estorno'),0)
    into v_bonus, v_correcoes, v_desc, v_estorno
    from public.fechamento_remuneracao_ajuste where competencia = v_ini and lower(beneficiario_email) = r.email;
    v_total_final := coalesce(v_valor_fixo,0) + coalesce(v_comissao,0) + coalesce(v_prem,0)
                     + coalesce(v_bonus,0) + coalesce(v_correcoes,0) - coalesce(v_desc,0) - coalesce(v_estorno,0);
    v_situacao := case when v_comissao is null then 'BLOQUEADO: faixas nao configuradas'
      when not v_elig then 'Sem comissao'
      when v_falta is not null and v_falta > 0 then 'Faltam p/ proxima faixa' else 'OK' end;
    v_benef := v_benef || jsonb_build_object('email', r.email, 'nome', coalesce(v_nome_dre, r.nome, r.email),
      'tipo_vinculo', v_tipo_vinc, 'nome_exibicao_fixo', v_nome_fixo, 'valor_fixo', v_valor_fixo,
      'elegivel_comissao', v_elig, 'regra_comissao', v_regra, 'qtd_pagamentos', r.qtd,
      'valor_recuperado', v_rec_base, 'honorarios', v_hon_base, 'faixa', v_faixa, 'percentual', v_pct,
      'comissao', v_comissao, 'premiacoes', v_prem, 'bonus', v_bonus, 'correcoes', v_correcoes,
      'descontos', v_desc, 'estornos', v_estorno, 'total_final', v_total_final,
      'falta_proxima_faixa', v_falta, 'situacao', v_situacao, 'honorario_fonte', 'sistema (ao vivo)');
    t_fixo := t_fixo + coalesce(v_valor_fixo,0); t_rec := t_rec + coalesce(v_rec_base,0);
    t_hon := t_hon + coalesce(v_hon_base,0); t_com := t_com + coalesce(v_comissao,0);
    t_prem := t_prem + coalesce(v_prem,0); t_bonus := t_bonus + coalesce(v_bonus,0);
    t_corr := t_corr + coalesce(v_correcoes,0); t_desc := t_desc + coalesce(v_desc,0);
    t_est := t_est + coalesce(v_estorno,0); t_final := t_final + coalesce(v_total_final,0);
  end loop;
  select jsonb_build_object('qtd', count(*), 'valor_recuperado', coalesce(sum(valor_pago),0),
      'honorarios', coalesce(sum(valor_honorario),0), 'motivo', 'Pagamento sem atribuicao segura de operador')
    into v_sem from public.pagamentos where data_pagamento >= v_ini and data_pagamento < v_prox and operador_email is null;
  select coalesce(sum(valor_pago),0), coalesce(sum(valor_honorario),0), count(*)
    into v_all_rec, v_all_hon, v_all_qtd
  from public.pagamentos where data_pagamento >= v_ini and data_pagamento < v_prox;

  -- TOTAL DO MÊS: relatório do Prime (quando é a escolha em vigor) ou sistema.
  -- Vale para a base da gestão e para o que a gestão exibe como recuperado /
  -- honorário do mês. Recuperado e honorário andam sempre juntos.
  v_mes_rec := case when v_usa_prime then coalesce(v_prime_total_val,0) else coalesce(v_all_rec,0) end;
  v_mes_hon := case when v_usa_prime then coalesce(v_prime_total_hon,0) else coalesce(v_all_hon,0) end;
  v_base_gestao_hon := v_mes_hon;

  for r in select * from (values
      ('amanda.seibel@aelbra.com.br', 'Amanda (gestão)', 3::numeric),
      ('cobranca04@aelbra.com.br',    'Fernanda (gestão)', 1.5::numeric)
    ) as g(email, nome, pct)
  loop
    v_comissao := trunc(coalesce(v_base_gestao_hon,0) * r.pct / 100.0, 2);
    select salario_base, nome into v_sal_dre, v_nome_dre from public.dre_funcionario
      where lower(operador_email) = r.email and ativo is true
      order by coalesce(data_inicio, '1900-01-01') desc limit 1;
    v_valor_fixo := coalesce(v_sal_dre, 0);
    if v_nome_dre is not null then
      select fo.premiacao into v_prem_dre
      from public.dre_folha fo join public.dre_funcionario f on f.id = fo.funcionario_id
      where lower(f.operador_email) = r.email and fo.competencia = v_ini
      order by fo.atualizado_em desc nulls last limit 1;
      v_prem := coalesce(v_prem_dre, 0);
    else
      select coalesce(sum(valor),0) into v_prem from public.fechamento_remuneracao_premiacao
        where competencia = v_ini and lower(beneficiario_email) = r.email;
    end if;
    select coalesce(sum(valor) filter (where tipo='bonus'),0),
      coalesce(sum(valor) filter (where tipo='correcao_positiva'),0) - coalesce(sum(valor) filter (where tipo='correcao_negativa'),0),
      coalesce(sum(valor) filter (where tipo='desconto'),0), coalesce(sum(valor) filter (where tipo='estorno'),0)
    into v_bonus, v_correcoes, v_desc, v_estorno
    from public.fechamento_remuneracao_ajuste where competencia = v_ini and lower(beneficiario_email) = r.email;
    v_total_final := v_valor_fixo + v_comissao + coalesce(v_prem,0) + coalesce(v_bonus,0)
                     + coalesce(v_correcoes,0) - coalesce(v_desc,0) - coalesce(v_estorno,0);
    v_benef := v_benef || jsonb_build_object('email', r.email, 'nome', coalesce(v_nome_dre, r.nome),
      'tipo_vinculo', 'gestao', 'nome_exibicao_fixo', 'Salário (DRE)', 'valor_fixo', v_valor_fixo,
      'elegivel_comissao', true, 'regra_comissao', 'percentual_total_honorario',
      'qtd_pagamentos', v_all_qtd, 'valor_recuperado', v_mes_rec, 'honorarios', v_mes_hon,
      'faixa', 'Gestão: '||r.pct::text||'% do honorário total do mês ('
               || case when v_usa_prime then 'relatório do Prime' else 'sistema' end || ')',
      'percentual', r.pct,
      'comissao', v_comissao, 'premiacoes', coalesce(v_prem,0), 'bonus', coalesce(v_bonus,0),
      'correcoes', coalesce(v_correcoes,0), 'descontos', coalesce(v_desc,0), 'estornos', coalesce(v_estorno,0),
      'total_final', v_total_final, 'falta_proxima_faixa', null, 'situacao', 'OK (gestão)', 'honorario_fonte', v_fonte);
    t_fixo := t_fixo + v_valor_fixo; t_com := t_com + v_comissao; t_prem := t_prem + coalesce(v_prem,0);
    t_bonus := t_bonus + coalesce(v_bonus,0); t_corr := t_corr + coalesce(v_correcoes,0);
    t_desc := t_desc + coalesce(v_desc,0); t_est := t_est + coalesce(v_estorno,0);
    t_final := t_final + v_total_final;
  end loop;
  begin
    v_proj := public.projecao_calcular_filial(v_mes);
    v_proj_rec := coalesce((v_proj->>'acumulado_mes')::numeric, (v_proj->>'recuperado_mes')::numeric, v_all_rec);
    v_proj_hon := coalesce((v_proj->>'honorario_mes')::numeric, v_all_hon);
  exception when others then v_proj_rec := v_all_rec; v_proj_hon := v_all_hon;
  end;
  return jsonb_build_object('competencia', v_mes, 'periodo_inicio', v_ini, 'periodo_fim', v_fim,
    'faixas_configuradas', v_tem_faixa, 'honorario_fonte', v_fonte, 'prime_fidelizado', v_usa_prime,
    'faixas', jsonb_build_object('m1_valor',v_m1,'m1_percentual',v_m1p,'m2_valor',v_m2,'m2_percentual',v_m2p,
                                 'm3_valor',v_m3,'m3_percentual',v_m3p,'m4_valor',v_m4,'m4_percentual',v_m4p),
    'beneficiarios', v_benef, 'nao_elegiveis', v_nao_eleg, 'sem_operador', v_sem,
    'total_mes', jsonb_build_object(
      'fonte', v_fonte_curta, 'fonte_descricao', v_fonte, 'escolha_registrada', v_escolha,
      'recuperado', v_mes_rec, 'honorario', v_mes_hon, 'qtd', v_all_qtd,
      'prime_recuperado', v_prime_total_val, 'prime_honorario', v_prime_total_hon,
      'sistema_recuperado', v_all_rec, 'sistema_honorario', v_all_hon,
      'diff_recuperado', case when v_tem_prime then round(coalesce(v_all_rec,0) - coalesce(v_prime_total_val,0), 2) end,
      'diff_honorario', case when v_tem_prime then round(coalesce(v_all_hon,0) - coalesce(v_prime_total_hon,0), 2) end,
      'conferencia_id', v_conf_id, 'conferencia_em', v_conf_em, 'arquivo_nome', v_conf_arq),
    'totais', jsonb_build_object('total_fixo', t_fixo, 'total_recuperado', t_rec, 'total_honorario', t_hon,
      'total_comissao', t_com, 'total_premiacao', t_prem, 'total_bonus', t_bonus, 'total_correcoes', t_corr,
      'total_desconto', t_desc, 'total_estorno', t_est, 'total_final', t_final,
      'valor_sem_operador', (v_sem->>'valor_recuperado')::numeric, 'honorario_sem_operador', (v_sem->>'honorarios')::numeric,
      'qtd_sem_operador', (v_sem->>'qtd')::int,
      'total_mes_recuperado', v_mes_rec, 'total_mes_honorario', v_mes_hon, 'total_mes_fonte', v_fonte_curta),
    'reconciliacao', jsonb_build_object('fechamento_recuperado_total', v_all_rec, 'fechamento_honorario_total', v_all_hon,
      'projecao_recuperado', v_proj_rec, 'projecao_honorario', v_proj_hon,
      'diff_recuperado', round(coalesce(v_all_rec,0) - coalesce(v_proj_rec,0), 2),
      'diff_honorario', round(coalesce(v_all_hon,0) - coalesce(v_proj_hon,0), 2),
      'ok', round(coalesce(v_all_rec,0) - coalesce(v_proj_rec,0), 2) = 0 and round(coalesce(v_all_hon,0) - coalesce(v_proj_hon,0), 2) = 0),
    'gerado_em', now());
end;
$function$;

-- ----------------------------------------------------------------------------
-- Fechamento definitivo: grava o total do mês que valeu (e a fonte). Feito
-- com replace in-place sobre o fonte atual da função (mesmo padrão da
-- 20260804270000), com conferência de que cada trecho existe UMA vez -- se o
-- corpo em produção mudou, a migration para em vez de gravar algo errado.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_src text;
  v_a text := E'qtd_sem_operador,\n    hash_sintetico, hash_analitico, gerado_por';
  v_a2 text := E'qtd_sem_operador,\n    total_mes_recuperado, total_mes_honorario, total_mes_fonte,\n    hash_sintetico, hash_analitico, gerado_por';
  v_b text := E'(v_tot->>''qtd_sem_operador'')::int,\n    p_hash_sintetico, p_hash_analitico';
  v_b2 text := E'(v_tot->>''qtd_sem_operador'')::int,\n    (v_tot->>''total_mes_recuperado'')::numeric, (v_tot->>''total_mes_honorario'')::numeric, v_tot->>''total_mes_fonte'',\n    p_hash_sintetico, p_hash_analitico';
begin
  v_src := pg_get_functiondef('public.fechar_competencia_remuneracao(date,text,text)'::regprocedure);
  if position('total_mes_recuperado' in v_src) > 0 then
    raise notice 'fechar_competencia_remuneracao ja grava total_mes: nada a fazer.';
    return;
  end if;
  if (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a) <> 1
     or (length(v_src) - length(replace(v_src, v_b, ''))) / length(v_b) <> 1 then
    raise exception 'fechar_competencia_remuneracao: trecho esperado nao encontrado exatamente uma vez; revisar a migration antes de aplicar.';
  end if;
  v_src := replace(v_src, v_a, v_a2);
  v_src := replace(v_src, v_b, v_b2);
  execute v_src;
end
$mig$;

-- ----------------------------------------------------------------------------
-- Permissões: mesmas do módulo (authenticated chama; o gate é o
-- fechamento_exigir_acesso dentro da função).
-- ----------------------------------------------------------------------------
revoke all on function public.fechamento_conferencia_fonte_ler(date) from public, anon;
revoke all on function public.fechamento_conferencia_definir_fonte(date, text, text) from public, anon;
grant execute on function public.fechamento_conferencia_fonte_ler(date) to authenticated;
grant execute on function public.fechamento_conferencia_definir_fonte(date, text, text) to authenticated;
