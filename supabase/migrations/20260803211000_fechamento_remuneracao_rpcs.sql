-- ============================================================================
-- FECHAMENTO REMUNERACAO - RPCs de gestao (CRUD), fechar/reabrir, consultar,
-- analitico mascarado, bucket privado + URL temporaria.
-- Todas exigem acesso exclusivo Amanda (fechamento_exigir_acesso).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- CRUD: Configuracao historica do beneficiario
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_salvar_config(
  p_competencia date, p_email text, p_nome text,
  p_tipo_vinculo text, p_nome_exibicao_fixo text, p_valor_fixo numeric,
  p_elegivel_comissao boolean, p_regra_comissao text, p_percentual_fixo numeric,
  p_elegivel_premiacao boolean, p_observacao text default null
) returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare v_id uuid; v_email_atual text := lower(coalesce((auth.jwt() ->> 'email'), current_user));
begin
  perform public.fechamento_exigir_acesso('salvar_config');
  insert into public.fechamento_remuneracao_config(
    competencia, beneficiario_email, beneficiario_nome, tipo_vinculo, nome_exibicao_fixo,
    valor_fixo, elegivel_comissao, regra_comissao, percentual_fixo, elegivel_premiacao,
    observacao, criado_por)
  values (date_trunc('month', p_competencia)::date, lower(p_email), p_nome,
    coalesce(p_tipo_vinculo,'contratual'), coalesce(p_nome_exibicao_fixo,'Valor fixo contratual'),
    coalesce(p_valor_fixo,0), coalesce(p_elegivel_comissao,true), coalesce(p_regra_comissao,'faixa'),
    p_percentual_fixo, coalesce(p_elegivel_premiacao,true), p_observacao, v_email_atual)
  on conflict (competencia, beneficiario_email) do update set
    beneficiario_nome = excluded.beneficiario_nome, tipo_vinculo = excluded.tipo_vinculo,
    nome_exibicao_fixo = excluded.nome_exibicao_fixo, valor_fixo = excluded.valor_fixo,
    elegivel_comissao = excluded.elegivel_comissao, regra_comissao = excluded.regra_comissao,
    percentual_fixo = excluded.percentual_fixo, elegivel_premiacao = excluded.elegivel_premiacao,
    observacao = excluded.observacao, alterado_por = v_email_atual, alterado_em = now()
  returning id into v_id;
  return v_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- CRUD: Premiacao
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_registrar_premiacao(
  p_competencia date, p_email text, p_nome text, p_tipo text, p_nome_campanha text,
  p_descricao text, p_criterio text, p_valor numeric, p_origem text,
  p_comprovante_ref text default null, p_observacao text default null
) returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare v_id uuid; v_atual text := lower(coalesce((auth.jwt() ->> 'email'), current_user));
begin
  perform public.fechamento_exigir_acesso('registrar_premiacao');
  insert into public.fechamento_remuneracao_premiacao(
    competencia, beneficiario_email, beneficiario_nome, tipo, nome_campanha, descricao,
    criterio, valor, origem, comprovante_ref, observacao, criado_por)
  values (date_trunc('month', p_competencia)::date, lower(p_email), p_nome,
    coalesce(p_tipo,'premiacao_campanha'), p_nome_campanha, p_descricao, p_criterio,
    p_valor, p_origem, p_comprovante_ref, p_observacao, v_atual)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.fechamento_excluir_premiacao(p_id uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$ begin
  perform public.fechamento_exigir_acesso('excluir_premiacao');
  delete from public.fechamento_remuneracao_premiacao where id = p_id;
end; $$;

-- ----------------------------------------------------------------------------
-- CRUD: Ajuste (bonus/correcao/desconto/estorno)
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_registrar_ajuste(
  p_competencia date, p_email text, p_nome text, p_tipo text, p_natureza text,
  p_valor numeric, p_motivo text, p_documento_ref text default null
) returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare v_id uuid; v_atual text := lower(coalesce((auth.jwt() ->> 'email'), current_user));
begin
  perform public.fechamento_exigir_acesso('registrar_ajuste');
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'Motivo obrigatorio para ajustes.';
  end if;
  insert into public.fechamento_remuneracao_ajuste(
    competencia, beneficiario_email, beneficiario_nome, tipo, natureza, valor, motivo, documento_ref, criado_por)
  values (date_trunc('month', p_competencia)::date, lower(p_email), p_nome,
    p_tipo, p_natureza, abs(coalesce(p_valor,0)), p_motivo, p_documento_ref, v_atual)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.fechamento_excluir_ajuste(p_id uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$ begin
  perform public.fechamento_exigir_acesso('excluir_ajuste');
  delete from public.fechamento_remuneracao_ajuste where id = p_id;
end; $$;

-- ----------------------------------------------------------------------------
-- Leitura auxiliar: config/premiacoes/ajustes da competencia
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_listar_lancamentos(p_competencia date)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_ini date := date_trunc('month', p_competencia)::date; v jsonb;
begin
  perform public.fechamento_exigir_acesso('listar_lancamentos');
  select jsonb_build_object(
    'config', coalesce((select jsonb_agg(to_jsonb(c) order by c.beneficiario_email)
                        from public.fechamento_remuneracao_config c where c.competencia = v_ini), '[]'::jsonb),
    'premiacoes', coalesce((select jsonb_agg(to_jsonb(p) order by p.criado_em)
                        from public.fechamento_remuneracao_premiacao p where p.competencia = v_ini), '[]'::jsonb),
    'ajustes', coalesce((select jsonb_agg(to_jsonb(a) order by a.criado_em)
                        from public.fechamento_remuneracao_ajuste a where a.competencia = v_ini), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- Analitico (previa, mascarado) - pagamentos considerados no periodo
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_analitico_pagamentos(p_competencia date)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare
  v_ini date := date_trunc('month', p_competencia)::date;
  v_prox date := (date_trunc('month', p_competencia) + interval '1 month')::date;
  v jsonb;
begin
  perform public.fechamento_exigir_acesso('analitico_pagamentos');
  select coalesce(jsonb_agg(jsonb_build_object(
      'data_pagamento', pg.data_pagamento,
      'pagamento_id', pg.id,
      'importacao_id', pg.importacao_id,
      'aluno_mascarado', coalesce(nullif(split_part(pg.aluno_nome,' ',1),'') || ' ***',
                                  'ALUNO ' || right(coalesce(pg.aluno_id::text,'----'),4)),
      'operador_email', pg.operador_email,
      'operador_nome', pg.operador_nome,
      'tipo_pagamento', pg.tipo_pagamento,
      'numero_parcela', pg.numero_parcela_completo,
      'valor_recuperado', pg.valor_pago,
      'honorarios', pg.valor_honorario,
      'retroativo', pg.retroativo,
      'elegivel_comissao', (pg.operador_email is not null),
      'motivo_exclusao', case when pg.operador_email is null then 'Sem operador' else null end
    ) order by pg.data_pagamento, pg.id), '[]'::jsonb) into v
  from public.pagamentos pg
  where pg.data_pagamento >= v_ini and pg.data_pagamento < v_prox;
  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- FECHAR competencia (congela snapshot). NAO chamado automaticamente.
-- ----------------------------------------------------------------------------
create or replace function public.fechar_competencia_remuneracao(
  p_competencia date, p_hash_sintetico text default null, p_hash_analitico text default null
) returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare
  v_ini date := date_trunc('month', p_competencia)::date;
  v_prox date := (date_trunc('month', p_competencia) + interval '1 month')::date;
  v_fim date := (v_prox - interval '1 day')::date;
  v_calc jsonb; v_tot jsonb; v_fx jsonb; v_recon jsonb;
  v_versao int; v_id uuid; v_atual text := lower(coalesce((auth.jwt() ->> 'email'), current_user));
  b jsonb; v_pos int := 0;
begin
  perform public.fechamento_exigir_acesso('fechar_competencia');
  v_calc := public.calcular_fechamento_remuneracao(p_competencia);
  v_recon := v_calc->'reconciliacao';
  if (v_recon->>'ok') <> 'true' then
    raise exception 'Fechamento bloqueado: divergencia com a Projecao (rec % / hon %).',
      v_recon->>'diff_recuperado', v_recon->>'diff_honorario';
  end if;
  if (v_calc->>'faixas_configuradas') <> 'true' then
    raise exception 'Fechamento bloqueado: faixas de comissao nao configuradas para a competencia.';
  end if;

  select coalesce(max(versao),0) + 1 into v_versao
    from public.fechamento_remuneracao where competencia = v_ini;
  v_tot := v_calc->'totais'; v_fx := v_calc->'faixas';

  insert into public.fechamento_remuneracao(
    competencia, versao, status, periodo_inicio, periodo_fim,
    total_fixo, total_recuperado, total_honorario, total_comissao, total_premiacao,
    total_bonus, total_correcoes, total_desconto, total_estorno, total_final,
    valor_sem_operador, honorario_sem_operador, qtd_sem_operador,
    hash_sintetico, hash_analitico, gerado_por, fechado_por, fechado_em)
  values (v_ini, v_versao, 'FECHADO', v_ini, v_fim,
    (v_tot->>'total_fixo')::numeric, (v_tot->>'total_recuperado')::numeric, (v_tot->>'total_honorario')::numeric,
    (v_tot->>'total_comissao')::numeric, (v_tot->>'total_premiacao')::numeric, (v_tot->>'total_bonus')::numeric,
    (v_tot->>'total_correcoes')::numeric, (v_tot->>'total_desconto')::numeric, (v_tot->>'total_estorno')::numeric,
    (v_tot->>'total_final')::numeric, (v_tot->>'valor_sem_operador')::numeric,
    (v_tot->>'honorario_sem_operador')::numeric, (v_tot->>'qtd_sem_operador')::int,
    p_hash_sintetico, p_hash_analitico, v_atual, v_atual, now())
  returning id into v_id;

  -- Linhas por beneficiario
  for b in select * from jsonb_array_elements(v_calc->'beneficiarios') loop
    v_pos := v_pos + 1;
    insert into public.fechamento_remuneracao_linha(
      fechamento_id, competencia, versao, posicao, beneficiario_email, beneficiario_nome,
      tipo_vinculo, nome_exibicao_fixo, valor_fixo, qtd_pagamentos, valor_recuperado, honorarios,
      faixa, percentual, comissao, premiacoes, bonus_correcoes, descontos_estornos, total_final,
      falta_proxima_faixa, situacao, elegivel_comissao)
    values (v_id, v_ini, v_versao, v_pos, b->>'email', b->>'nome',
      b->>'tipo_vinculo', b->>'nome_exibicao_fixo', (b->>'valor_fixo')::numeric,
      (b->>'qtd_pagamentos')::int, (b->>'valor_recuperado')::numeric, (b->>'honorarios')::numeric,
      b->>'faixa', (b->>'percentual')::numeric, (b->>'comissao')::numeric, (b->>'premiacoes')::numeric,
      coalesce((b->>'bonus')::numeric,0) + coalesce((b->>'correcoes')::numeric,0),
      coalesce((b->>'descontos')::numeric,0) + coalesce((b->>'estornos')::numeric,0),
      (b->>'total_final')::numeric, (b->>'falta_proxima_faixa')::numeric, b->>'situacao',
      (b->>'elegivel_comissao')::boolean);
  end loop;

  -- Faixas congeladas
  insert into public.fechamento_remuneracao_faixa(
    fechamento_id, competencia, m1_valor, m1_percentual, m2_valor, m2_percentual,
    m3_valor, m3_percentual, m4_valor, m4_percentual, origem)
  values (v_id, v_ini, (v_fx->>'m1_valor')::numeric, (v_fx->>'m1_percentual')::numeric,
    (v_fx->>'m2_valor')::numeric, (v_fx->>'m2_percentual')::numeric,
    (v_fx->>'m3_valor')::numeric, (v_fx->>'m3_percentual')::numeric,
    (v_fx->>'m4_valor')::numeric, (v_fx->>'m4_percentual')::numeric, 'metas_projecao');

  -- Pagamentos analiticos congelados
  insert into public.fechamento_remuneracao_pagamento(
    fechamento_id, competencia, pagamento_id, data_pagamento, operador_email, operador_nome,
    aluno_mascarado, tipo_pagamento, numero_parcela, importacao_id, valor_recuperado, honorarios,
    elegivel_comissao, motivo_exclusao)
  select v_id, v_ini, pg.id, pg.data_pagamento, pg.operador_email, pg.operador_nome,
    coalesce(nullif(split_part(pg.aluno_nome,' ',1),'') || ' ***', 'ALUNO ' || right(coalesce(pg.aluno_id::text,'----'),4)),
    pg.tipo_pagamento, pg.numero_parcela_completo, pg.importacao_id, pg.valor_pago, pg.valor_honorario,
    (pg.operador_email is not null), case when pg.operador_email is null then 'Sem operador' else null end
  from public.pagamentos pg
  where pg.data_pagamento >= v_ini and pg.data_pagamento < v_prox;

  perform public.fechamento_log_acesso(true, 'fechar_competencia',
    'competencia='||to_char(v_ini,'YYYY-MM')||' versao='||v_versao);
  return v_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- REABRIR competencia (nova versao, preserva anterior)
-- ----------------------------------------------------------------------------
create or replace function public.reabrir_competencia_remuneracao(
  p_competencia date, p_motivo text
) returns void language plpgsql security definer set search_path to 'public'
as $$
declare v_ini date := date_trunc('month', p_competencia)::date;
  v_atual text := lower(coalesce((auth.jwt() ->> 'email'), current_user)); v_id uuid;
begin
  perform public.fechamento_exigir_acesso('reabrir_competencia');
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'Motivo obrigatorio para reabrir a competencia.';
  end if;
  select id into v_id from public.fechamento_remuneracao
    where competencia = v_ini and status = 'FECHADO'
    order by versao desc limit 1;
  if v_id is null then
    raise exception 'Nao ha fechamento FECHADO para reabrir nesta competencia.';
  end if;
  update public.fechamento_remuneracao
    set status = 'REABERTO', reaberto_por = v_atual, reaberto_em = now(), motivo = p_motivo
    where id = v_id;
  perform public.fechamento_log_acesso(true, 'reabrir_competencia', 'competencia='||to_char(v_ini,'YYYY-MM'));
end;
$$;

-- ----------------------------------------------------------------------------
-- CONSULTAR fechamentos (historico de versoes)
-- ----------------------------------------------------------------------------
create or replace function public.consultar_fechamentos_remuneracao(p_competencia date default null)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v jsonb;
begin
  perform public.fechamento_exigir_acesso('consultar_fechamentos');
  select coalesce(jsonb_agg(to_jsonb(f) order by f.competencia desc, f.versao desc), '[]'::jsonb) into v
  from public.fechamento_remuneracao f
  where p_competencia is null or f.competencia = date_trunc('month', p_competencia)::date;
  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants: somente authenticated (guard interno filtra Amanda)
-- ----------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'fechamento_salvar_config(date,text,text,text,text,numeric,boolean,text,numeric,boolean,text)',
    'fechamento_registrar_premiacao(date,text,text,text,text,text,text,numeric,text,text,text)',
    'fechamento_excluir_premiacao(uuid)',
    'fechamento_registrar_ajuste(date,text,text,text,text,numeric,text,text)',
    'fechamento_excluir_ajuste(uuid)',
    'fechamento_listar_lancamentos(date)',
    'fechamento_analitico_pagamentos(date)',
    'fechar_competencia_remuneracao(date,text,text)',
    'reabrir_competencia_remuneracao(date,text)',
    'consultar_fechamentos_remuneracao(date)'
  ] loop
    execute format('revoke all on function public.%s from public;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- BUCKET PRIVADO + policies Amanda-only
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('fechamento-remuneracao', 'fechamento-remuneracao', false)
on conflict (id) do update set public = false;

do $$
begin
  execute 'drop policy if exists fech_bucket_all_amanda on storage.objects';
  execute $p$create policy fech_bucket_all_amanda on storage.objects
    for all to authenticated
    using (bucket_id = 'fechamento-remuneracao' and public.usuario_pode_acessar_fechamento_remuneracao())
    with check (bucket_id = 'fechamento-remuneracao' and public.usuario_pode_acessar_fechamento_remuneracao())$p$;
end $$;
