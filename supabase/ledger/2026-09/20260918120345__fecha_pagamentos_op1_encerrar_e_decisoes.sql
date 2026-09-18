-- FECHAMENTO DA FRENTE DE PAGAMENTOS -- 18/09/2026 -- OPERACAO 1 de 3
-- (a) encerra pela gestao as duas PARCELA_JA_PAGA cujo dinheiro ja esta
--     refletido (46921, 61796): acordo QUITADO, parcela do boleto PAGO, tantos
--     pagamentos do acordo quantas parcelas PAGO. A rotina automatica recusa so
--     porque uma parcela paga ficou sem boleto (PAGAS_SEM_BOLETO). Sem baixa nova.
-- (b) registra na fila, em `observacao`, a decisao que a gestao precisa tomar
--     em cada excecao humana aberta. Texto apenas; nada financeiro.
-- Autorizado pela Amanda em 18/09/2026 (fechamento da frente de pagamentos).
-- Backup deny-all: public._backup_fecha_pagamentos_20260918.

create table if not exists public._backup_fecha_pagamentos_20260918 (
  id bigserial primary key, op text not null, tabela text not null, registro_id uuid not null,
  antes jsonb not null, criado_em timestamptz not null default now());
alter table public._backup_fecha_pagamentos_20260918 enable row level security;
revoke all on public._backup_fecha_pagamentos_20260918 from anon, authenticated;

do $op$
declare
  v_pid uuid; v_r jsonb; v_prefixo text; v_pag int; v_parc int; v_ac text;
  v_dec record;
begin
  -- (a) as duas PARCELA_JA_PAGA com efeito ja refletido
  foreach v_pid in array array['62497ad8-1d86-476a-8fc9-69f0711e490c','783056d9-5980-40bb-8a10-98a4509496f5']::uuid[] loop
    select substr(ltrim(p.numero_parcela_completo,'0'),1,7) into v_prefixo from public.pagamentos p
     where p.id = v_pid and p.status_conciliacao = 'PARCELA_JA_PAGA';
    if v_prefixo is null then raise exception 'OP1_ABORTADA: % nao esta mais em PARCELA_JA_PAGA', v_pid; end if;
    select a.status into v_ac from public.parcelas q join public.acordos a on a.id = q.acordo_id
     join public.pagamentos p on ltrim(p.numero_parcela_completo,'0') = q.boleto
     where p.id = v_pid and upper(q.status) = 'PAGO';
    if coalesce(upper(v_ac),'') <> 'QUITADO' then raise exception 'OP1_ABORTADA: acordo de % nao esta QUITADO com a parcela do boleto PAGO', v_pid; end if;
    select count(*) into v_pag from public.pagamentos g
     where ltrim(coalesce(g.numero_parcela_completo,''),'0') like v_prefixo || '%' and not (coalesce(g.dados,'{}'::jsonb) ? 'estornado_em');
    select count(*) into v_parc from public.parcelas q join public.acordos a on a.id = q.acordo_id
     where lpad(a.numero_ulbra,6,'0') = substr(v_prefixo,2,6) and upper(q.status) = 'PAGO';
    if v_pag <> v_parc then raise exception 'OP1_ABORTADA: % tem % pagamentos e % parcelas PAGO', v_pid, v_pag, v_parc; end if;

    insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
    select 'op1_encerrar', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f) from public.fila_pagamento_sem_vinculo f where f.pagamento_id = v_pid;

    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_r := public.conciliacao_encerrar(v_pid,
      'fechamento 18/09/2026: dinheiro ja refletido -- acordo QUITADO, parcela do boleto PAGO e '
      || v_pag || ' pagamentos para ' || v_parc || ' parcelas PAGO; a rotina automatica recusa so porque uma parcela paga '
      || 'ficou sem boleto. Sem baixa nova. Autorizado pela Amanda; executado por migration.');
    perform set_config('request.jwt.claims', '', true);
    if not coalesce((v_r->>'ok')::boolean, false) then raise exception 'OP1_ABORTADA: encerrar % recusou: %', v_pid, v_r; end if;
  end loop;

  -- (b) a decisao necessaria em cada excecao humana aberta
  for v_dec in
    select * from (values
      ('50671850002','DECISAO_GESTAO: acordo 67185 nao existe no CRM; o mesmo aluno tem a parcela 54577/0002 (venc. 27/08, R$ 589,09) sem pagamento. Confirmar no Prime se 67185 substituiu o 54577 -- sem isso nao ha parcela para baixar.'),
      ('50716450001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50716580001','DECISAO_GESTAO: aluno esta com BAIXA_REALIZADA (encerrado). Decidir se o acordo a vista deste pagamento e registrado mesmo assim.'),
      ('50716720001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50717060001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50717460001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50717520001','DECISAO_GESTAO: acordo de numero maior ja tinha sido importado antes do pagamento -- a ausencia deste acordo nao se explica. Confirmar no Prime o acordo 71752 e o aluno (pagamento sem CPF).'),
      ('50717700001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50717870001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50718020001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50718030001','DECISAO_GESTAO: operador do pagamento (OSVALDINA.ALVES) nao esta cadastrado. Cadastrar o operador ou indicar a quem vai o credito do acordo.'),
      ('50718590001','DECISAO_GESTAO: acordo de numero maior ja tinha sido importado antes do pagamento -- a ausencia deste acordo nao se explica. Confirmar no Prime o acordo 71859 e o aluno (pagamento sem CPF).'),
      ('50718600001','DECISAO_GESTAO: acordo de numero maior ja tinha sido importado antes do pagamento -- a ausencia deste acordo nao se explica. Confirmar no Prime o acordo 71860 e o aluno (pagamento sem CPF).'),
      ('50719030001','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030002','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030003','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030004','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030005','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030006','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030007','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030008','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030009','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719030010','DECISAO_GESTAO: acordo 71903 (10 boletos pagos em 14/09, R$ 4.293,62) nao esta no CRM; o aluno tem o acordo 71614 ATIVO sem pagamento. Confirmar no Prime se 71903 renegociou o 71614.'),
      ('50719040001','DECISAO_GESTAO: acordo de numero maior ja tinha sido importado antes do pagamento -- a ausencia deste acordo nao se explica. Confirmar no Prime o acordo 71904 e o aluno (pagamento sem CPF).'),
      ('50719070001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50719480001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50719550001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50719880001','DECISAO_GESTAO: aluno sem mensalidade em aberto elegivel; o pagamento renegocia o acordo antigo 41175. Decidir se registra como renegociacao do 41175 (as parcelas dele sao a divida coberta).'),
      ('50719990001','DECISAO_GESTAO: aluno sem mensalidade em aberto elegivel; o pagamento renegocia o acordo antigo 49071. Decidir se registra como renegociacao do 49071 (as parcelas dele sao a divida coberta).'),
      ('50720450001','DECISAO_GESTAO: a matricula do arquivo nao leva a um aluno unico (R$ 13.098,61). Confirmar qual aluno pagou antes de qualquer registro.'),
      ('50720490001','DECISAO_GESTAO: a soma das mensalidades em aberto (R$ 2.697,23) passa do valor pago (R$ 1.880,11). Escolher quais mensalidades o acordo cobriu.'),
      ('50721410001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50721580001','DECISAO_GESTAO: pago excede em mais de 15% a soma das mensalidades em aberto do aluno. Escolher as mensalidades que o acordo cobriu (ou aceitar a diferenca) e registrar pelo botao.'),
      ('50722830001','DECISAO_GESTAO: a matricula do arquivo nao leva a um aluno unico. Confirmar qual aluno pagou antes de qualquer registro.'),
      ('50626840002','DECISAO_GESTAO: o pagamento 0001 (R$ 1.430,40 em 14/08) foi baixado pela gestao em 02/09 nas parcelas 0002-0006 do acordo 62684; em 18/09 o proprio boleto 0002 foi pago (R$ 243,24). Decidir: o 0001 era a entrada (a baixa de 02/09 precisa ser refeita parcela a parcela) ou quitou o acordo (o 0002 e pagamento em duplicidade).'),
      ('50647660003','DECISAO_GESTAO: 3 pagamentos reais (0001, 0002 de 25/08 e 0003 de 16/09) e so 2 parcelas PAGO; a 0002 (R$ 3.256,29) aparece VENCIDA e cobravel. A baixa dela foi desfeita pela gestao em 17/09 14:31. Decidir se a 0002 volta a PAGO pelo pagamento 0002.'),
      ('50634280001','DECISAO_GESTAO: entrada de R$ 908,92 paga em 17/09 junto com as 11 parcelas; o acordo 63428 ja esta QUITADO. A reconstrucao aprovada so cobre acordo ATIVO. Decidir se a entrada e registrada no acordo quitado.'),
      ('50648470001','DECISAO_GESTAO: pagamento de R$ 976,34 do boleto do acordo 64847, que esta CANCELADO no CRM. Confirmar no Prime se o acordo esta vivo: reativar (e a baixa sai pelo motor) ou tratar como pagamento sem acordo.')
    ) d(boleto, texto)
  loop
    insert into public._backup_fecha_pagamentos_20260918 (op, tabela, registro_id, antes)
    select 'op1_decisao', 'fila_pagamento_sem_vinculo', f.pagamento_id, to_jsonb(f)
      from public.fila_pagamento_sem_vinculo f join public.pagamentos p on p.id = f.pagamento_id
     where ltrim(p.numero_parcela_completo,'0') = v_dec.boleto and f.decisao is null;
    update public.fila_pagamento_sem_vinculo f
       set observacao = coalesce(nullif(f.observacao,'') || ' | ', '') || v_dec.texto
      from public.pagamentos p
     where p.id = f.pagamento_id and ltrim(p.numero_parcela_completo,'0') = v_dec.boleto
       and f.decisao is null and coalesce(f.observacao,'') not like '%DECISAO_GESTAO:%';
  end loop;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'FECHAMENTO_FRENTE_PAGAMENTOS', 'fila_pagamento_sem_vinculo', null,
          jsonb_build_object('op', 1, 'encerrados_gestao', jsonb_build_array('46921/0004','61796/0004'),
                             'decisoes_registradas', (select count(*) from public.fila_pagamento_sem_vinculo where decisao is null and observacao like '%DECISAO_GESTAO:%'),
                             'sem_efeito_financeiro', true));
end
$op$;
