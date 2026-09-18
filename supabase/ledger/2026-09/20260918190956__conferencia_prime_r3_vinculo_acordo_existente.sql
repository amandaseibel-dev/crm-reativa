-- CONFERENCIA PRIME -- R3: 10 titulos vinculados ao acordo que ja existe, pela funcao oficial prime_conferencia_vincular.
-- Autorizado pela gestao em 18/09/2026. Nenhum pagamento, baixa, parcela ou acordo novo.
-- 4609/4618/4606/4616 (QUITADO, parcelas ja baixadas): solicitacao encerrada ENCERRADO_VIA_ACORDO ANTES do vinculo
-- (senao a quitacao do aluno a fecharia como PAGAMENTO_CONFIRMADO); titulos terminam PAGO.
-- 4611 (ATIVO): titulos terminam NEGOCIADO; a solicitacao de R$ 4.293,62 (dd6975e0) fica ABERTA.
do $r3$
declare
  c_map constant jsonb := '{
    "0b9e39f5-50d0-4737-a9c7-922398bd63b8": 4609, "d6c67fbc-8c71-41a0-8a8d-3bbd0ae05156": 4618,
    "d8241e78-2608-4fa6-aa3f-d76b3fec0634": 4606, "6b6be8bb-955b-4f03-b0a2-171c3a1abb86": 4606,
    "d779c6be-7096-4456-860e-58c2fe528125": 4616,
    "ab76486f-9eac-4bca-bf4e-a970287a6986": 4611, "35c430b1-16cb-4c5d-8e6f-78c7f9e44271": 4611,
    "72ec33a7-ed22-48ca-8a5d-b0aa25e7733e": 4611, "5f459d78-6184-4a4f-b8fb-f0be5c0450c9": 4611,
    "cb636492-7750-4e46-8e77-98f1fb6bdbfa": 4611}'::jsonb;
  c_sol constant jsonb := '{
    "aa31928c-ade3-4c24-b615-108181ca5094": 4609, "75286ba8-7853-47e2-a8a4-7f4f0ec5afa1": 4618,
    "12ddb607-360e-4864-ba9b-358ffc3de2e0": 4606, "8a8b458d-9f2e-4609-8866-30ae9119defd": 4616}'::jsonb;
  c_sol_aberta constant uuid := 'dd6975e0-2333-46e9-b00d-4dd448c61ac9';
  v_md5 text; v_tits uuid[]; v_n int; k text; v_res jsonb;
  v_a0 bigint; v_p0 bigint; v_pp0 bigint; v_g0 bigint; v_b0 bigint; v_v0 bigint; v_valor numeric;
begin
  -- 0. funcoes oficiais intactas e reposicao pausada
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any(array['_talvez_quitar_aluno','_titulo_em_confirmacao_protegido','_titulo_situacao_e_status_coerentes','_trg_auto_quitar_titulo','aluno_saldo_pendente_detalhe','assumir_caso_livre','caso_aguarda_confirmacao_financeira','caso_protegido_redistribuicao','casos_encerrar_zerados_sem_debito','casos_reavaliar_encerramento','contar_carteira_ativa','nivelar_medias_progressivo','prime_conferencia_baixar','prime_conferencia_confirmar','prime_conferencia_detectar_grupo_a','prime_conferencia_fila','prime_conferencia_rejeitar','prime_conferencia_rejeitar_lote','prime_conferencia_vincular','prime_grupo_a_candidatos','recalcular_situacao_aluno','reforcar_teto_operadores','titulo_liquidado_na_origem_e_terminal']);
  if v_md5 is distinct from 'd9e15cb291b2aa3c05f3a0f0f335f732' then
    raise exception 'R3_PRE: funcoes do grupo A mudaram (%)', v_md5;
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'vincular_titulos_acordo') <> 'd857ce1e53b4f5aea87ee49f7e92406f' then
    raise exception 'R3_PRE: vincular_titulos_acordo mudou';
  end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then
    raise exception 'R3_PRE: reposicao de carteira nao esta pausada';
  end if;

  select array_agg(k2::uuid) into v_tits from jsonb_object_keys(c_map) k2;

  -- 1. travas de entrada: titulo EM_CONFIRMACAO, decisao PENDENTE A2_COBRE apontando o acordo autorizado,
  --    mesmo aluno do acordo, sem acordo/vinculo concorrente, acordo no estado esperado
  select count(*) into v_n
    from public.acordos_titulos t
    join public.prime_conferencia_decisao d on d.titulo_id = t.id
    join public.acordos a on a.id = d.acordo_id
   where t.id = any(v_tits)
     and t.situacao = 'EM_CONFIRMACAO' and t.status = 'em_confirmacao'
     and t.acordo_id is null and t.origem_liquidacao is null
     and d.decisao = 'PENDENTE' and d.subgrupo = 'A2_COBRE'
     and a.numero_acordo = (c_map ->> t.id::text)::bigint
     and a.aluno_id = t.aluno_id
     and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true))
     and ((a.numero_acordo = 4611 and a.status = 'ATIVO')
          or (a.numero_acordo <> 4611 and a.status = 'QUITADO'
              and not exists (select 1 from public.parcelas p where p.acordo_id = a.id and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'))));
  if v_n <> 10 then
    raise exception 'R3_PRE: so % de 10 titulos no estado autorizado', v_n;
  end if;
  select count(*) into v_n from public.solicitacoes_confirmacao_pagamento s
   where (s.id::text in (select jsonb_object_keys(c_sol)) or s.id = c_sol_aberta) and s.status = 'AGUARDANDO_CONFIRMACAO';
  if v_n <> 5 then
    raise exception 'R3_PRE: so % de 5 solicitacoes aguardando', v_n;
  end if;

  select count(*) into v_a0 from public.acordos;
  select count(*) into v_p0 from public.parcelas;
  select count(*) filter (where status = 'PAGO') into v_pp0 from public.parcelas;
  select count(*) into v_g0 from public.pagamentos;
  select count(*) into v_b0 from public.baixas_pagamento;
  select count(*) into v_v0 from public.acordo_titulo_vinculo where coalesce(ativo, true);
  select sum(valor) into v_valor from public.prime_conferencia_decisao where titulo_id = any(v_tits);

  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","sub":"52b292e4-e43e-4200-a684-b63d889d273a","role":"authenticated"}', true);

  -- 2. solicitacoes dos 4 acordos quitados: ENCERRADO_VIA_ACORDO, com o registro de que o dinheiro ja estava nas parcelas
  for k in select jsonb_object_keys(c_sol) loop
    update public.solicitacoes_confirmacao_pagamento
       set status = 'ENCERRADO_VIA_ACORDO', atualizado_em = now(),
           observacao_adm = 'Conferencia Prime R3 (gestao, 18/09/2026): encerrado via acordo ' || (c_sol ->> k)
             || '. O dinheiro ja estava refletido nas parcelas do acordo (pagamento ja baixado); os titulos foram vinculados'
             || ' ao acordo existente. Nenhum pagamento, baixa, parcela ou acordo novo.'
     where id = k::uuid and status = 'AGUARDANDO_CONFIRMACAO';
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'R3: solicitacao % nao encerrou', k; end if;
  end loop;

  -- 3. vinculo pela funcao oficial (A2_COBRE usa o acordo da propria decisao)
  for k in select jsonb_object_keys(c_map) loop
    v_res := public.prime_conferencia_vincular(k::uuid, null,
      'Conferencia Prime R3 autorizado pela gestao em 18/09/2026: titulo vinculado ao acordo existente ' || (c_map ->> k) || '.');
    if coalesce(v_res ->> 'decisao', '') <> 'VINCULADO' or coalesce(v_res ->> 'acordo_numero', '') <> (c_map ->> k) then
      raise exception 'R3: vinculo do titulo % falhou (%)', k, v_res;
    end if;
  end loop;

  -- 4. travas de saida
  select count(*) into v_n
    from public.acordos_titulos t join public.acordos a on a.id = t.acordo_id
    join public.prime_conferencia_decisao d on d.titulo_id = t.id
   where t.id = any(v_tits) and a.numero_acordo = (c_map ->> t.id::text)::bigint
     and t.origem_liquidacao is null and d.decisao = 'VINCULADO'
     and ((a.numero_acordo = 4611 and a.status = 'ATIVO' and t.situacao = 'NEGOCIADO' and t.status = 'vinculada')
          or (a.numero_acordo <> 4611 and a.status = 'QUITADO' and t.situacao = 'PAGO' and t.status = 'quitada'))
     and (select count(*) from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true)) = 1;
  if v_n <> 10 then raise exception 'R3_POS: so % de 10 titulos no estado final', v_n; end if;
  if (select count(*) from public.acordos) <> v_a0 then raise exception 'R3_POS: acordo novo'; end if;
  if (select count(*) from public.parcelas) <> v_p0 then raise exception 'R3_POS: parcela nova'; end if;
  if (select count(*) filter (where status = 'PAGO') from public.parcelas) <> v_pp0 then raise exception 'R3_POS: baixa nova de parcela'; end if;
  if (select count(*) from public.pagamentos) <> v_g0 then raise exception 'R3_POS: pagamento novo'; end if;
  if (select count(*) from public.baixas_pagamento) <> v_b0 then raise exception 'R3_POS: baixa nova'; end if;
  if (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) <> v_v0 + 10 then raise exception 'R3_POS: vinculos != +10'; end if;
  if (select status from public.solicitacoes_confirmacao_pagamento where id = c_sol_aberta) <> 'AGUARDANDO_CONFIRMACAO' then
    raise exception 'R3_POS: a solicitacao do 4611 nao podia fechar';
  end if;
  if (select count(*) from public.solicitacoes_confirmacao_pagamento where id::text in (select jsonb_object_keys(c_sol)) and status = 'ENCERRADO_VIA_ACORDO') <> 4 then
    raise exception 'R3_POS: solicitacoes dos acordos quitados nao ficaram ENCERRADO_VIA_ACORDO';
  end if;
  if exists (select 1 from public.acordo_titulo_vinculo where coalesce(ativo, true) group by titulo_id having count(*) > 1) then
    raise exception 'R3_POS: titulo com dois vinculos ativos';
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_R3_VINCULO_ACORDO_EXISTENTE', 'prime_conferencia_decisao', null,
          jsonb_build_object('titulo_para_acordo', c_map, 'solicitacao_encerrada_via_acordo', c_sol,
                             'solicitacao_mantida_aberta', c_sol_aberta, 'titulos', 10, 'valor', v_valor,
                             'regra', 'vinculo pela funcao oficial; dinheiro ja refletido nas parcelas; zero pagamento/baixa/parcela/acordo novo'));
end;
$r3$;
