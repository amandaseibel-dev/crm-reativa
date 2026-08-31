-- DESFAZER 20260831160000_fila_nao_retoma_o_que_ja_foi_decidido.sql
--
-- ATENCAO: desfazer traz de volta 699 pessoas e ~R$ 3,5 milhoes de trabalho JA
-- FEITO na fila de confirmacao antiga. E retrabalho puro, e foi exatamente o que
-- a Amanda pediu para acabar em 31/08.

do $do$
declare v_def text; v_ini int; v_fim int; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'conferencia_pagamentos';

  v_ini := strpos(v_def, 'with nao_conferido as (');
  v_fim := strpos(v_def, 'pg as (');
  if v_ini = 0 or v_fim = 0 then
    raise exception 'marcadores nao encontrados';
  end if;

  v_novo := substr(v_def, 1, v_ini - 1)
|| 'with nao_conferido as (
    select p.id, p.aluno_id, p.aluno_nome, p.valor_pago, p.data_pagamento
      from public.pagamentos p
     where p.data_pagamento >= p_desde and p.data_pagamento < v_ate
       and not exists (select 1 from public.conciliacao_pagamento_conferido c
                        where c.pagamento_id = p.id)
  ),
  '
|| substr(v_def, v_fim);

  execute v_novo;
end $do$;
