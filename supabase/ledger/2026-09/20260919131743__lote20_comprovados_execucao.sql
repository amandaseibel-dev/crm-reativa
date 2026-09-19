-- LOTE DOS 20 "COMPROVADOS" DA CONFERENCIA PRIME (19/09/2026)
-- Dos 20 (17 PAGAMENTO_COMPROVADO + 3 ACORDO_COMPROVADO), so 6 titulos de 3
-- alunos tem prova objetiva revalidada agora; os outros 14 ficam EM_CONFIRMACAO
-- (bloqueio registrado no fechamento). Rotas oficiais, assinadas pela gestao:
--   Gustavo (3813 ATIVO, entrada paga 27/08)  -> prime_conferencia_confirmar -> vinculo -> NEGOCIADO
--   Geovanna (3103 ATIVO, parcela 0 paga 07/08) -> prime_conferencia_confirmar -> vinculo -> NEGOCIADO
--   Amanda G. (pagamento a vista 71658 AGUARDANDO_ACORDO cobre o titulo) ->
--     prime_conferencia_seguir_pagamento + conciliacao_liquidar_titulo_por_prime -> PAGO
-- Simulacoes identicas revertidas as 13:1x UTC.
do $exec$
declare
  v_sub uuid; r jsonb; v_res jsonb := '{}'::jsonb; v_antes jsonb; v_depois jsonb;
  v_gustavo uuid[] := array['23c03699-4c27-4229-bee0-a1203eb6e568','8cb4f25e-72d2-4490-a2e1-5599ec7b051c','99e37725-99db-49b8-a600-861187187fab']::uuid[];
  v_geovanna uuid[] := array['83b020c9-5351-43ac-b51f-c672c7adb876','0006d50f-011e-49d9-bd53-c230a6bf6504']::uuid[];
  v_amanda uuid := '054cccdb-330a-4644-b733-2208529812ec';
  v_pag uuid := '606170c6-3b86-4af3-b387-792546e92c3f';
  v_al_amanda uuid; t uuid;
begin
  if (select count(*) from public.prime_conferencia_decisao where titulo_id = any(v_gustavo||v_geovanna||v_amanda) and decisao='PENDENTE') <> 6 then
    raise exception 'BLOQUEIO: alguma decisao deixou de ser PENDENTE';
  end if;
  if (select count(*) from public.acordos_titulos where id = any(v_gustavo||v_geovanna||v_amanda) and situacao='EM_CONFIRMACAO' and acordo_id is null and origem_liquidacao is null) <> 6 then
    raise exception 'BLOQUEIO: algum titulo mudou de estado';
  end if;
  if exists (select 1 from public.acordo_titulo_vinculo where titulo_id = any(v_gustavo||v_geovanna||v_amanda) and coalesce(ativo,true)) then
    raise exception 'BLOQUEIO: vinculo concorrente';
  end if;
  if (select status from public.acordos where id='1f257142-763c-4a2a-8ce5-6e1a7db534c9') <> 'ATIVO' then raise exception 'BLOQUEIO: acordo 3813 nao esta ATIVO'; end if;
  if (select status from public.acordos where id='f4613bb2-4cf0-4711-9359-465472a8376a') <> 'ATIVO' then raise exception 'BLOQUEIO: acordo 3103 nao esta ATIVO'; end if;
  if (select status_conciliacao from public.pagamentos where id=v_pag) <> 'AGUARDANDO_ACORDO' then raise exception 'BLOQUEIO: pagamento de Amanda G. mudou de estado'; end if;
  select aluno_id into v_al_amanda from public.acordos_titulos where id = v_amanda;

  select id into v_sub from auth.users where lower(email) = 'amanda.seibel@aelbra.com.br';
  perform set_config('request.jwt.claims', json_build_object('email','amanda.seibel@aelbra.com.br','role','authenticated','sub',v_sub)::text, true);

  select jsonb_build_object('ac',(select count(*) from public.acordos),'parc',(select count(*) from public.parcelas),'pag',(select count(*) from public.pagamentos),
    'vinc',(select count(*) from public.acordo_titulo_vinculo),'repo',(select count(*) from public.reposicao_carteira_fila),'pendentes',(select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE'))
  into v_antes;

  foreach t in array v_gustavo loop
    r := public.prime_conferencia_confirmar(t, 'Lote comprovados 19/09: entrada do acordo 3813 paga em 27/08 (boleto 50707480001, R$ 1.505,13), acordo de R$ 8.760,82 cobre os 3 titulos (R$ 8.502,96); vinculo pela rota oficial');
    if not coalesce((r->>'ok')::boolean,false) then raise exception 'FALHOU gustavo %: %', t, r; end if;
    v_res := v_res || jsonb_build_object('gustavo_'||left(t::text,8), r);
  end loop;
  foreach t in array v_geovanna loop
    r := public.prime_conferencia_confirmar(t, 'Lote comprovados 19/09: parcela 0 do acordo 3103 paga em 07/08 (boleto 50690440001, R$ 413,76), mesmo dia da liquidacao; acordo cobre os 2 titulos; vinculo pela rota oficial');
    if not coalesce((r->>'ok')::boolean,false) then raise exception 'FALHOU geovanna %: %', t, r; end if;
    v_res := v_res || jsonb_build_object('geovanna_'||left(t::text,8), r);
  end loop;
  r := public.prime_conferencia_seguir_pagamento(v_amanda, v_pag, 'Lote comprovados 19/09: pagamento Santander de R$ 1.462,54 em 11/09 (base R$ 1.354,20) do acordo a vista 71658, mesmo aluno, cobre o titulo de R$ 1.298,44; liquidado na Prime no mesmo dia');
  if not coalesce((r->>'ok')::boolean,false) then raise exception 'FALHOU seguir: %', r; end if;
  r := public.conciliacao_liquidar_titulo_por_prime(v_pag, '[{"boleto":"4521350","pago_em":"2026-09-11","portador":195}]'::jsonb, true);
  if coalesce((r->>'liquidados')::int,0) <> 1 then raise exception 'FALHOU liquidar: %', r; end if;
  v_res := v_res || jsonb_build_object('amanda_liquidar', r);
  perform public.recalcular_situacao_aluno(v_al_amanda, 'lote20_comprovados');

  select jsonb_build_object('ac',(select count(*) from public.acordos),'parc',(select count(*) from public.parcelas),'pag',(select count(*) from public.pagamentos),
    'vinc',(select count(*) from public.acordo_titulo_vinculo),'repo',(select count(*) from public.reposicao_carteira_fila),'pendentes',(select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE'),
    'titulos',(select jsonb_object_agg(documento, situacao||'/'||status||'/'||coalesce(origem_liquidacao,'-')||'/vinc='||(select count(*) from public.acordo_titulo_vinculo v where v.titulo_id=x.id and coalesce(v.ativo,true))) from public.acordos_titulos x where x.id = any(v_gustavo||v_geovanna||v_amanda)),
    'alunos',(select jsonb_object_agg(left(a.id::text,8), a.situacao_operacional||'/'||coalesce(a.responsavel_atual_email,'-')) from public.alunos a where a.id in (select aluno_id from public.acordos_titulos where id = any(v_gustavo||v_geovanna||v_amanda))),
    'pagamento',(select status_conciliacao from public.pagamentos where id=v_pag),
    'vinc_duplo',(select count(*) from (select titulo_id from public.acordo_titulo_vinculo where coalesce(ativo,true) group by 1 having count(*)>1) z))
  into v_depois;

  if (v_depois->>'ac')::int <> (v_antes->>'ac')::int or (v_depois->>'parc')::int <> (v_antes->>'parc')::int or (v_depois->>'pag')::int <> (v_antes->>'pag')::int then
    raise exception 'TRAVA: acordo/parcela/pagamento criado';
  end if;
  if (v_depois->>'vinc')::int - (v_antes->>'vinc')::int <> 5 then raise exception 'TRAVA: vinculos criados <> 5'; end if;
  if (v_depois->>'vinc_duplo')::int <> 0 then raise exception 'TRAVA: titulo em dois acordos'; end if;
  if (v_depois->>'pendentes')::int <> (v_antes->>'pendentes')::int - 6 then raise exception 'TRAVA: pendentes nao caiu 6'; end if;
  if (v_depois->>'repo')::int - (v_antes->>'repo')::int > 1 then raise exception 'TRAVA: reposicao alem da quitacao de Amanda G.'; end if;
  if (select count(*) from public.acordos_titulos where id = any(v_gustavo||v_geovanna) and situacao='NEGOCIADO') <> 5 then raise exception 'TRAVA: NEGOCIADO <> 5'; end if;
  if (select situacao||'/'||coalesce(origem_liquidacao,'') from public.acordos_titulos where id=v_amanda) <> 'PAGO/PRIME_LIQUIDACAO_OFICIAL' then raise exception 'TRAVA: Amanda G. nao ficou PAGO oficial'; end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'LOTE20_COMPROVADOS_CONFERENCIA_PRIME', 'acordos_titulos',
          jsonb_build_object('antes', v_antes, 'depois', v_depois, 'resultados', v_res,
            'bloqueados_14', 'Jussara 3 (acordo 1921 R$ 586 nao cobre R$ 2.182, sem pagamento no dia); Alexandre 1 (acordo 2962 QUITADO sem pagamento baixado); Kelly 1 (acordo 3399 criado apos a liquidacao, pagamento do dia e de outro acordo Prime); Andrea 5 (acordo 2486 QUITADO sem pagamento baixado; boletos pagos sao de outros acordos Prime); Yuri 3 (A2 inconclusivo, pagamentos de outros acordos Prime); Ivone 1 (pagamento R$ 345 base nao cobre titulo R$ 540,50)'));
  raise notice 'OK %', v_depois;
end
$exec$;
