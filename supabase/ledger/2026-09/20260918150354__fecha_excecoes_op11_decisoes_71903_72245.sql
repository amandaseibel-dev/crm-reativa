-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- OPERACAO 11 -- so texto na fila
-- 71903 (10 boletos): PARADO por decisao da Amanda -- falta prova do Prime de
-- que o 71614 foi substituido. 72245: decisao pendente registrada. Nada
-- financeiro; so fila_pagamento_sem_vinculo.observacao, com backup.
do $op$
declare r record;
begin
  for r in select f.pagamento_id, ltrim(p.numero_parcela_completo,'0') bol
             from public.fila_pagamento_sem_vinculo f join public.pagamentos p on p.id = f.pagamento_id
            where f.decisao is null
              and (ltrim(p.numero_parcela_completo,'0') like '5071903%' or ltrim(p.numero_parcela_completo,'0') = '50722450001') loop
    insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
    select 'op11_decisoes', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f)
      from public.fila_pagamento_sem_vinculo f where f.pagamento_id = r.pagamento_id;
    update public.fila_pagamento_sem_vinculo f
       set observacao = coalesce(nullif(f.observacao,'') || ' | ', '') || case
         when r.bol like '5071903%' then
           'PARADO 18/09/2026 (decisao da Amanda): nao alterar o 71614, nao registrar o 71903, nao criar as 10 parcelas. Motivo final: falta prova do Prime de que o 71614 foi substituido pelo 71903.'
         else
           'DECISAO_GESTAO: aluna Jessica Quirino Nicoletti identificada (matricula e nome), 2 mensalidades (R$ 294,40), pago R$ 336,03 (x1,1414, dentro da margem), operador cadastrado. Unico bloqueio: AUSENCIA_EXPLICADA -- o acordo 72248, de numero maior, veio na importacao de 17/09 16:32 e o 72245 nao. Decidir: confirmar no Prime que o 72245 e o acordo a vista desta aluna e liberar a trava de ausencia so para este pagamento.'
         end
     where f.pagamento_id = r.pagamento_id and coalesce(f.observacao,'') not like '%PARADO 18/09/2026%'
       and not (r.bol = '50722450001' and coalesce(f.observacao,'') like '%DECISAO_GESTAO:%');
  end loop;
end
$op$;
