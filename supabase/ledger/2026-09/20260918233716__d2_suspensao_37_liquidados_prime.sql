-- D2: SUSPENSAO SEGURA DOS 37 TITULOS "OUTRA DIVIDA" LIQUIDADOS NA PRIME
-- Autorizacao da gestao em 18/09/2026: os 18 alunos do recorte D2 tem 37 outros
-- titulos ABERTO no CRM que a Prime mostra liquidados, sem pagamento ReATIVA,
-- sem acordo, sem vinculo e sem portador 166. Saem da cobranca (EM_CONFIRMACAO,
-- decisao PENDENTE, motivo PRIME_LIQUIDADO_ORIGEM_NAO_COMPROVADA). Nada e
-- baixado, nada vira PAGO/NEGOCIADO, nada e criado. Reposicao segue pausada.
do $d2$
declare
  v_simular boolean := false;
  v_ids uuid[] := array['9c2be492-7a44-4743-8122-9d5bb412558c','3a0ce06c-f55c-4464-8fe6-53ee8bf2ac65','f2337130-a75c-42fa-b955-1a913d4df424','e3ae2ff2-ef53-41de-885a-8d50e4aed299','6eeea536-c392-445c-b6b1-1fd92853c84f','d1fbbd32-08d6-4bba-ac4a-b98cbcccf055','ba730604-a873-47eb-95b4-7cd5e0b79789','2a121cdc-02c0-4ccb-9cb4-48e181af36fe','f69ef452-5b9e-4e0d-b894-7cd519b40e1b','047bf63d-ccd5-40d6-ab4d-42136aa4195e','2dbbac32-49ec-4f02-a365-6a339daae705','e7dd9349-44c0-42a0-ab3f-25fd6ec665ca','2788b812-2703-4f8b-9007-16a82a4d9d19','abc4050d-69e2-4e9b-b718-29809a2ebc97','00cdbc8f-60e6-4c05-a1c4-8d3d1aa4ed49','8a990725-b38b-45b5-bc20-89331e7e305b','715fb8fb-e410-43bd-ada2-6770504acfdb','cc9ae29f-5108-4604-bc53-7e7026958c04','f6392da7-b08c-40c7-a211-7f0ee8d66398','cd4d16d0-8f9d-4e69-a096-92ba836d4d4c','63208e61-99a3-450a-b407-96ce349b796e','c62e9a3e-1bd6-408b-a250-6648407c1b1d','706fe72b-6198-474f-bc59-c67b5eaecdb5','70cc1063-3b57-4f00-b5a8-50b6f67f7610','0d398f0a-be7a-4746-9794-0a7423bf9c45','abd09a9a-254e-42e7-a4f7-7fc407aaa13e','f41eb254-248b-494a-aace-b3c82ab8b854','e8e4955b-380d-4db1-a29b-f280e58bbe6b','9a54e9c0-1728-462c-be7e-047872678b68','94444204-faa2-42a2-87fb-9672686ac4c2','cecc8879-2af4-48cd-9d42-cc124a2cc938','26abdc91-ec79-41ef-8648-b4eddb699407','ca3c06db-3cb5-42ae-ae06-e86add163468','77ce2c01-8390-4551-b197-a2b0bfe45ea8','3ede5778-8ff4-4eb0-b3c1-904948dd738c','7fa7c4e8-eca4-4e78-98a2-833ec2161fa2','784e5b95-52ef-4f85-a4ef-a32c550ff803']::uuid[];
  v_antes jsonb; v_depois jsonb; v_res jsonb; v_n int; v_mudaram jsonb;
  v_cnt_antes jsonb; v_cnt_depois jsonb;
begin
  perform 1 from public.acordos_titulos where id = any(v_ids) for update;

  -- REVALIDACAO, linha a linha, dentro da transacao
  create temp table _d2 on commit drop as
  select t.id, t.aluno_id, t.documento, t.vencimento, t.created_at::date imp, t.situacao, t.status,
         round(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0),2) v,
         lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0') cpf11, t.cpf cpf_titulo,
         e.liquidado_em, e.portador, e.valor_bruto, e.valor_pago,
         (lpad(regexp_replace(coalesce(e.cpf,''),'\D','','g'),11,'0') = lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0')) cpf_ok,
         (e.liquidado_em is not null and e.liquidado_em > t.vencimento + 30 and e.liquidado_em >= t.created_at::date) liq_real,
         case
           when upper(coalesce(t.situacao,'')) <> 'ABERTO' or coalesce(t.status,'') <> 'em_aberto' then 'NAO_ESTA_ABERTO'
           when t.acordo_id is not null or t.origem_liquidacao is not null then 'TEM_MARCA_DE_ACORDO_OU_ORIGEM'
           when e.liquidado_em is null or e.portador <> 195 then 'NAO_LIQUIDADO_NO_195'
           when exists (select 1 from public.pagamentos p where p.aluno_id = t.aluno_id
                          or lpad(regexp_replace(coalesce(p.cpf,''),'\D','','g'),11,'0') = lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0')) then 'SURGIU_PAGAMENTO'
           when exists (select 1 from public.acordos ac where ac.aluno_id = t.aluno_id) then 'SURGIU_ACORDO'
           when exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo,true)) then 'SURGIU_VINCULO'
           when exists (select 1 from public.prime_conferencia_decisao d where d.titulo_id = t.id) then 'JA_TEM_DECISAO'
           else 'OK' end motivo_bloqueio,
         (select k.operador_email from public.casos k where k.aluno_id = t.aluno_id and not coalesce(k.encerrado_operacional,false)
           order by k.caso_atualizado_em desc nulls last limit 1) operador
    from public.acordos_titulos t
    join public.alunos a on a.id = t.aluno_id
    left join lateral (select * from public.prime_extrato e where ltrim(e.boleto,'0') = ltrim(coalesce(t.documento,''),'0')
                        order by e.coletado_em desc limit 1) e on true
   where t.id = any(v_ids);

  select coalesce(jsonb_agg(jsonb_build_object('titulo', id, 'doc', documento, 'porque', motivo_bloqueio)), '[]'::jsonb)
    into v_mudaram from _d2 where motivo_bloqueio <> 'OK';

  -- FOTO DE ANTES: alunos, casos, contagens que NAO podem mudar
  select jsonb_object_agg(a.id, jsonb_build_object('sit', a.situacao_operacional, 'resp', a.responsavel_atual_email,
           'op', k.operador_email, 'enc', coalesce(k.encerrado_operacional,false), 'quit', k.quitado_em))
    into v_antes
    from public.alunos a
    left join lateral (select * from public.casos k where k.aluno_id = a.id order by k.caso_atualizado_em desc nulls last limit 1) k on true
   where a.id in (select aluno_id from _d2);
  select jsonb_build_object('pag', (select count(*) from public.pagamentos), 'ac', (select count(*) from public.acordos),
           'parc', (select count(*) from public.parcelas), 'vinc', (select count(*) from public.acordo_titulo_vinculo),
           'repo', (select count(*) from public.reposicao_carteira_fila), 'pago', (select count(*) from public.acordos_titulos where upper(situacao)='PAGO'),
           'neg', (select count(*) from public.acordos_titulos where upper(situacao)='NEGOCIADO'))
    into v_cnt_antes;

  -- A SUSPENSAO: mesmo caminho da deteccao do grupo A (porta oficial do gatilho)
  perform set_config('conferencia_prime.decisao', 'on', true);

  insert into public.prime_conferencia_decisao
    (titulo_id, decisao, motivo, decidido_por, decidido_em, motivo_entrada, aluno_id, cpf, documento, valor,
     evidencia, evidencia_chave, corroboracao, subgrupo, acordo_id, acordo_numero, revisao_obrigatoria,
     operador_no_momento, detectado_em, situacao_anterior, status_anterior)
  select d.id, 'PENDENTE', null, null, null, 'PRIME_LIQUIDADO_ORIGEM_NAO_COMPROVADA', d.aluno_id, d.cpf_titulo, d.documento, d.v,
         jsonb_build_object(
           'regra', 'D2 18/09/2026: outra divida do aluno liquidada na Prime sem pagamento ReATIVA, sem acordo, sem vinculo, sem portador 166; suspensao autorizada pela gestao, origem a investigar',
           'classificacao', 'PRIME_ORIGEM_NAO_COMPROVADA', 'nivel_evidencia', 'NENHUMA',
           'origem', 'D2_OUTRA_DIVIDA_LIQUIDADA',
           'documento', d.documento, 'vencimento', d.vencimento, 'importado_em', d.imp,
           'liquidado_em', d.liquidado_em, 'portador', d.portador, 'valor_bruto', d.valor_bruto, 'valor_pago', d.valor_pago,
           'cpf_confere', d.cpf_ok, 'liquidacao_real', d.liq_real,
           'pagamento_reativa', false, 'acordo_crm', false, 'vinculo', false, 'portador_166', false,
           'aviso', 'valor_pago da Prime e divida corrigida, nao caixa'),
         md5(concat_ws('|', d.documento, d.liquidado_em, d.portador, d.valor_bruto, d.valor_pago)),
         'NENHUMA', null, null, null, true, d.operador, now(), d.situacao, d.status
    from _d2 d where d.motivo_bloqueio = 'OK';

  update public.acordos_titulos t
     set situacao = 'EM_CONFIRMACAO', atualizado_em = now()
    from _d2 d where t.id = d.id and d.motivo_bloqueio = 'OK';
  get diagnostics v_n = row_count;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  select d.aluno_id::text, 'TITULO_EM_CONFIRMACAO_PRIME',
         'Titulo ' || coalesce(d.documento,'?') || ' (venc. ' || to_char(d.vencimento,'DD/MM/YYYY')
           || ') saiu da cobranca: a Prime mostra liquidado em ' || to_char(d.liquidado_em,'DD/MM/YYYY')
           || ' e a origem nao esta comprovada (sem pagamento ReATIVA, sem acordo). Nada foi baixado; o valor foi mantido.',
         coalesce(d.situacao,'(sem)'), 'EM_CONFIRMACAO', 'Sistema', 'amanda.seibel@aelbra.com.br', now(), d.v
    from _d2 d where d.motivo_bloqueio = 'OK';

  perform public.recalcular_situacao_aluno(x.aluno_id, 'd2_suspensao_prime')
    from (select distinct aluno_id from _d2 where motivo_bloqueio = 'OK') x;

  perform set_config('conferencia_prime.decisao', 'off', true);

  -- FOTO DE DEPOIS + TRAVAS
  select jsonb_object_agg(a.id, jsonb_build_object('sit', a.situacao_operacional, 'resp', a.responsavel_atual_email,
           'op', k.operador_email, 'enc', coalesce(k.encerrado_operacional,false), 'quit', k.quitado_em))
    into v_depois
    from public.alunos a
    left join lateral (select * from public.casos k where k.aluno_id = a.id order by k.caso_atualizado_em desc nulls last limit 1) k on true
   where a.id in (select aluno_id from _d2);
  select jsonb_build_object('pag', (select count(*) from public.pagamentos), 'ac', (select count(*) from public.acordos),
           'parc', (select count(*) from public.parcelas), 'vinc', (select count(*) from public.acordo_titulo_vinculo),
           'repo', (select count(*) from public.reposicao_carteira_fila), 'pago', (select count(*) from public.acordos_titulos where upper(situacao)='PAGO'),
           'neg', (select count(*) from public.acordos_titulos where upper(situacao)='NEGOCIADO'))
    into v_cnt_depois;

  if v_cnt_antes <> v_cnt_depois then
    raise exception 'TRAVA: contagens mudaram antes % depois %', v_cnt_antes, v_cnt_depois;
  end if;
  if exists (select 1 from jsonb_each(v_antes) a join jsonb_each(v_depois) d on d.key = a.key
              where a.value->>'resp' is distinct from d.value->>'resp' or a.value->>'op' is distinct from d.value->>'op'
                 or (a.value->>'enc')::boolean <> (d.value->>'enc')::boolean or a.value->>'quit' is distinct from d.value->>'quit') then
    raise exception 'TRAVA: responsavel/caso mudou: antes % depois %', v_antes, v_depois;
  end if;
  if exists (select 1 from jsonb_each(v_depois) where value->>'sit' = 'QUITADO') then
    raise exception 'TRAVA: aluno virou QUITADO';
  end if;

  select jsonb_build_object(
    'simulacao', v_simular, 'suspensos', v_n, 'valor_suspenso', (select sum(v) from _d2 where motivo_bloqueio='OK'),
    'mudaram_antes', v_mudaram,
    'liquidacao_dentro_de_30_dias_ou_antes_importacao', (select count(*) from _d2 where motivo_bloqueio='OK' and not liq_real),
    'alunos', (select count(distinct aluno_id) from _d2 where motivo_bloqueio='OK'),
    'alunos_aguardando_confirmacao', (select count(*) from jsonb_each(v_depois) where value->>'sit' = 'AGUARDANDO_CONFIRMACAO'),
    'alunos_seguem_em_cobranca', (select count(*) from jsonb_each(v_depois) where value->>'sit' <> 'AGUARDANDO_CONFIRMACAO'),
    'responsaveis_preservados', (select count(*) from jsonb_each(v_depois) where value->>'resp' is not null),
    'casos_preservados', (select count(*) from jsonb_each(v_depois) where not (value->>'enc')::boolean),
    'redistribuicoes', 0, 'reposicao_enfileirada', (v_cnt_depois->>'repo')::int - (v_cnt_antes->>'repo')::int,
    'situacoes_depois', (select jsonb_object_agg(key, value->>'sit') from jsonb_each(v_depois)),
    'contagens', v_cnt_depois)
    into v_res;

  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'D2_SUSPENSAO_37_LIQUIDADOS_PRIME', 'acordos_titulos', v_res);

  if v_simular then
    raise exception 'SIMULACAO_OK %', v_res;
  end if;
  raise notice 'RESULTADO %', v_res;
end
$d2$;
