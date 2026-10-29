-- ============================================================================
-- Fechamento: PREMIACAO automatica do DRE (dre_folha.premiacao).
-- Decisao Amanda 2026-08-04: premiacao lancada no DRE deve refletir sozinha
-- no relatorio (igual ao salario), sem carga manual. calcular_fechamento_
-- remuneracao passa a ler dre_folha.premiacao pelo operador_email+competencia;
-- fallback na tabela fechamento_remuneracao_premiacao so p/ quem nao esta
-- mapeado no DRE. Premiacao de julho ainda nao lancada => 0 (automatico).
-- ============================================================================
create or replace function public.calcular_fechamento_remuneracao(p_competencia date)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
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
    -- Salario (valor fixo) vem do DRE (fonte unica), pelo operador_email.
    select salario_base, nome into v_sal_dre, v_nome_dre from public.dre_funcionario
      where lower(operador_email) = r.email and ativo is true
      order by coalesce(data_inicio, '1900-01-01') desc limit 1;
    if v_sal_dre is not null then v_valor_fixo := v_sal_dre; end if;

    v_pct := 0; v_faixa := 'Sem faixa'; v_comissao := 0; v_prox_faixa := null; v_falta := null;
    if v_elig then
      if v_regra = 'percentual_fixo' then
        v_pct := coalesce(v_pctfix,0); v_faixa := 'Percentual fixo ('||v_pct||'%)';
        v_comissao := trunc(r.honorarios * v_pct/100.0, 2);
      elsif v_regra = 'faixa' then
        if not v_tem_faixa then v_faixa := 'FAIXAS NAO CONFIGURADAS'; v_comissao := null;
        else
          v_pct := case when v_m4>0 and r.honorarios>=v_m4 then v_m4p when v_m3>0 and r.honorarios>=v_m3 then v_m3p
            when v_m2>0 and r.honorarios>=v_m2 then v_m2p when v_m1>0 and r.honorarios>=v_m1 then v_m1p else 0 end;
          v_faixa := case when v_m4>0 and r.honorarios>=v_m4 then 'Faixa 4 ('||v_m4p||'%)'
            when v_m3>0 and r.honorarios>=v_m3 then 'Faixa 3 ('||v_m3p||'%)'
            when v_m2>0 and r.honorarios>=v_m2 then 'Faixa 2 ('||v_m2p||'%)'
            when v_m1>0 and r.honorarios>=v_m1 then 'Faixa 1 ('||v_m1p||'%)' else 'Abaixo da faixa minima (0%)' end;
          v_comissao := trunc(r.honorarios * v_pct/100.0, 2);
          v_prox_faixa := case when v_m2>0 and r.honorarios<v_m2 then v_m2 when v_m3>0 and r.honorarios<v_m3 then v_m3
            when v_m4>0 and r.honorarios<v_m4 then v_m4 else null end;
          v_falta := case when v_prox_faixa is null then 0 else round(v_prox_faixa - r.honorarios,2) end;
        end if;
      end if;
    end if;
    -- Premiacao AUTOMATICA do DRE (dre_folha.premiacao) pelo operador_email.
    -- Se a pessoa nao esta mapeada no DRE, cai na tabela de premiacoes do fechamento.
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
      'valor_recuperado', r.recuperado, 'honorarios', r.honorarios, 'faixa', v_faixa, 'percentual', v_pct,
      'comissao', v_comissao, 'premiacoes', v_prem, 'bonus', v_bonus, 'correcoes', v_correcoes,
      'descontos', v_desc, 'estornos', v_estorno, 'total_final', v_total_final,
      'falta_proxima_faixa', v_falta, 'situacao', v_situacao);
    t_fixo := t_fixo + coalesce(v_valor_fixo,0); t_rec := t_rec + coalesce(r.recuperado,0);
    t_hon := t_hon + coalesce(r.honorarios,0); t_com := t_com + coalesce(v_comissao,0);
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
  -- Override de GESTAO (recorrente): Amanda 3% e Fernanda 1,5% sobre honorario TOTAL.
  -- Salario tambem vem do DRE.
  for r in select * from (values
      ('amanda.seibel@aelbra.com.br', 'Amanda (gestão)', 3::numeric),
      ('cobranca04@aelbra.com.br',    'Fernanda (gestão)', 1.5::numeric)
    ) as g(email, nome, pct)
  loop
    v_comissao := trunc(coalesce(v_all_hon,0) * r.pct / 100.0, 2);
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
      'qtd_pagamentos', 0, 'valor_recuperado', 0, 'honorarios', 0,
      'faixa', 'Gestão: '||r.pct::text||'% do honorário total do mês', 'percentual', r.pct,
      'comissao', v_comissao, 'premiacoes', coalesce(v_prem,0), 'bonus', coalesce(v_bonus,0),
      'correcoes', coalesce(v_correcoes,0), 'descontos', coalesce(v_desc,0), 'estornos', coalesce(v_estorno,0),
      'total_final', v_total_final, 'falta_proxima_faixa', null, 'situacao', 'OK (gestão)');
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
    'faixas_configuradas', v_tem_faixa,
    'faixas', jsonb_build_object('m1_valor',v_m1,'m1_percentual',v_m1p,'m2_valor',v_m2,'m2_percentual',v_m2p,
                                 'm3_valor',v_m3,'m3_percentual',v_m3p,'m4_valor',v_m4,'m4_percentual',v_m4p),
    'beneficiarios', v_benef, 'nao_elegiveis', v_nao_eleg, 'sem_operador', v_sem,
    'totais', jsonb_build_object('total_fixo', t_fixo, 'total_recuperado', t_rec, 'total_honorario', t_hon,
      'total_comissao', t_com, 'total_premiacao', t_prem, 'total_bonus', t_bonus, 'total_correcoes', t_corr,
      'total_desconto', t_desc, 'total_estorno', t_est, 'total_final', t_final,
      'valor_sem_operador', (v_sem->>'valor_recuperado')::numeric, 'honorario_sem_operador', (v_sem->>'honorarios')::numeric,
      'qtd_sem_operador', (v_sem->>'qtd')::int),
    'reconciliacao', jsonb_build_object('fechamento_recuperado_total', v_all_rec, 'fechamento_honorario_total', v_all_hon,
      'projecao_recuperado', v_proj_rec, 'projecao_honorario', v_proj_hon,
      'diff_recuperado', round(coalesce(v_all_rec,0) - coalesce(v_proj_rec,0), 2),
      'diff_honorario', round(coalesce(v_all_hon,0) - coalesce(v_proj_hon,0), 2),
      'ok', round(coalesce(v_all_rec,0) - coalesce(v_proj_rec,0), 2) = 0 and round(coalesce(v_all_hon,0) - coalesce(v_proj_hon,0), 2) = 0),
    'gerado_em', now());
end;
$function$;
