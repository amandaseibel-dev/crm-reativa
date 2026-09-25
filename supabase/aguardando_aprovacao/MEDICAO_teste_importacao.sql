-- =====================================================================
-- MEDICAO DO TESTE DA NOVA REGRA DE VINCULACAO — 8 pontos
-- Preparado em 12/09/2026. 100% SELECT: rodar ANTES e DEPOIS da importacao
-- e comparar linha a linha. Nada aqui escreve.
--
-- Os digest_* sao md5 do conteudo ordenado. Servem para provar "nenhuma
-- mudanca" de verdade: um total pode ficar igual com duas linhas se
-- compensando; o digest nao.
-- =====================================================================
select 1 as ord, '1. pagamentos: total'                 as ponto, count(*)::text as valor from public.pagamentos
union all select 1, '1. pagamentos: ultimo created_at', coalesce(max(created_at)::text,'-') from public.pagamentos
union all select 1, '1. pagamentos: digest de (id, aluno_id)',
  md5(string_agg(id::text||'>'||coalesce(aluno_id::text,'null'), '|' order by id)) from public.pagamentos
union all select 2, '2. pagamentos com aluno_id',  count(aluno_id)::text from public.pagamentos
union all select 2, '2. pagamentos SEM aluno_id',  count(*) filter (where aluno_id is null)::text from public.pagamentos
union all select 3, '3. fila_pagamento_sem_vinculo: linhas', count(*)::text from public.fila_pagamento_sem_vinculo
union all select 3, '3. fila: pendentes de decisao', count(*) filter (where decisao is null)::text from public.fila_pagamento_sem_vinculo
union all select 3, '3. fila: valor pendente', to_char(coalesce(sum(valor_pago) filter (where decisao is null),0),'FM999G999G990D00') from public.fila_pagamento_sem_vinculo
union all select 4, '4. parcelas PAGO', count(*) filter (where upper(coalesce(status,''))='PAGO')::text from public.parcelas
union all select 4, '4. parcelas com origem_baixa GATILHO_IMPORTACAO', count(*) filter (where origem_baixa='GATILHO_IMPORTACAO')::text from public.parcelas
union all select 4, '4. parcelas: digest de (id, status, pago_em)',
  md5(string_agg(id::text||'>'||coalesce(status,'')||'>'||coalesce(pago_em::text,''), '|' order by id)) from public.parcelas
union all select 4, '4. baixas_pagamento: linhas', count(*)::text from public.baixas_pagamento
union all select 5, '5. suspeitas_pagamento_duplicado: linhas', count(*)::text from public.suspeitas_pagamento_duplicado
union all select 5, '5. suspeitas sem decisao humana', count(*) filter (where decidido_em is null)::text from public.suspeitas_pagamento_duplicado
union all select 5, '5. suspeitas por status', (select string_agg(status||'='||q, ' | ' order by status) from (select status, count(*) q from public.suspeitas_pagamento_duplicado group by 1) x)
union all select 6, '6. alunos.saldo_total: soma', to_char(coalesce(sum(saldo_total),0),'FM999G999G990D00') from public.alunos
union all select 6, '6. alunos: digest de (id, saldo_total)',
  md5(string_agg(id::text||'>'||coalesce(saldo_total,0)::text, '|' order by id)) from public.alunos
union all select 7, '7. casos: total',  count(*)::text from public.casos
union all select 7, '7. casos: nao encerrados', count(*) filter (where not coalesce(encerrado_operacional,false))::text from public.casos
union all select 7, '7. casos.saldo_total: soma', to_char(coalesce(sum(saldo_total),0),'FM999G999G990D00') from public.casos
union all select 7, '7. casos: digest de (id, status_atual, saldo_total, encerrado)',
  md5(string_agg(id::text||'>'||coalesce(status_atual,'')||'>'||coalesce(saldo_total,0)::text||'>'||coalesce(encerrado_operacional,false)::text, '|' order by id)) from public.casos
union all select 8, '8. auditoria: recusas/falhas nas ultimas 2h',
  (select count(*)::text from public.auditoria
    where created_at > now() - interval '2 hours'
      and (acao like '%RECUSADA%' or acao like '%FALHOU%' or acao like '%ERRO%'))
union all select 8, '8. auditoria: ultima acao de baixa', coalesce((select acao||' em '||created_at::text from public.auditoria
  where acao in ('BAIXA_PELO_DOCUMENTO','BAIXA_DOCUMENTO_RECUSADA','BAIXA_LOTE_FALHOU')
  order by created_at desc limit 1),'-')
union all select 8, '8. tabelas _backup_baixa_relatorio_% (1 por importacao)',
  (select count(*)::text from pg_class where relname like '\_backup\_baixa\_relatorio\_%' and relkind='r')
order by ord, ponto;
