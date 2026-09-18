-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- OPERACAO 13 -- so texto na fila
-- Conclusoes do lote 2 registradas em fila_pagamento_sem_vinculo.observacao.
-- Nada financeiro. Backup em _backup_fecha_pagamentos_20260918.
do $op$
declare r record;
begin
  for r in select * from (values
    ('50716450001','LOTE2 18/09 [A] base R$ 317,47 (pago - honorario 8%) = face R$ 294,00 x1,080; Prime corrigiu a divida para R$ 905,47 no proprio dia do acordo (11/09). PODE AUTORIZAR COMO QUITACAO.'),
    ('50716720001','LOTE2 18/09 [A] base R$ 495,06 = face R$ 456,24 x1,085; Prime corrigido R$ 1.065,33 em 11/09. PODE AUTORIZAR COMO QUITACAO.'),
    ('50717060001','LOTE2 18/09 [A] base R$ 164,56 = face R$ 152,00 x1,083; Prime corrigido R$ 691,91 em 11/09. PODE AUTORIZAR COMO QUITACAO.'),
    ('50717460001','LOTE2 18/09 [A] base R$ 345,90 = face R$ 294,00 x1,177; Prime corrigido R$ 933,90 em 11/09. PODE AUTORIZAR COMO QUITACAO.'),
    ('50717700001','LOTE2 18/09 [A] base R$ 282,82 = face R$ 216,07 x1,309; Prime corrigido R$ 642,93 em 11/09. PODE AUTORIZAR COMO QUITACAO.'),
    ('50717870001','LOTE2 18/09 [A] base R$ 1.059,38 = face R$ 872,44 x1,214; Prime corrigido R$ 2.305,73 em 11/09. PODE AUTORIZAR COMO QUITACAO.'),
    ('50719070001','LOTE2 18/09 [B] base R$ 1.272,66 = face R$ 1.136,81 x1,120; abaixo do valor cheio do Prime (4 x R$ 473,67 = R$ 1.894,68); data do Prime e provisoria. PODE AUTORIZAR COMO QUITACAO.'),
    ('50719480001','LOTE2 18/09 [B] base R$ 1.208,14 = face R$ 977,65 x1,236; abaixo do valor do Prime (R$ 1.396,64); data do Prime e provisoria. PODE AUTORIZAR COMO QUITACAO.'),
    ('50719550001','LOTE2 18/09 [B] base R$ 358,95 = face R$ 331,56 x1,083; abaixo do valor do Prime (R$ 473,67 bruto); data provisoria. PODE AUTORIZAR COMO QUITACAO.'),
    ('50721580001','LOTE2 18/09 [B] base R$ 851,88 = face R$ 798,76 x1,067; abaixo do valor do Prime (R$ 1.077,40); data provisoria. PODE AUTORIZAR COMO QUITACAO.'),
    ('50718020001','LOTE2 18/09 [C] base R$ 338,33 = face R$ 248,59 x1,361; o Prime registra so R$ 89,74 para esse titulo (bruto 0). Excedente sem explicacao financeira. AGUARDA AMANDA.'),
    ('50721410001','LOTE2 18/09 [C] base R$ 1.266,69 = face R$ 1.092,44 x1,159; passa R$ 72,63 (6,1%) do corrigido do Prime em 13/03 (R$ 1.194,06); nao ha regra de juros no CRM que explique. AGUARDA AMANDA.'),
    ('50720490001','LOTE2 18/09: nenhuma evidencia de autorizacao do desconto (0 links, 0 termos, 0 solicitacoes de link/financeiro, so 2 movimentacoes do sistema). Mantido pendente; nao baixar por inferencia.'),
    ('50648470001','LOTE2 18/09: sem prova no Prime de que o acordo 64847 segue vivo; o acordo ja teve a observacao "quitado automaticamente" e esta CANCELADO sem auditoria de quem cancelou. Mantido pendente.'),
    ('50634280001','LOTE2 18/09: provado que o dinheiro nao foi apropriado (11 parcelas pagas 1:1 pelos proprios boletos, soma R$ 3.635,68, sem baixa manual, nenhuma parcela de R$ 908,92). Nenhuma funcao oficial registra parcela em acordo QUITADO; aguarda aprovacao da alteracao minima.'),
    ('50716580001','LOTE2 18/09: registro autorizado, mas o fluxo atual reabre a aluna (gatilho de divida nova muda BAIXA_REALIZADA para ACORDO_FECHADO) e a quitacao passa por _talvez_quitar_aluno, funcao do Grupo A; aguarda alteracao minima apos o merge do Grupo A.')
  ) d(bol, texto) loop
    insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
    select 'op13_motivos', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f)
      from public.fila_pagamento_sem_vinculo f join public.pagamentos p on p.id = f.pagamento_id
     where ltrim(p.numero_parcela_completo,'0') = r.bol and f.decisao is null;
    update public.fila_pagamento_sem_vinculo f
       set observacao = coalesce(nullif(f.observacao,'') || ' | ', '') || r.texto
      from public.pagamentos p
     where p.id = f.pagamento_id and ltrim(p.numero_parcela_completo,'0') = r.bol
       and f.decisao is null and coalesce(f.observacao,'') not like '%LOTE2 18/09%';
  end loop;
end
$op$;
