do $op$
declare
  c_acordo constant uuid := '95b4cccb-818b-46e0-b78f-807747bca683';
  c_pid constant uuid := '6969d1b8-40bc-4cec-af7d-51b72e9ad250';
  v_pag record; v_ac record; v_aluno_antes jsonb; v_aluno_depois jsonb; v_e jsonb; v_parcela uuid; v_n int;
begin
  select * into v_ac from public.acordos where id = c_acordo;
  select * into v_pag from public.pagamentos where id = c_pid;
  if upper(coalesce(v_ac.status,'')) <> 'QUITADO' or v_ac.qtd_parcelas <> 11 or v_ac.valor_total <> 3635.68 or v_ac.numero_ulbra <> '63428' then
    raise exception 'OP15_ABORTADA: o acordo 63428 mudou';
  end if;
  if (select count(*) from public.parcelas where acordo_id = c_acordo) <> 11
     or (select count(*) from public.parcelas q join public.pagamentos g on g.id::text = q.origem_baixa_ref
          where q.acordo_id = c_acordo and upper(q.status) = 'PAGO' and ltrim(g.numero_parcela_completo,'0') = q.boleto
            and g.status_conciliacao = 'BAIXADO') <> 11
     or (select count(distinct origem_baixa_ref) from public.parcelas where acordo_id = c_acordo) <> 11
     or (select sum(valor) from public.parcelas where acordo_id = c_acordo) <> 3635.68 then
    raise exception 'OP15_ABORTADA: as 11 parcelas nao estao mais pagas uma a uma pelos proprios boletos';
  end if;
  if exists (select 1 from public.baixas_pagamento where acordo_id = c_acordo) then raise exception 'OP15_ABORTADA: apareceu baixa manual no acordo'; end if;
  if v_pag.id is null or ltrim(v_pag.numero_parcela_completo,'0') <> '50634280001' or v_pag.valor_pago <> 908.92
     or v_pag.status_conciliacao <> 'REVISAO' or coalesce(v_pag.dados,'{}'::jsonb) ? 'estornado_em' or coalesce(v_pag.retroativo,false)
     or not exists (select 1 from public.fila_pagamento_sem_vinculo where pagamento_id = c_pid and decisao is null) then
    raise exception 'OP15_ABORTADA: o pagamento de R$ 908,92 nao esta mais pendente como lido';
  end if;
  if exists (select 1 from public.parcelas where boleto = '50634280001')
     or exists (select 1 from public.parcelas where origem_baixa_ref = c_pid::text)
     or exists (select 1 from public.parcelas where acordo_id = c_acordo and (is_entrada or numero = 1)) then
    raise exception 'OP15_ABORTADA: ja existe entrada ou parcela ligada ao pagamento';
  end if;
  if v_pag.aluno_id is distinct from v_ac.aluno_id
     or (select min(lpad(regexp_replace(cpf,'\D','','g'),11,'0')) from public.prime_contratos where registration = v_pag.matricula)
        is distinct from (select lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0') from public.alunos where id = v_ac.aluno_id) then
    raise exception 'OP15_ABORTADA: aluno/CPF do pagamento nao e o do acordo';
  end if;

  select jsonb_build_object('status_atual', status_atual, 'status_jornada', status_jornada, 'status_acionamento', status_acionamento,
                            'responsavel', responsavel_atual_email, 'situacao_operacional', situacao_operacional)
    into v_aluno_antes from public.alunos where id = v_ac.aluno_id;

  insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
  select 'op15_63428', 'acordos', a.id, to_jsonb(a) from public.acordos a where a.id = c_acordo
  union all select 'op15_63428', 'pagamentos', p.id, to_jsonb(p) from public.pagamentos p where p.id = c_pid
  union all select 'op15_63428', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f) from public.fila_pagamento_sem_vinculo f where f.pagamento_id = c_pid
  union all select 'op15_63428', 'alunos', al.id, to_jsonb(al) from public.alunos al where al.id = v_ac.aluno_id;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_e := public.conciliacao_encerrar(c_pid, 'ENTRADA_HISTORICA_REGISTRADA: entrada de R$ 908,92 do acordo 63428 (QUITADO) registrada ja paga pelo proprio pagamento; as 11 parcelas intocadas. Autorizado pela Amanda.');
  perform set_config('request.jwt.claims', '', true);
  if not coalesce((v_e->>'ok')::boolean,false) then raise exception 'OP15_ABORTADA: encerrar recusou: %', v_e; end if;

  insert into public.parcelas (acordo_id, numero, valor, honorarios, vencimento, status, is_entrada, boleto, boleto_confiavel,
                               pago_em, confirmado_por_email, origem_baixa, origem_baixa_ref, origem_baixa_em, observacao, criado_em, atualizado_em)
  values (c_acordo, 1, 908.92, v_pag.valor_honorario, coalesce((v_pag.dados->>'vencimento')::date, v_pag.data_pagamento), 'PAGO', true, '50634280001', true,
          v_pag.data_pagamento::timestamptz, coalesce(v_pag.operador_email, 'extrato_santander'),
          'ADM', c_pid::text, now(),
          'ENTRADA_HISTORICA_REGISTRADA 18/09/2026: entrada do acordo 63428 paga em ' || to_char(v_pag.data_pagamento,'DD/MM/YYYY')
            || ' (boleto 50634280001, R$ 908,92); o relatorio trouxe so as 11 parcelas em aberto. Autorizado pela Amanda.',
          now(), now())
  returning id into v_parcela;

  update public.acordos set qtd_parcelas = 12, valor_total = 4544.60, valor_entrada = 908.92, entrada_paga = true,
         data_entrada = v_pag.data_pagamento, atualizado_em = now()
   where id = c_acordo and qtd_parcelas = 11 and valor_total = 3635.68;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'OP15_ABORTADA: o acordo mudou durante a gravacao'; end if;

  update public.pagamentos
     set status_conciliacao = 'BAIXADO', conciliacao_em = now(),
         conciliacao_motivo = 'entrada historica do acordo 63428 registrada ja paga por este pagamento (18/09/2026, autorizado pela Amanda)'
   where id = c_pid;

  select jsonb_build_object('status_atual', status_atual, 'status_jornada', status_jornada, 'status_acionamento', status_acionamento,
                            'responsavel', responsavel_atual_email, 'situacao_operacional', situacao_operacional)
    into v_aluno_depois from public.alunos where id = v_ac.aluno_id;
  if v_aluno_depois is distinct from v_aluno_antes then
    raise exception 'OP15_ABORTADA: o estado do aluno mudou (% -> %)', v_aluno_antes, v_aluno_depois;
  end if;
  if (select count(*) from public.parcelas where acordo_id = c_acordo and upper(status) = 'PAGO') <> 12
     or (select sum(valor) from public.parcelas where acordo_id = c_acordo) <> 4544.60
     or (select count(*) from public.parcelas q join public.pagamentos g on g.id::text = q.origem_baixa_ref
          where q.acordo_id = c_acordo and ltrim(g.numero_parcela_completo,'0') = q.boleto and g.status_conciliacao = 'BAIXADO') <> 12
     or (select count(distinct boleto) from public.parcelas where acordo_id = c_acordo) <> 12
     or (select count(*) from public.pagamentos where ltrim(numero_parcela_completo,'0') like '5063428%') <> 12
     or (select upper(status) from public.acordos where id = c_acordo) <> 'QUITADO'
     or coalesce((select saldo from public.acordos where id = c_acordo), 0) <> 0
     or exists (select 1 from public.fila_pagamento_sem_vinculo where pagamento_id = c_pid and decisao is null) then
    raise exception 'OP15_ABORTADA: a validacao final nao fechou';
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'ENTRADA_HISTORICA_REGISTRADA', 'parcelas', v_parcela,
          jsonb_build_object('op', 15, 'acordo', '63428', 'pagamento_id', c_pid, 'valor', 908.92,
                             'acordo_antes', jsonb_build_object('qtd', 11, 'total', 3635.68, 'status', 'QUITADO'),
                             'acordo_depois', jsonb_build_object('qtd', 12, 'total', 4544.60, 'status', 'QUITADO', 'saldo', 0),
                             'aluno_intocado', v_aluno_depois, 'autorizado_por', 'amanda.seibel@aelbra.com.br'));
end
$op$;