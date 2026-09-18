-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- OPERACAO 9 -- pagamento 72283
-- Depois da mesclagem oficial (op7) e da previa que desconsidera a ficha
-- marcada CADASTRO_DUPLICADO (20260918143825): a recuperacao automatica oficial
-- so para este pagamento. Recusa: RAISE e nada fica gravado.
do $op$
declare
  c_pid constant uuid := 'a9aa90f7-0a47-45b2-926c-efb88d4b5e25';
  c_aluno constant uuid := '27e39174-d618-44bc-bb94-395ebac070d6';
  v_r jsonb; v_acordo uuid;
begin
  if not exists (select 1 from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id and f.decisao is null
                  where p.id = c_pid and p.status_conciliacao = 'AGUARDANDO_ACORDO') then
    raise exception 'OP9_ABORTADA: o pagamento 72283 nao esta mais pendente';
  end if;
  v_r := public.acordo_avista_recuperar_um(c_pid, true);
  if not coalesce((v_r->>'gravou')::boolean, false) then raise exception 'OP9_ABORTADA: recusado: %', v_r; end if;

  select q.acordo_id into v_acordo from public.parcelas q where q.origem_baixa_ref = c_pid::text and upper(q.status) = 'PAGO';
  if v_acordo is null
     or (select status_conciliacao from public.pagamentos where id = c_pid) <> 'BAIXADO'
     or (select aluno_id from public.acordos where id = v_acordo) <> c_aluno
     or (select upper(status) from public.acordos where id = v_acordo) <> 'QUITADO'
     or (select count(*) from public.acordos where numero_ulbra = '72283') <> 1
     or (select count(*) from public.acordos_titulos t join public.acordo_titulo_vinculo v on v.titulo_id = t.id and v.acordo_id = v_acordo and v.ativo
          where t.aluno_id = c_aluno and upper(t.situacao) = 'PAGO' and t.acordo_id = v_acordo) <> 2
     or (select count(*) from public.parcelas where origem_baixa_ref = c_pid::text) <> 1 then
    raise exception 'OP9_ABORTADA: a cadeia final nao fechou';
  end if;
end
$op$;
