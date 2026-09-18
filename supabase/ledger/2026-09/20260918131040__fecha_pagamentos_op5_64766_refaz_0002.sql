-- FECHAMENTO DA FRENTE DE PAGAMENTOS -- 18/09/2026 -- OPERACAO 5 -- acordo 64766
-- Autorizado pela Amanda em 18/09/2026 (mensagem explicita para 64766, com 6
-- condicoes previas). 3 pagamentos reais (0001 07/07, 0002 25/08, 0003 16/09)
-- e so 2 parcelas PAGO: a 0002 (R$ 3.256,29) esta VENCIDA embora o pagamento
-- 0002 exista. A baixa dela (rotina, 08/09) foi desfeita em 17/09 14:31.
-- ACAO: refazer a baixa da 0002 com o pagamento 0002 pelo fluxo oficial
-- (baixar_parcela_acordo, com a data e o valor do pagamento) e encerrar a
-- pendencia do 0003 pela rotina segura. Sem pagamento, parcela ou acordo novo.
-- Qualquer condicao falha: RAISE e nada fica gravado.
-- Backup: _backup_fecha_pagamentos_20260918 (op5_64766).
do $op$
declare
  c_acordo constant uuid := '121e6bde-f683-46b2-994b-0122fc999619';
  c_pag2 constant uuid := '548702cf-0674-4935-9ab6-614ecbe93225';
  c_pid3 constant uuid := 'a7be5fd5-1be9-4936-a856-20cb6663c6f4';
  v_n1 uuid; v_pag record; v_parc record; v_aluno uuid;
  v_antes jsonb; v_depois jsonb; v_r jsonb; v_e jsonb; v_saldo numeric;
begin
  select * into v_parc from public.parcelas where acordo_id = c_acordo and boleto = '50647660002';
  v_n1 := v_parc.id;
  select aluno_id into v_aluno from public.acordos where id = c_acordo and upper(status) = 'ATIVO';
  if v_n1 is null or v_aluno is null then raise exception 'OP5_ABORTADA: acordo 64766 ou parcela 0002 nao encontrados/ATIVO'; end if;
  select * into v_pag from public.pagamentos where id = c_pag2;

  -- 1. o pagamento 0002 existe e continua valido
  if v_pag.id is null or ltrim(v_pag.numero_parcela_completo,'0') <> '50647660002'
     or coalesce(v_pag.retroativo, false) then
    raise exception 'OP5_ABORTADA: pagamento 0002 ausente ou invalido';
  end if;
  -- 2. nao esta vinculado a outra parcela
  if exists (select 1 from public.parcelas where origem_baixa_ref = c_pag2::text) then
    raise exception 'OP5_ABORTADA: o pagamento 0002 ja esta referenciado por uma parcela';
  end if;
  -- 3. sem estorno, devolucao ou cancelamento posterior (a unica devolucao e a de 17/09 14:31, conhecida)
  if coalesce(v_pag.dados,'{}'::jsonb) ? 'estornado_em'
     or (select count(*) from public.baixas_pagamento where parcela_id = v_n1) <> 1
     or not exists (select 1 from public.baixas_pagamento where parcela_id = v_n1 and status_baixa = 'DEVOLVIDA'
                      and devolvido_em between '2026-09-17 14:31:00+00' and '2026-09-17 14:32:00+00')
     or exists (select 1 from public.pagamentos where ltrim(numero_parcela_completo,'0') = '50647660002' and id <> c_pag2) then
    raise exception 'OP5_ABORTADA: estorno, devolucao ou pagamento concorrente novo no 0002';
  end if;
  -- 4. valor e identidade correspondem a 0002
  if v_pag.aluno_id is distinct from v_aluno
     or v_pag.valor_pago < v_parc.valor - 0.05 or v_pag.valor_pago > v_parc.valor * 1.15
     or coalesce(v_pag.dados->>'vencimento','') <> v_parc.vencimento::text
     or not coalesce(v_parc.boleto_confiavel, false) then
    raise exception 'OP5_ABORTADA: valor, vencimento ou aluno do pagamento 0002 nao correspondem a parcela 0002';
  end if;
  -- 5. a parcela 0002 continua VENCIDA
  if upper(v_parc.status) <> 'VENCIDA' then raise exception 'OP5_ABORTADA: a 0002 nao esta mais VENCIDA (%)', v_parc.status; end if;
  -- 6. nenhuma baixa posterior substitui esse pagamento
  if exists (select 1 from public.baixas_pagamento where parcela_id = v_n1 and status_baixa <> 'DEVOLVIDA') then
    raise exception 'OP5_ABORTADA: a 0002 tem baixa ativa';
  end if;
  -- e o resto do acordo esta como lido: 0001 e 0003 PAGO, 0004..0007 A_VENCER; 3 pagamentos
  if (select count(*) from public.parcelas q where q.acordo_id = c_acordo and (q.boleto, upper(q.status)) in (
        ('50647660001','PAGO'), ('50647660003','PAGO'), ('50647660004','A_VENCER'), ('50647660005','A_VENCER'),
        ('50647660006','A_VENCER'), ('50647660007','A_VENCER'))) <> 6
     or (select count(*) from public.parcelas where acordo_id = c_acordo) <> 7
     or (select count(*) from public.pagamentos where ltrim(numero_parcela_completo,'0') like '5064766%'
           and not (coalesce(dados,'{}'::jsonb) ? 'estornado_em')) <> 3 then
    raise exception 'OP5_ABORTADA: o acordo 64766 mudou desde a ultima leitura';
  end if;
  if not exists (select 1 from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id and f.decisao is null
                  where p.id = c_pid3 and p.status_conciliacao = 'PARCELA_JA_PAGA') then
    raise exception 'OP5_ABORTADA: a pendencia do 0003 nao esta mais aberta';
  end if;

  select jsonb_build_object(
    'acordo', (select jsonb_build_object('status', status, 'saldo', saldo, 'valor_total', valor_total) from public.acordos where id = c_acordo),
    'parcelas', (select jsonb_agg(jsonb_build_object('boleto', boleto, 'status', status, 'valor', valor, 'pago_em', pago_em,
                   'confirmado_por', confirmado_por_email) order by numero) from public.parcelas where acordo_id = c_acordo),
    'pendencia_0003', (select jsonb_build_object('status', p.status_conciliacao, 'decisao', f.decisao)
                         from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id where p.id = c_pid3))
    into v_antes;

  insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
  select 'op5_64766', 'parcelas', q.id, to_jsonb(q) from public.parcelas q where q.acordo_id = c_acordo
  union all select 'op5_64766', 'acordos', a.id, to_jsonb(a) from public.acordos a where a.id = c_acordo
  union all select 'op5_64766', 'baixas_pagamento', b.id, to_jsonb(b) from public.baixas_pagamento b where b.parcela_id = v_n1
  union all select 'op5_64766', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f) from public.fila_pagamento_sem_vinculo f where f.pagamento_id = c_pid3;

  -- a baixa, pelo fluxo oficial, em nome da gestao que autorizou
  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}', true);
  v_r := public.baixar_parcela_acordo(v_n1, v_pag.data_pagamento, v_pag.valor_pago, v_pag.valor_honorario);
  perform set_config('request.jwt.claims', '', true);
  if not coalesce((v_r->>'ok')::boolean, false) then raise exception 'OP5_ABORTADA: baixar_parcela_acordo recusou: %', v_r; end if;
  update public.parcelas
     set observacao = coalesce(observacao,'') || ' | 18/09/2026: baixa refeita (baixar_parcela_acordo) com o pagamento 50647660002 de 25/08/2026 (R$ '
           || v_pag.valor_pago || '); a devolucao de 17/09 foi revista com o pagamento 0003 ja no banco. Autorizado pela Amanda; executado por migration.'
   where id = v_n1;

  select coalesce(sum(valor), 0) into v_saldo from public.parcelas
   where acordo_id = c_acordo and upper(coalesce(status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  update public.acordos set saldo = v_saldo, atualizado_em = now()
   where id = c_acordo and saldo is distinct from v_saldo;

  v_e := public.conciliacao_ja_paga_encerrar(c_pid3, true);
  if not coalesce((v_e->>'gravou')::boolean, false) then
    raise exception 'OP5_ABORTADA: a rotina segura recusou o 0003: %', v_e->'bloqueios';
  end if;

  -- VALIDACAO FINAL
  if (select count(*) from public.parcelas where acordo_id = c_acordo and upper(status) = 'PAGO') <> 3 then
    raise exception 'OP5_ABORTADA: depois nao ficaram 3 parcelas PAGO';
  end if;
  if exists (select 1 from public.parcelas q where q.acordo_id = c_acordo and upper(q.status) = 'PAGO'
               and (select count(*) from public.pagamentos g where ltrim(g.numero_parcela_completo,'0') = q.boleto
                      and not (coalesce(g.dados,'{}'::jsonb) ? 'estornado_em')) <> 1)
     or exists (select 1 from public.pagamentos g where ltrim(g.numero_parcela_completo,'0') like '5064766%'
                  and not exists (select 1 from public.parcelas q where q.acordo_id = c_acordo and upper(q.status) = 'PAGO'
                                   and q.boleto = ltrim(g.numero_parcela_completo,'0'))) then
    raise exception 'OP5_ABORTADA: pagamento e parcela PAGO nao fecham um a um';
  end if;
  if (select count(*) from public.baixas_pagamento where parcela_id = v_n1 and status_baixa = 'REALIZADA') <> 1 then
    raise exception 'OP5_ABORTADA: a 0002 nao ficou com exatamente uma baixa ativa';
  end if;
  if (select saldo from public.acordos where id = c_acordo) <> 13025.21
     or (select upper(status) from public.acordos where id = c_acordo) <> 'ATIVO' then
    raise exception 'OP5_ABORTADA: acordo ou saldo incoerente depois (saldo %)', (select saldo from public.acordos where id = c_acordo);
  end if;

  select jsonb_build_object(
    'acordo', (select jsonb_build_object('status', status, 'saldo', saldo, 'valor_total', valor_total) from public.acordos where id = c_acordo),
    'parcelas', (select jsonb_agg(jsonb_build_object('boleto', boleto, 'status', status, 'valor', valor, 'pago_em', pago_em,
                   'confirmado_por', confirmado_por_email) order by numero) from public.parcelas where acordo_id = c_acordo),
    'pendencia_0003', (select jsonb_build_object('status', p.status_conciliacao, 'decisao', f.decisao)
                         from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id where p.id = c_pid3))
    into v_depois;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'CORRECAO_BAIXA_REFEITA', 'parcelas', v_n1,
          jsonb_build_object('op', 5, 'acordo', '64766', 'autorizado_por', 'amanda.seibel@aelbra.com.br',
                             'pagamento', c_pag2, 'funcoes', jsonb_build_array('baixar_parcela_acordo', 'conciliacao_ja_paga_encerrar'),
                             'antes', v_antes, 'depois', v_depois, 'baixa', v_r));
end
$op$;
