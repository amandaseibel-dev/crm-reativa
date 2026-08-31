-- A fila retomava quem ja tinha sido resolvido na confirmacao antiga.
--
-- Amanda, 31/08: "o que ja fizemos semana passada nao vamos retomar; apenas se
-- entrar algo no Santander e sinal que ocorreu algum pagamento para baixar".
--
-- A fila so sabia excluir o que ELA MESMA tinha conferido
-- (`conciliacao_pagamento_conferido`). Nao enxergava as decisoes da fila de
-- confirmacao antiga (`solicitacoes_confirmacao_pagamento`) -- entao gente
-- resolvida ali voltava a aparecer aqui.
--
-- Medido em 31/08, sobre 2.085 pessoas na fila: apenas 27 NUNCA tinham passado
-- pela confirmacao. Das que ja tinham decisao FECHADA e posterior ao pagamento:
--
--   PAGAMENTO_CONFIRMADO     517   R$ 1.394.749,39   <- aceite, ja contabilizado
--   ENCERRADO_VIA_ACORDO     454   R$ 1.829.215,98   <- aceite, ja contabilizado
--   CONCLUIDA_SALDO_ZERO       3   R$     6.610,77   <- aceite, ja contabilizado
--   ENCERRADO_SEM_VALOR      170   R$   719.531,60   <- NAO valorou nada
--   PAGAMENTO_REJEITADO       12   R$    21.549,81   <- foi recusado
--   AGUARDANDO_VINCULO         2   R$     1.094,71   <- ainda aberto
--
-- SO OS TRES DE ACEITE SAEM. Nos outros a decisao anterior nao contabilizou
-- valor nenhum, e o extrato mostra dinheiro que entrou de verdade e segue
-- precisando de conferencia -- tira-los seria esconder dinheiro real.
--
-- A COMPARACAO E POR DATA, nao por "ja passou algum dia". A decisao so cobre o
-- pagamento se foi tomada DEPOIS dele. Pagamento posterior a uma decisao antiga
-- e dinheiro novo e volta para a fila -- que e exatamente a regra da Amanda:
-- entrou no Santander, tem de baixar.
--
-- EFEITO MEDIDO (julho + agosto):
--   antes   2.085 pessoas   R$ 4.705.616,29 a conferir
--   depois  1.386 pessoas   R$ 1.172.864,03 a conferir
--   tempo   0,21s
--
-- DESFAZER: supabase/rollbacks/20260831160000_fila_nao_retoma_o_que_ja_foi_decidido.rollback.sql

do $do$
declare v_def text; v_ini int; v_fim int; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'conferencia_pagamentos';

  if v_def is null then
    raise exception 'conferencia_pagamentos nao existe -- migration fora de ordem';
  end if;

  if v_def like '%solicitacoes_confirmacao_pagamento s%' then
    return; -- ja aplicada
  end if;

  v_ini := strpos(v_def, 'with nao_conferido as (');
  v_fim := strpos(v_def, 'pg as (');
  if v_ini = 0 or v_fim = 0 or v_fim <= v_ini then
    raise exception 'marcadores nao encontrados -- nada alterado';
  end if;

  v_novo := substr(v_def, 1, v_ini - 1)
|| 'with nao_conferido as (
    select p.id, p.aluno_id, p.aluno_nome, p.valor_pago, p.data_pagamento
      from public.pagamentos p
     where p.data_pagamento >= p_desde and p.data_pagamento < v_ate
       and not exists (select 1 from public.conciliacao_pagamento_conferido c
                        where c.pagamento_id = p.id)
       -- O QUE JA FOI DECIDIDO NAO VOLTA. So os tres status de ACEITE contam
       -- como decidido; nos outros a decisao nao contabilizou valor nenhum.
       -- A comparacao e por DATA: pagamento posterior a decisao e dinheiro novo.
       and not exists (
         select 1 from public.solicitacoes_confirmacao_pagamento s
          where s.aluno_id = p.aluno_id::text
            and upper(coalesce(s.status,'''')) in
                (''PAGAMENTO_CONFIRMADO'',''ENCERRADO_VIA_ACORDO'',''CONCLUIDA_SALDO_ZERO'')
            and coalesce(s.confirmado_em, s.atualizado_em)::date >= p.data_pagamento)
  ),
  '
|| substr(v_def, v_fim);

  execute v_novo;
end $do$;
