-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- OPERACAO 8 -- acordo 62684
-- Autorizado pela Amanda em 18/09/2026. O pagamento 0001 (R$ 1.430,40 em 14/08)
-- foi a ENTRADA do acordo; a baixa manual de 02/09 usou esse dinheiro para
-- marcar as parcelas 0002-0006 como pagas. Estado verdadeiro:
--   0001 entrada PAGO pelo pagamento de 14/08
--   0002 PAGO pelo pagamento de 18/09 (motor)
--   0003-0007 em aberto -> saldo R$ 1.192,00
-- Funcoes oficiais: desfazer_baixa_parcela (a baixa de 02/09 fica no historico
-- como DEVOLVIDA, com o motivo), baixar_parcela_acordo (entrada) e
-- pagamento_conciliar_um (0002). A entrada nasce como a reconstrucao da
-- parcela paga antes da extracao faz: parcela + quantidade e total do acordo.
-- O boleto 0001 estava preso a parcela CANCELADA do acordo manual cancelado
-- (inferido, nao confiavel) e e liberado para a entrada.
-- Resultado diferente do esperado: RAISE e nada fica gravado.
do $op$
declare
  c_acordo constant uuid := 'cec1f5ae-c6fb-43c7-a4cd-614fbd614b77';
  c_cancelado constant uuid := '40bae635-5d97-41b7-b15e-476b63196cac';
  c_pag1 constant uuid := 'd09ce29c-b5b5-47a2-b827-470fc2024d1d';
  c_pag2 constant uuid := 'fa89ce9b-ecb1-4bde-84dc-f7890d6ba3e2';
  v_n2 uuid; v_parc_cancel uuid; v_entrada uuid; v_baixa uuid; r record;
  v_antes jsonb; v_depois jsonb; v_b jsonb; v_m jsonb; v_saldo numeric;
begin
  -- PRE-CONDICOES
  if (select upper(status) from public.acordos where id = c_acordo) <> 'ATIVO'
     or (select qtd_parcelas from public.acordos where id = c_acordo) <> 6
     or (select valor_total from public.acordos where id = c_acordo) <> 1430.39 then
    raise exception 'OP8_ABORTADA: o acordo 62684 mudou';
  end if;
  if (select count(*) from public.parcelas q where q.acordo_id = c_acordo and (q.boleto, upper(q.status)) in (
        ('50626840002','PAGO'), ('50626840003','PAGO'), ('50626840004','PAGO'), ('50626840005','PAGO'),
        ('50626840006','PAGO'), ('50626840007','A_VENCER'))) <> 6
     or (select count(*) from public.parcelas where acordo_id = c_acordo) <> 6 then
    raise exception 'OP8_ABORTADA: as parcelas do 62684 mudaram';
  end if;
  select id into v_n2 from public.parcelas where acordo_id = c_acordo and boleto = '50626840002';
  select id into v_baixa from public.baixas_pagamento
   where acordo_id = c_acordo and status_baixa = 'REALIZADA' and valor_pago = 1430.40 and data_pagamento = '2026-08-14'
     and baixado_por_email = 'amanda.seibel@aelbra.com.br';
  if v_baixa is null or (select count(*) from public.baixas_pagamento where acordo_id = c_acordo) <> 1 then
    raise exception 'OP8_ABORTADA: a baixa manual de 02/09 nao esta como lida';
  end if;
  if not exists (select 1 from public.pagamentos where id = c_pag1 and ltrim(numero_parcela_completo,'0') = '50626840001'
                   and valor_pago = 1430.40 and data_pagamento = '2026-08-14' and not (coalesce(dados,'{}'::jsonb) ? 'estornado_em'))
     or not exists (select 1 from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id and f.decisao is null
                     where p.id = c_pag2 and p.status_conciliacao = 'PARCELA_JA_PAGA' and p.valor_pago = 243.24)
     or (select count(*) from public.pagamentos where ltrim(numero_parcela_completo,'0') like '5062684%') <> 2 then
    raise exception 'OP8_ABORTADA: os pagamentos 0001/0002 nao estao como lidos';
  end if;
  select q.id into v_parc_cancel from public.parcelas q
   where q.acordo_id = c_cancelado and q.boleto = '50626840001' and upper(q.status) = 'CANCELADA' and not coalesce(q.boleto_confiavel, false)
     and (select upper(status) from public.acordos where id = c_cancelado) = 'CANCELADO';
  if v_parc_cancel is null or (select count(*) from public.parcelas where boleto = '50626840001') <> 1 then
    raise exception 'OP8_ABORTADA: o boleto 0001 nao esta so na parcela cancelada';
  end if;

  select jsonb_build_object(
    'acordo', (select jsonb_build_object('status', status, 'saldo', saldo, 'valor_total', valor_total, 'qtd', qtd_parcelas) from public.acordos where id = c_acordo),
    'parcelas', (select jsonb_agg(jsonb_build_object('boleto', boleto, 'status', status, 'valor', valor, 'venc', vencimento, 'pago_em', pago_em) order by numero) from public.parcelas where acordo_id = c_acordo),
    'baixa_0202', (select to_jsonb(b) from public.baixas_pagamento b where b.id = v_baixa))
    into v_antes;

  insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
  select 'op8_62684', 'parcelas', q.id, to_jsonb(q) from public.parcelas q where q.acordo_id in (c_acordo, c_cancelado)
  union all select 'op8_62684', 'acordos', a.id, to_jsonb(a) from public.acordos a where a.id = c_acordo
  union all select 'op8_62684', 'baixas_pagamento', b.id, to_jsonb(b) from public.baixas_pagamento b where b.acordo_id = c_acordo
  union all select 'op8_62684', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f) from public.fila_pagamento_sem_vinculo f where f.pagamento_id = c_pag2;

  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}', true);

  -- 1. desfaz a baixa de 02/09 nas 0002-0006 (a linha da baixa fica, DEVOLVIDA)
  for r in select id from public.parcelas where acordo_id = c_acordo
             and boleto in ('50626840002','50626840003','50626840004','50626840005','50626840006') loop
    perform public.desfazer_baixa_parcela(r.id);
  end loop;
  update public.baixas_pagamento
     set motivo_devolucao = coalesce(motivo_devolucao,'') || ' | 18/09/2026: o valor de 14/08 (R$ 1.430,40) foi a ENTRADA do acordo 62684, nao pagamento das parcelas 0002-0006; reapropriado a entrada. Autorizado pela Amanda.'
   where id = v_baixa;

  -- 2. o boleto 0001 sai da parcela cancelada (inferido) e vai para a entrada
  update public.parcelas
     set boleto = null,
         observacao = coalesce(observacao,'') || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || '18/09/2026: boleto 50626840001 liberado -- e a entrada do acordo 62684 importado, paga em 14/08.'
   where id = v_parc_cancel;

  -- 3. a entrada, como a reconstrucao faz: parcela + quantidade e total do acordo
  insert into public.parcelas (acordo_id, numero, valor, vencimento, status, is_entrada, boleto, boleto_confiavel, observacao, criado_em, atualizado_em)
  values (c_acordo, 1, 1430.40, '2026-08-14', 'A_VENCER', true, '50626840001', true,
          'ENTRADA do acordo 62684 paga em 14/08/2026 (pagamento 50626840001, R$ 1.430,40); o relatorio so trouxe as parcelas em aberto. Recriada em 18/09/2026, autorizado pela Amanda.',
          now(), now())
  returning id into v_entrada;
  update public.acordos set qtd_parcelas = 7, valor_total = 2860.79, atualizado_em = now()
   where id = c_acordo and qtd_parcelas = 6 and valor_total = 1430.39;

  -- 4. a baixa da entrada, pelo fluxo oficial, com a data e o valor do pagamento
  v_b := public.baixar_parcela_acordo(v_entrada, '2026-08-14', 1430.40,
                                      (select valor_honorario from public.pagamentos where id = c_pag1));
  if not coalesce((v_b->>'ok')::boolean, false) then raise exception 'OP8_ABORTADA: baixa da entrada recusada: %', v_b; end if;
  perform set_config('request.jwt.claims', '', true);

  -- 5. a 0002 pelo proprio pagamento de 18/09, pelo motor
  v_m := public.pagamento_conciliar_um(c_pag2, true);
  if (select status_conciliacao from public.pagamentos where id = c_pag2) <> 'BAIXADO'
     or (select origem_baixa_ref from public.parcelas where id = v_n2) is distinct from c_pag2::text then
    raise exception 'OP8_ABORTADA: o motor nao baixou a 0002 com o pagamento de 18/09: %', v_m;
  end if;

  -- 6. saldo e VALIDACAO FINAL -- tem de fechar exatamente
  select coalesce(sum(valor), 0) into v_saldo from public.parcelas
   where acordo_id = c_acordo and upper(coalesce(status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  update public.acordos set saldo = v_saldo, atualizado_em = now() where id = c_acordo and saldo is distinct from v_saldo;

  if v_saldo <> 1192.00
     or (select upper(status) from public.acordos where id = c_acordo) <> 'ATIVO'
     or (select count(*) from public.parcelas q where q.acordo_id = c_acordo and upper(q.status) = 'PAGO') <> 2
     or (select count(*) from public.parcelas q where q.acordo_id = c_acordo and upper(q.status) = 'PAGO'
           and q.boleto in ('50626840001','50626840002')) <> 2
     or (select count(*) from public.parcelas q where q.acordo_id = c_acordo and upper(q.status) in ('A_VENCER','VENCIDA')
           and q.boleto in ('50626840003','50626840004','50626840005','50626840006','50626840007')) <> 5
     or exists (select 1 from public.pagamentos g where ltrim(g.numero_parcela_completo,'0') like '5062684%'
                  and not exists (select 1 from public.parcelas q where q.acordo_id = c_acordo and upper(q.status) = 'PAGO'
                                   and q.boleto = ltrim(g.numero_parcela_completo,'0')))
     or exists (select 1 from public.baixas_pagamento where acordo_id = c_acordo and status_baixa = 'REALIZADA'
                  group by parcela_id having count(*) > 1)
     or exists (select 1 from public.fila_pagamento_sem_vinculo where pagamento_id = c_pag2 and decisao is null) then
    raise exception 'OP8_ABORTADA: o resultado nao fechou (saldo %)', v_saldo;
  end if;

  select jsonb_build_object(
    'acordo', (select jsonb_build_object('status', status, 'saldo', saldo, 'valor_total', valor_total, 'qtd', qtd_parcelas) from public.acordos where id = c_acordo),
    'parcelas', (select jsonb_agg(jsonb_build_object('boleto', boleto, 'status', status, 'valor', valor, 'venc', vencimento, 'pago_em', pago_em) order by numero) from public.parcelas where acordo_id = c_acordo))
    into v_depois;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'ENTRADA_REAPROPRIADA', 'acordos', c_acordo,
          jsonb_build_object('op', 8, 'acordo', '62684', 'autorizado_por', 'amanda.seibel@aelbra.com.br',
                             'motivo', 'pagamento 0001 de 14/08 (R$ 1.430,40) era a entrada; a baixa manual de 02/09 o usou nas parcelas 0002-0006',
                             'funcoes', jsonb_build_array('desfazer_baixa_parcela', 'baixar_parcela_acordo', 'pagamento_conciliar_um'),
                             'antes', v_antes, 'depois', v_depois, 'baixa_entrada', v_b, 'motor_0002', v_m));
end
$op$;
