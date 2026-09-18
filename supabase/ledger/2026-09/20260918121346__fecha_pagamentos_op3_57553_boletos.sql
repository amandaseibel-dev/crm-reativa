-- FECHAMENTO DA FRENTE DE PAGAMENTOS -- 18/09/2026 -- OPERACAO 3 -- acordo 57553
-- AMARRA ERRADA, DINHEIRO CERTO. As 4 parcelas (boleto_confiavel = false) tem os
-- boletos em rodizio: 16/07 -> 0005, 16/08 -> 0002, 16/09 -> 0003, 16/10 -> 0004.
-- O arquivo do pagamento 0004 traz vencimento 16/09 (variavel independente), e
-- os pagamentos 0002 (30/07) e 0003 (17/08) seguem a mesma sequencia mensal.
-- Em valor, o acordo ja esta certo: 3 pagamentos, 3 parcelas PAGO (16/07,
-- 16/08, 16/09) e a de 16/10 em aberto.
-- CORRECAO: so o rotulo do boleto de cada parcela, pela sequencia
-- (0002..0005). Status, valores, datas e baixas ficam intocados. Depois o
-- motor reavalia o 0004 (acha a parcela de 16/09 ja paga) e a rotina segura
-- encerra a pendencia com as 8 evidencias. Sem baixa nova. Sem isso, o boleto
-- 0005 (16/10) cairia em outubro na parcela de 16/07 e a de 16/10 ficaria
-- cobravel depois de paga.
-- Autorizado pela Amanda em 18/09/2026. Backup: _backup_fecha_pagamentos_20260918.
do $op$
declare
  c_pid constant uuid := '66ab4070-98fa-483d-ac72-741470c6b6b4';
  c_acordo constant uuid := '1d74c6b5-2bc4-4aa7-a191-898bbba10933';
  v_ok int; v_m jsonb; v_e jsonb; v_hash_antes text; v_hash_depois text;
begin
  select count(*) into v_ok from public.parcelas q
   where q.acordo_id = c_acordo and not coalesce(q.boleto_confiavel, false)
     and ((q.vencimento = '2026-07-16' and q.boleto = '50575530005' and upper(q.status) = 'PAGO')
       or (q.vencimento = '2026-08-16' and q.boleto = '50575530002' and upper(q.status) = 'PAGO')
       or (q.vencimento = '2026-09-16' and q.boleto = '50575530003' and upper(q.status) = 'PAGO')
       or (q.vencimento = '2026-10-16' and q.boleto = '50575530004' and upper(q.status) = 'A_VENCER'));
  if v_ok <> 4 or (select count(*) from public.parcelas where acordo_id = c_acordo) <> 4 then
    raise exception 'OP3_ABORTADA: as parcelas do 57553 mudaram (% de 4 conferem)', v_ok;
  end if;
  if not exists (select 1 from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id and f.decisao is null
                  where p.id = c_pid and p.status_conciliacao = 'REVISAO' and p.dados->>'vencimento' = '2026-09-16') then
    raise exception 'OP3_ABORTADA: o pagamento 0004 nao esta mais em REVISAO com vencimento 16/09';
  end if;

  insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
  select 'op3_57553', 'parcelas', q.id, to_jsonb(q) from public.parcelas q where q.acordo_id = c_acordo
  union all select 'op3_57553', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f) from public.fila_pagamento_sem_vinculo f where f.pagamento_id = c_pid
  union all select 'op3_57553', 'pagamentos', p.id, to_jsonb(p) from public.pagamentos p where p.id = c_pid;

  select md5(string_agg(q.id || q.status || q.valor || coalesce(q.pago_em::text,'') || coalesce(q.confirmado_por_email,''), '|' order by q.id))
    into v_hash_antes from public.parcelas q where q.acordo_id = c_acordo;

  -- dois passos por causa do indice unico do boleto
  update public.parcelas set boleto = null where acordo_id = c_acordo;
  update public.parcelas q
     set boleto = '5057553' || lpad((1 + s.rn)::text, 4, '0'),
         observacao = coalesce(q.observacao,'') || case when coalesce(q.observacao,'') = '' then '' else ' | ' end
           || '18/09/2026: boleto corrigido pela sequencia do vencimento (o arquivo do 0004 traz 16/09); antes o boleto estava em rodizio. Sem mudanca de valor ou status.'
    from (select id, row_number() over (order by vencimento) as rn from public.parcelas where acordo_id = c_acordo) s
   where q.id = s.id;

  select md5(string_agg(q.id || q.status || q.valor || coalesce(q.pago_em::text,'') || coalesce(q.confirmado_por_email,''), '|' order by q.id))
    into v_hash_depois from public.parcelas q where q.acordo_id = c_acordo;
  if v_hash_antes <> v_hash_depois then raise exception 'OP3_ABORTADA: o rotulo mexeu em valor, status ou baixa'; end if;

  v_m := public.pagamento_conciliar_um(c_pid, true);
  if (select status_conciliacao from public.pagamentos where id = c_pid) <> 'PARCELA_JA_PAGA' then
    raise exception 'OP3_ABORTADA: o motor nao reconheceu a parcela de 16/09 como paga: %', v_m;
  end if;
  v_e := public.conciliacao_ja_paga_encerrar(c_pid, true);
  if not coalesce((v_e->>'gravou')::boolean, false) then
    raise exception 'OP3_ABORTADA: a rotina segura recusou: %', v_e->'bloqueios';
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'AMARRA_BOLETO_CORRIGIDA', 'parcelas', c_acordo,
          jsonb_build_object('op', 3, 'acordo', '57553',
                             'antes', jsonb_build_object('16/07','0005','16/08','0002','16/09','0003','16/10','0004'),
                             'depois', jsonb_build_object('16/07','0002','16/08','0003','16/09','0004','16/10','0005'),
                             'pendencia_0004', v_e->'modo', 'sem_efeito_financeiro', true));
end
$op$;
