-- FECHAMENTO DA FRENTE DE PAGAMENTOS -- 18/09/2026 -- OPERACAO 4 -- acordo 62866
-- Autorizado pela Amanda em 18/09/2026 (mensagem explicita para 62866).
-- DIVERGENCIA: 4 parcelas PAGO para 3 pagamentos (0002 17/07, 0003 19/08,
-- 0004 17/09). A 0005 (R$ 10.047,91, venc. 19/10/2026) esta PAGO sem pagamento
-- proprio: a baixa legada "pelo documento 50628660003" reusou o dinheiro do
-- 0003, que ja esta na 0003 (baixa da gestao em 19/08).
-- ACAO: desfazer SO a baixa da 0005 pela funcao oficial desfazer_baixa_parcela;
-- encerrar a pendencia do 0004 pela rotina segura conciliacao_ja_paga_encerrar.
-- Qualquer pre-condicao falha: RAISE e nada fica gravado.
-- Backup: _backup_fecha_pagamentos_20260918 (op4_62866).
do $op$
declare
  c_acordo constant uuid := 'b72e3285-2d01-4503-b072-c8c39fc60c4c';
  c_n3 constant uuid := 'b2dcace9-cc3e-41b1-8a96-11aeebc9a575';
  c_n1 constant uuid := '0a413553-adc0-40ba-b45f-f8c52987f220';
  c_pid constant uuid := '53c60601-50b8-4674-bb24-f54433e54855';
  v_antes jsonb; v_depois jsonb; v_r jsonb; v_e jsonb; v_saldo numeric; v_n int;
begin
  -- 1. NADA MUDOU DESDE A ULTIMA LEITURA: as 6 parcelas exatamente como lidas
  select count(*) into v_n from public.parcelas q where q.acordo_id = c_acordo and (q.boleto, upper(q.status)) in (
    ('50628660002','PAGO'), ('50628660003','PAGO'), ('50628660004','PAGO'), ('50628660005','PAGO'),
    ('50628660006','A_VENCER'), ('50628660007','A_VENCER'));
  if v_n <> 6 or (select count(*) from public.parcelas where acordo_id = c_acordo) <> 6 then
    raise exception 'OP4_ABORTADA: as parcelas do 62866 mudaram desde a ultima leitura (% de 6 conferem)', v_n;
  end if;
  if (select upper(status) from public.acordos where id = c_acordo) <> 'ATIVO' then
    raise exception 'OP4_ABORTADA: o acordo 62866 nao esta ATIVO';
  end if;
  -- 0005 PAGO, sem referencia de pagamento, marcada pela baixa legada do 0003
  if not exists (select 1 from public.parcelas where id = c_n3 and acordo_id = c_acordo and upper(status) = 'PAGO'
                   and boleto = '50628660005' and origem_baixa_ref is null
                   and observacao like '%pelo documento 50628660003%') then
    raise exception 'OP4_ABORTADA: a parcela 0005 nao esta como lida';
  end if;
  if exists (select 1 from public.baixas_pagamento where parcela_id = c_n3) then
    raise exception 'OP4_ABORTADA: a 0005 ganhou baixa registrada';
  end if;
  -- nao existe pagamento da 0005
  if exists (select 1 from public.pagamentos where ltrim(coalesce(numero_parcela_completo,''),'0') = '50628660005') then
    raise exception 'OP4_ABORTADA: apareceu pagamento do boleto 0005';
  end if;
  -- o dinheiro do 0003 esta apropriado na 0003
  if not exists (select 1 from public.pagamentos where ltrim(numero_parcela_completo,'0') = '50628660003'
                   and data_pagamento = '2026-08-19' and valor_pago = 10047.91 and not (coalesce(dados,'{}'::jsonb) ? 'estornado_em'))
     or not exists (select 1 from public.baixas_pagamento where parcela_id = c_n1 and status_baixa = 'REALIZADA'
                      and valor_pago = 10047.91 and data_pagamento = '2026-08-19')
     or (select upper(status) from public.parcelas where id = c_n1) <> 'PAGO' then
    raise exception 'OP4_ABORTADA: o dinheiro do 0003 nao esta na 0003 como lido';
  end if;
  -- 3 pagamentos, nenhum estornado
  if (select count(*) from public.pagamentos where ltrim(numero_parcela_completo,'0') like '5062866%'
        and not (coalesce(dados,'{}'::jsonb) ? 'estornado_em')) <> 3 then
    raise exception 'OP4_ABORTADA: o acordo 62866 nao tem exatamente 3 pagamentos validos';
  end if;
  -- a pendencia do 0004 continua aberta
  if not exists (select 1 from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id and f.decisao is null
                  where p.id = c_pid and p.status_conciliacao = 'PARCELA_JA_PAGA') then
    raise exception 'OP4_ABORTADA: a pendencia do 0004 nao esta mais aberta';
  end if;

  select jsonb_build_object(
    'acordo', (select jsonb_build_object('status', status, 'saldo', saldo, 'valor_total', valor_total) from public.acordos where id = c_acordo),
    'parcelas', (select jsonb_agg(jsonb_build_object('boleto', boleto, 'status', status, 'valor', valor, 'pago_em', pago_em,
                   'confirmado_por', confirmado_por_email) order by numero) from public.parcelas where acordo_id = c_acordo),
    'pendencia_0004', (select jsonb_build_object('status', p.status_conciliacao, 'decisao', f.decisao)
                         from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id where p.id = c_pid))
    into v_antes;

  insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
  select 'op4_62866', 'parcelas', q.id, to_jsonb(q) from public.parcelas q where q.acordo_id = c_acordo
  union all select 'op4_62866', 'acordos', a.id, to_jsonb(a) from public.acordos a where a.id = c_acordo
  union all select 'op4_62866', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f) from public.fila_pagamento_sem_vinculo f where f.pagamento_id = c_pid;

  -- 2. desfazer SO a 0005, pela funcao oficial (sem JWT: backend)
  perform set_config('request.jwt.claims', '', true);
  v_r := public.desfazer_baixa_parcela(c_n3);
  if not coalesce((v_r->>'ok')::boolean, false) or coalesce((v_r->>'acordo_reaberto')::boolean, true) then
    raise exception 'OP4_ABORTADA: desfazer_baixa_parcela nao saiu como esperado: %', v_r;
  end if;
  update public.parcelas
     set observacao = coalesce(observacao,'') || ' | 18/09/2026: baixa desfeita (desfazer_baixa_parcela) -- o dinheiro do documento 50628660003 ja estava na parcela 0003 (baixa da gestao em 19/08); a 0005 nao tem pagamento. Autorizado pela Amanda.'
   where id = c_n3;

  -- saldo do acordo: parcelas que nao estao PAGO nem canceladas
  select coalesce(sum(valor), 0) into v_saldo from public.parcelas
   where acordo_id = c_acordo and upper(coalesce(status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  update public.acordos set saldo = v_saldo, atualizado_em = now()
   where id = c_acordo and saldo is distinct from v_saldo;

  -- 4. a pendencia do 0004 pela rotina segura (revalida as 8 evidencias)
  v_e := public.conciliacao_ja_paga_encerrar(c_pid, true);
  if not coalesce((v_e->>'gravou')::boolean, false) then
    raise exception 'OP4_ABORTADA: a rotina segura recusou o 0004: %', v_e->'bloqueios';
  end if;

  -- 5. VALIDACAO FINAL
  if (select count(*) from public.parcelas where acordo_id = c_acordo and upper(status) = 'PAGO') <> 3 then
    raise exception 'OP4_ABORTADA: depois nao ficaram 3 parcelas PAGO';
  end if;
  if exists (select 1 from public.parcelas q where q.acordo_id = c_acordo and upper(q.status) = 'PAGO'
               and (select count(*) from public.pagamentos g where ltrim(g.numero_parcela_completo,'0') = q.boleto
                      and not (coalesce(g.dados,'{}'::jsonb) ? 'estornado_em')) <> 1)
     or exists (select 1 from public.pagamentos g where ltrim(g.numero_parcela_completo,'0') like '5062866%'
                  and not exists (select 1 from public.parcelas q where q.acordo_id = c_acordo and upper(q.status) = 'PAGO'
                                   and q.boleto = ltrim(g.numero_parcela_completo,'0'))) then
    raise exception 'OP4_ABORTADA: pagamento e parcela PAGO nao fecham um a um';
  end if;
  if (select upper(status) from public.parcelas where id = c_n3) <> 'A_VENCER'
     or (select pago_em from public.parcelas where id = c_n3) is not null then
    raise exception 'OP4_ABORTADA: a 0005 nao voltou a A_VENCER';
  end if;
  if (select saldo from public.acordos where id = c_acordo) <> 30143.74
     or (select upper(status) from public.acordos where id = c_acordo) <> 'ATIVO' then
    raise exception 'OP4_ABORTADA: acordo ou saldo incoerente depois (saldo %)', (select saldo from public.acordos where id = c_acordo);
  end if;

  select jsonb_build_object(
    'acordo', (select jsonb_build_object('status', status, 'saldo', saldo, 'valor_total', valor_total) from public.acordos where id = c_acordo),
    'parcelas', (select jsonb_agg(jsonb_build_object('boleto', boleto, 'status', status, 'valor', valor, 'pago_em', pago_em,
                   'confirmado_por', confirmado_por_email) order by numero) from public.parcelas where acordo_id = c_acordo),
    'pendencia_0004', (select jsonb_build_object('status', p.status_conciliacao, 'decisao', f.decisao)
                         from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id where p.id = c_pid))
    into v_depois;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'CORRECAO_BAIXA_SEM_PAGAMENTO', 'parcelas', c_n3,
          jsonb_build_object('op', 4, 'acordo', '62866', 'autorizado_por', 'amanda.seibel@aelbra.com.br',
                             'funcoes', jsonb_build_array('desfazer_baixa_parcela', 'conciliacao_ja_paga_encerrar'),
                             'antes', v_antes, 'depois', v_depois, 'desfazer', v_r));
end
$op$;
