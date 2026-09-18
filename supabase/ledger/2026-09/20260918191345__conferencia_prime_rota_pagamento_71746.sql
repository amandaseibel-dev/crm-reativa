-- CONFERENCIA PRIME -- rota financeira do pagamento 71746 (R4), autorizada pela gestao em 18/09/2026.
-- Uma transacao por pagamento: rejeitar o titulo na Conferencia (ROTA_FINANCEIRA_PAGAMENTO) -> margem excepcional
-- (funcao oficial, pagamento a pagamento) -> acordo a vista registrado pelo pagamento (funcao oficial). Qualquer falha
-- desfaz tudo: o titulo nunca fica ABERTO fora desta transacao.
do $rota$
declare
  c_bol   constant text   := '71746';
  c_pag   constant uuid   := 'ffa1e627-eefc-44a7-830b-13e70d5d9756';
  c_tits  constant uuid[] := array['56f6f837-cdcc-4026-afe2-45e9f4b582c1','07c635fc-9fd8-4dd3-bf36-e346482f527e']::uuid[];
  c_sol   constant uuid   := '02e822f9-9799-46cc-b815-bf28a86e4952';
  c_mot   constant text   := 'ROTA_FINANCEIRA_PAGAMENTO: Conferencia Prime, gestao 18/09/2026. O titulo segue pela rota do pagamento '
                             || '71746 (acordo a vista registrado pelo pagamento na mesma transacao).';
  v_md5 text; v_pag record; v_n int; t uuid; v_res jsonb; v_acordo uuid; v_proibido uuid;
  v_a0 bigint; v_p0 bigint; v_pp0 bigint; v_g0 bigint; v_b0 bigint; v_v0 bigint; v_valor numeric;
begin
  -- 0. funcoes oficiais intactas e reposicao pausada
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any(array['_talvez_quitar_aluno','_titulo_em_confirmacao_protegido','_titulo_situacao_e_status_coerentes','_trg_auto_quitar_titulo','aluno_saldo_pendente_detalhe','assumir_caso_livre','caso_aguarda_confirmacao_financeira','caso_protegido_redistribuicao','casos_encerrar_zerados_sem_debito','casos_reavaliar_encerramento','contar_carteira_ativa','nivelar_medias_progressivo','prime_conferencia_baixar','prime_conferencia_confirmar','prime_conferencia_detectar_grupo_a','prime_conferencia_fila','prime_conferencia_rejeitar','prime_conferencia_rejeitar_lote','prime_conferencia_vincular','prime_grupo_a_candidatos','recalcular_situacao_aluno','reforcar_teto_operadores','titulo_liquidado_na_origem_e_terminal']);
  if v_md5 is distinct from 'd9e15cb291b2aa3c05f3a0f0f335f732' then
    raise exception 'ROTA_PRE %: funcoes do grupo A mudaram (%)', c_bol, v_md5;
  end if;
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace
     and proname = any(array['acordo_avista_previa','acordo_avista_registrar','pagamento_autorizar_margem_excepcional','vincular_titulos_acordo','pagamento_conciliar_um']);
  if v_md5 is distinct from '098bd5fcc110691d07fbab430acec0a3' then
    raise exception 'ROTA_PRE %: funcoes da rota mudaram (%)', c_bol, v_md5;
  end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then
    raise exception 'ROTA_PRE %: reposicao de carteira nao esta pausada', c_bol;
  end if;

  -- 1. travas de entrada
  select p.* into v_pag from public.pagamentos p where p.id = c_pag;
  if v_pag.id is null then raise exception 'ROTA_PRE %: pagamento nao existe', c_bol; end if;
  if ltrim(coalesce(v_pag.numero_parcela_completo, ''), '0') <> '5' || lpad(c_bol, 6, '0') || '0001' then
    raise exception 'ROTA_PRE %: boleto do pagamento nao confere', c_bol;
  end if;
  if coalesce(v_pag.status_conciliacao, '') <> 'AGUARDANDO_ACORDO'
     or not exists (select 1 from public.fila_pagamento_sem_vinculo f where f.pagamento_id = c_pag and f.decisao is null) then
    raise exception 'ROTA_PRE %: pagamento nao esta pendente de acordo', c_bol;
  end if;
  if exists (select 1 from public.parcelas p where p.origem_baixa_ref = c_pag::text)
     or exists (select 1 from public.pagamento_margem_autorizada m where m.pagamento_id = c_pag) then
    raise exception 'ROTA_PRE %: pagamento ja utilizado', c_bol;
  end if;
  if exists (select 1 from public.acordos a where ltrim(coalesce(a.numero_ulbra, ''), '0') = c_bol) then
    raise exception 'ROTA_PRE %: ja existe acordo com esse numero', c_bol;
  end if;
  select count(*) into v_n
    from public.acordos_titulos t
    join public.prime_conferencia_decisao d on d.titulo_id = t.id
    join public.alunos al on al.id = t.aluno_id
   where t.id = any(c_tits)
     and t.situacao = 'EM_CONFIRMACAO' and t.status = 'em_confirmacao'
     and t.acordo_id is null and t.origem_liquidacao is null
     and d.decisao = 'PENDENTE'
     and t.aluno_id = v_pag.aluno_id
     and lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0') = lpad(regexp_replace(coalesce(v_pag.cpf, ''), '\D', '', 'g'), 11, '0')
     and coalesce((d.evidencia ->> 'cpf_confere')::boolean, false)
     and (d.evidencia ->> 'liquidado_em')::date = v_pag.data_pagamento
     and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true));
  if v_n <> cardinality(c_tits) then
    raise exception 'ROTA_PRE %: so % de % titulos no estado autorizado', c_bol, v_n, cardinality(c_tits);
  end if;
  select count(*) into v_n from public.solicitacoes_confirmacao_pagamento s
   where s.aluno_id = v_pag.aluno_id::text and s.status = 'AGUARDANDO_CONFIRMACAO';
  if v_n <> 1 or not exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                              where s.id = c_sol and s.aluno_id = v_pag.aluno_id::text and s.status = 'AGUARDANDO_CONFIRMACAO'
                                and round(s.valor_informado, 2) = round(v_pag.valor_pago, 2)) then
    raise exception 'ROTA_PRE %: solicitacao financeira fora do esperado', c_bol;
  end if;

  select count(*) into v_a0 from public.acordos;
  select count(*) into v_p0 from public.parcelas;
  select count(*) filter (where status = 'PAGO') into v_pp0 from public.parcelas;
  select count(*) into v_g0 from public.pagamentos;
  select count(*) into v_b0 from public.baixas_pagamento;
  select count(*) into v_v0 from public.acordo_titulo_vinculo where coalesce(ativo, true);
  select sum(valor) into v_valor from public.prime_conferencia_decisao where titulo_id = any(c_tits);
  select a.id into v_proibido from public.acordos a where a.numero_acordo = -1;

  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","sub":"52b292e4-e43e-4200-a684-b63d889d273a","role":"authenticated"}', true);

  -- 2. rejeitar na Conferencia, com o motivo da rota
  foreach t in array c_tits loop
    v_res := public.prime_conferencia_rejeitar(t, c_mot);
    if coalesce(v_res ->> 'decisao', '') <> 'REJEITADO' then
      raise exception 'ROTA %: rejeicao do titulo % falhou (%)', c_bol, t, v_res;
    end if;
  end loop;

  -- 3. margem excepcional, pagamento a pagamento (funcao oficial; so passa se a margem for o unico bloqueio)
  v_res := public.pagamento_autorizar_margem_excepcional(c_pag,
    'Autorizado pela Amanda em 18/09/2026 (classe A/B): base entre o valor das mensalidades e o corrigido do Prime. '
    || 'Conferencia Prime, rota financeira do pagamento.');
  if not coalesce((v_res ->> 'ok')::boolean, false) or coalesce((v_res ->> 'ja_autorizado')::boolean, false) then
    raise exception 'ROTA %: margem nao autorizada (%)', c_bol, v_res;
  end if;
  if not exists (select 1 from public.pagamento_margem_autorizada m
                  where m.pagamento_id = c_pag
                    and (select array_agg(x order by x) from unnest(m.titulo_ids) x) = (select array_agg(y order by y) from unnest(c_tits) y)) then
    raise exception 'ROTA %: margem autorizada para outro conjunto de titulos', c_bol;
  end if;

  -- 4. acordo a vista registrado pelo pagamento
  v_res := public.acordo_avista_registrar(c_pag, c_tits, true);
  if not coalesce((v_res ->> 'ok')::boolean, false) or coalesce(v_res ->> 'modo', '') <> 'CONFIRMADO' then
    raise exception 'ROTA %: registro recusado (%)', c_bol, coalesce(v_res -> 'bloqueios', v_res);
  end if;
  v_acordo := (v_res ->> 'acordo_id')::uuid;

  -- 5. travas de saida
  if (select status_conciliacao from public.pagamentos where id = c_pag) <> 'BAIXADO' then
    raise exception 'ROTA_POS %: pagamento nao ficou BAIXADO', c_bol;
  end if;
  if not exists (select 1 from public.acordos a where a.id = v_acordo and a.status = 'QUITADO'
                    and ltrim(coalesce(a.numero_ulbra, ''), '0') = c_bol and a.aluno_id = v_pag.aluno_id)
     or v_acordo is not distinct from v_proibido then
    raise exception 'ROTA_POS %: acordo errado', c_bol;
  end if;
  if (select count(*) from public.parcelas p where p.acordo_id = v_acordo) <> 1
     or (select count(*) from public.parcelas p where p.acordo_id = v_acordo and p.status = 'PAGO' and p.origem_baixa_ref = c_pag::text) <> 1
     or (select count(*) from public.parcelas p where p.origem_baixa_ref = c_pag::text) <> 1 then
    raise exception 'ROTA_POS %: parcela fora do esperado', c_bol;
  end if;
  select count(*) into v_n
    from public.acordos_titulos t join public.prime_conferencia_decisao d on d.titulo_id = t.id
   where t.id = any(c_tits) and t.situacao = 'PAGO' and t.status = 'quitada' and t.acordo_id = v_acordo
     and t.origem_liquidacao is null
     and d.decisao = 'REJEITADO' and d.motivo like 'ROTA_FINANCEIRA_PAGAMENTO%'
     and (select count(*) from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true)) = 1
     and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and v.acordo_id = v_proibido and coalesce(v.ativo, true));
  if v_n <> cardinality(c_tits) then
    raise exception 'ROTA_POS %: so % de % titulos no estado final', c_bol, v_n, cardinality(c_tits);
  end if;
  if (select status from public.solicitacoes_confirmacao_pagamento where id = c_sol) <> 'PAGAMENTO_CONFIRMADO' then
    raise exception 'ROTA_POS %: solicitacao nao foi confirmada', c_bol;
  end if;
  if (select count(*) from public.acordos) <> v_a0 + 1 then raise exception 'ROTA_POS %: acordos != +1', c_bol; end if;
  if (select count(*) from public.parcelas) <> v_p0 + 1 then raise exception 'ROTA_POS %: parcelas != +1', c_bol; end if;
  if (select count(*) filter (where status = 'PAGO') from public.parcelas) <> v_pp0 + 1 then raise exception 'ROTA_POS %: baixas de parcela != +1', c_bol; end if;
  if (select count(*) from public.pagamentos) <> v_g0 then raise exception 'ROTA_POS %: pagamento novo', c_bol; end if;
  if (select count(*) from public.baixas_pagamento) <> v_b0 then raise exception 'ROTA_POS %: baixa registrada a mais', c_bol; end if;
  if (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) <> v_v0 + cardinality(c_tits) then
    raise exception 'ROTA_POS %: vinculos fora do esperado', c_bol;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_ROTA_FINANCEIRA_PAGAMENTO', 'pagamentos', c_pag,
          jsonb_build_object('boleto', c_bol, 'grupo', 'R4', 'pagamento_id', c_pag, 'acordo_id', v_acordo,
                             'titulo_ids', to_jsonb(c_tits), 'valor_titulos', v_valor, 'valor_pago', v_pag.valor_pago,
                             'solicitacao_confirmada', c_sol,
                             'sequencia', 'rejeitar (ROTA_FINANCEIRA_PAGAMENTO) -> margem excepcional -> acordo a vista pelo pagamento, numa transacao'));
end;
$rota$;
