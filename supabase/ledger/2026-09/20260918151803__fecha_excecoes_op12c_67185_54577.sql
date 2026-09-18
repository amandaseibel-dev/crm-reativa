-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- op12c_67185_54577
-- Autorizado pela Amanda em 18/09/2026: PAGAMENTO_POSTERIOR_APROPRIADO_EM_ACORDO_ANTIGO.
-- O pagamento 50671850002 renegociou/pagou o acordo antigo 54577; baixa oficial
-- (baixar_parcela_acordo) nas parcelas 50545770002 com o proprio
-- pagamento, sem acordo novo, sem parcela nova, sem pagamento novo; pendencia
-- encerrada pela gestao com o motivo. Qualquer pre-condicao falha: RAISE.
do $op$
declare
  c_pid constant uuid := '4ac49d1d-a3e1-4e82-a389-8697437766c1';
  c_alvos constant text[] := array['50545770002'];
  v_pag record; v_acordo uuid; v_aluno uuid; v_cpf_mat text; v_soma numeric; v_n int;
  v_rest numeric; v_hon_rest numeric; v_val numeric; v_hon numeric; r record; v_i int := 0; v_b jsonb; v_e jsonb; v_saldo numeric;
begin
  select * into v_pag from public.pagamentos where id = c_pid;
  if v_pag.id is null or ltrim(v_pag.numero_parcela_completo,'0') <> '50671850002' then raise exception 'OP_ABORTADA: pagamento nao encontrado'; end if;
  if coalesce(v_pag.status_conciliacao,'') <> 'AGUARDANDO_ACORDO'
     or not exists (select 1 from public.fila_pagamento_sem_vinculo where pagamento_id = c_pid and decisao is null) then
    raise exception 'OP_ABORTADA: pendencia nao esta aberta';
  end if;
  if coalesce(v_pag.dados,'{}'::jsonb) ? 'estornado_em' or coalesce(v_pag.retroativo,false) then raise exception 'OP_ABORTADA: pagamento estornado ou retroativo'; end if;
  if exists (select 1 from public.parcelas where origem_baixa_ref = c_pid::text) then raise exception 'OP_ABORTADA: pagamento ja usado em parcela'; end if;

  select id, aluno_id into v_acordo, v_aluno from public.acordos where numero_ulbra = '54577' and upper(status) = 'ATIVO';
  if v_acordo is null or (select count(*) from public.acordos where numero_ulbra = '54577') <> 1 then raise exception 'OP_ABORTADA: acordo 54577 nao unico/ATIVO'; end if;

  -- mesmo aluno e mesmo CPF: matricula do arquivo -> CPF do Prime = CPF do aluno do acordo; nome do arquivo = nome do aluno
  select min(lpad(regexp_replace(cpf,'\D','','g'),11,'0')) into v_cpf_mat from public.prime_contratos where registration = v_pag.matricula;
  if (select count(distinct lpad(regexp_replace(cpf,'\D','','g'),11,'0')) from public.prime_contratos where registration = v_pag.matricula) <> 1
     or v_cpf_mat is distinct from (select lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0') from public.alunos where id = v_aluno)
     or translate(upper(regexp_replace(trim(v_pag.aluno_nome),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
        <> (select translate(upper(regexp_replace(trim(nome),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') from public.alunos where id = v_aluno)
     or (v_pag.aluno_id is not null and v_pag.aluno_id <> v_aluno) then
    raise exception 'OP_ABORTADA: aluno/CPF do pagamento nao e o do acordo 54577';
  end if;
  -- nenhum outro acordo ativo do aluno cobrindo o mesmo debito
  if exists (select 1 from public.acordos where aluno_id = v_aluno and upper(status) = 'ATIVO' and id <> v_acordo) then
    raise exception 'OP_ABORTADA: o aluno tem outro acordo ATIVO';
  end if;
  -- parcelas alvo: existem, em aberto, sem baixa ativa, sem referencia e sem pagamento do proprio boleto
  select count(*), coalesce(sum(valor),0) into v_n, v_soma from public.parcelas
   where acordo_id = v_acordo and boleto = any(c_alvos) and upper(status) in ('VENCIDA','A_VENCER') and origem_baixa_ref is null
     and not exists (select 1 from public.baixas_pagamento b where b.parcela_id = parcelas.id and b.status_baixa = 'REALIZADA');
  if v_n <> cardinality(c_alvos) then raise exception 'OP_ABORTADA: parcelas alvo nao estao todas em aberto (% de %)', v_n, cardinality(c_alvos); end if;
  if exists (select 1 from public.pagamentos where ltrim(numero_parcela_completo,'0') = any(c_alvos)) then raise exception 'OP_ABORTADA: parcela alvo ja tem pagamento proprio'; end if;
  -- cobertura: o valor pago cobre as parcelas alvo na faixa do motor
  if v_pag.valor_pago < v_soma - 0.05 or v_pag.valor_pago > v_soma * 1.15 then
    raise exception 'OP_ABORTADA: valor pago % nao cobre as parcelas % na faixa', v_pag.valor_pago, v_soma;
  end if;
  -- mesmo vencimento do arquivo e da parcela
  if coalesce(v_pag.dados->>'vencimento','') <> '2026-08-27'
     or (select vencimento from public.parcelas where acordo_id = v_acordo and boleto = '50545770002') <> '2026-08-27'::date then
    raise exception 'OP_ABORTADA: vencimento do pagamento e da parcela nao conferem';
  end if;

  insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
  select 'op12c_67185_54577', 'parcelas', q.id, to_jsonb(q) from public.parcelas q where q.acordo_id = v_acordo
  union all select 'op12c_67185_54577', 'acordos', a.id, to_jsonb(a) from public.acordos a where a.id = v_acordo
  union all select 'op12c_67185_54577', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f) from public.fila_pagamento_sem_vinculo f where f.pagamento_id = c_pid;

  -- a baixa oficial, parcela a parcela; o valor e o honorario do pagamento sao repartidos pelo valor de cada parcela
  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}', true);
  v_rest := v_pag.valor_pago; v_hon_rest := coalesce(v_pag.valor_honorario,0);
  for r in select id, valor from public.parcelas where acordo_id = v_acordo and boleto = any(c_alvos) order by vencimento loop
    v_i := v_i + 1;
    if v_i = cardinality(c_alvos) then v_val := v_rest; v_hon := v_hon_rest;
    else v_val := round(v_pag.valor_pago * r.valor / v_soma, 2); v_hon := round(coalesce(v_pag.valor_honorario,0) * r.valor / v_soma, 2); end if;
    v_rest := v_rest - v_val; v_hon_rest := v_hon_rest - v_hon;
    v_b := public.baixar_parcela_acordo(r.id, v_pag.data_pagamento, v_val, v_hon);
    if not coalesce((v_b->>'ok')::boolean,false) then raise exception 'OP_ABORTADA: baixa recusada: %', v_b; end if;
    update public.baixas_pagamento
       set observacao_operador = 'PAGAMENTO_POSTERIOR_APROPRIADO_EM_ACORDO_ANTIGO: pagamento 50671850002 (' || c_pid::text || ') de '
             || to_char(v_pag.data_pagamento,'DD/MM/YYYY') || '; autorizado pela Amanda em 18/09/2026'
     where id = (v_b->>'baixa_id')::uuid;
    update public.parcelas
       set observacao = coalesce(observacao,'') || case when coalesce(observacao,'') = '' then '' else ' | ' end
             || 'PAGAMENTO_POSTERIOR_APROPRIADO_EM_ACORDO_ANTIGO: pago pelo boleto 50671850002 em ' || to_char(v_pag.data_pagamento,'DD/MM/YYYY')
     where id = r.id;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  -- saldo do acordo pelas parcelas vivas
  select coalesce(sum(valor),0) into v_saldo from public.parcelas where acordo_id = v_acordo and upper(coalesce(status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  update public.acordos set saldo = v_saldo, atualizado_em = now() where id = v_acordo and saldo is distinct from v_saldo;

  -- a pendencia, encerrada pela gestao com o motivo
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_e := public.conciliacao_encerrar(c_pid, 'PAGAMENTO_POSTERIOR_APROPRIADO_EM_ACORDO_ANTIGO: pagamento 50671850002 apropriado nas parcelas '
           || array_to_string(c_alvos, ', ') || ' do acordo 54577 pela baixa oficial; sem acordo, parcela ou pagamento novo. Autorizado pela Amanda.');
  perform set_config('request.jwt.claims', '', true);
  if not coalesce((v_e->>'ok')::boolean,false) then raise exception 'OP_ABORTADA: encerrar recusou: %', v_e; end if;

  -- VALIDACAO
  if (select count(*) from public.parcelas q where q.acordo_id = v_acordo and q.boleto = any(c_alvos) and upper(q.status) = 'PAGO'
        and (select count(*) from public.baixas_pagamento b where b.parcela_id = q.id and b.status_baixa = 'REALIZADA') = 1) <> cardinality(c_alvos)
     or abs((select sum(b.valor_pago) from public.baixas_pagamento b join public.parcelas q on q.id = b.parcela_id
              where q.acordo_id = v_acordo and q.boleto = any(c_alvos) and b.status_baixa = 'REALIZADA') - v_pag.valor_pago) > 0.001
     or (select count(*) from public.baixas_pagamento where observacao_operador like '%' || c_pid::text || '%') <> cardinality(c_alvos)
     or (select saldo from public.acordos where id = v_acordo) <> (select coalesce(sum(valor),0) from public.parcelas where acordo_id = v_acordo and upper(coalesce(status,'')) not in ('PAGO','CANCELADA','CANCELADO'))
     or exists (select 1 from public.fila_pagamento_sem_vinculo where pagamento_id = c_pid and decisao is null) then
    raise exception 'OP_ABORTADA: a validacao final nao fechou';
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'PAGAMENTO_POSTERIOR_APROPRIADO_EM_ACORDO_ANTIGO', 'acordos', v_acordo,
          jsonb_build_object('pagamento_id', c_pid, 'boleto', '50671850002', 'acordo', '54577', 'parcelas', to_jsonb(c_alvos),
                             'valor_pago', v_pag.valor_pago, 'soma_parcelas', v_soma, 'autorizado_por', 'amanda.seibel@aelbra.com.br',
                             'acordo_depois', (select jsonb_build_object('status', status, 'saldo', saldo) from public.acordos where id = v_acordo)));
end
$op$;
