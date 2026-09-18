-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- OPERACAO 10 -- pagamento 71803
-- Autorizado pela Amanda em 18/09/2026: registrar SEM credito individual, com a
-- origem externa OSVALDINA.ALVES. Autorizacao da gestao para ESTE pagamento
-- (pagamento_autorizar_origem_externa), depois o registrador oficial com as
-- mensalidades que a previa declarou elegiveis. Sem cadastrar usuario, sem
-- mudar o responsavel do aluno, sem credito a ninguem. Qualquer desvio: RAISE.
do $op$
declare
  c_pid constant uuid := 'b75ba78a-cafb-4780-9b4c-2e6f2ecd3f1c';
  c_aluno constant uuid := 'f8057547-75f0-4002-b794-41b27b136aff';
  v_resp_antes text; v_a jsonb; v_p jsonb; v_ids uuid[]; v_r jsonb; v_acordo uuid;
begin
  select responsavel_atual_email into v_resp_antes from public.alunos where id = c_aluno;
  if not exists (select 1 from public.pagamentos p join public.fila_pagamento_sem_vinculo f on f.pagamento_id = p.id and f.decisao is null
                  where p.id = c_pid and p.status_conciliacao = 'AGUARDANDO_ACORDO' and p.operador_email is null
                    and p.operador_nome = 'OSVALDINA.ALVES' and p.aluno_id = c_aluno) then
    raise exception 'OP10_ABORTADA: o pagamento 71803 nao esta como lido';
  end if;

  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}', true);
  v_a := public.pagamento_autorizar_origem_externa(c_pid,
    'Autorizado pela Amanda em 18/09/2026: operador de origem OSVALDINA.ALVES nao e usuario do CRM; acordo sem credito individual.');
  if not coalesce((v_a->>'ok')::boolean, false) then raise exception 'OP10_ABORTADA: autorizacao recusada: %', v_a; end if;

  v_p := public.acordo_avista_previa(c_pid, null);
  if not coalesce((v_p->>'aprovado')::boolean, false) then raise exception 'OP10_ABORTADA: previa recusou: %', v_p->'bloqueios'; end if;
  select array_agg((t->>'id')::uuid) into v_ids from jsonb_array_elements(v_p->'titulos'->'selecionados') t where t->>'impedimento' is null;

  v_r := public.acordo_avista_registrar(c_pid, v_ids, true);
  perform set_config('request.jwt.claims', '', true);
  if not coalesce((v_r->>'gravou')::boolean, false) then raise exception 'OP10_ABORTADA: registrador recusou: %', v_r->'bloqueios'; end if;

  v_acordo := (v_r->>'acordo_id')::uuid;
  if (select status_conciliacao from public.pagamentos where id = c_pid) <> 'BAIXADO'
     or (select upper(status) from public.acordos where id = v_acordo) <> 'QUITADO'
     or (select numero_ulbra from public.acordos where id = v_acordo) <> '71803'
     or (select operador_responsavel_email from public.acordos where id = v_acordo) is not null
     or (select observacao from public.acordos where id = v_acordo) not like '%ORIGEM EXTERNA: OSVALDINA.ALVES%'
     or not exists (select 1 from public.parcelas where acordo_id = v_acordo and upper(status) = 'PAGO' and origem_baixa_ref = c_pid::text)
     or exists (select 1 from unnest(v_ids) x join public.acordos_titulos t on t.id = x
                 where upper(t.situacao) <> 'PAGO'
                    or (select count(*) from public.acordo_titulo_vinculo v where v.titulo_id = t.id and v.acordo_id = v_acordo and v.ativo) <> 1)
     or (select detalhes->>'credito_individual' from public.auditoria where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO' and registro_id = v_acordo) <> 'NAO_ATRIBUIDO'
     or (select detalhes->'origem_externa'->>'operador_origem' from public.auditoria where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO' and registro_id = v_acordo) <> 'OSVALDINA.ALVES'
     or exists (select 1 from public.usuarios where email ilike '%osval%' or nome ilike '%osval%') then
    raise exception 'OP10_ABORTADA: a cadeia final nao fechou';
  end if;
  if (select responsavel_atual_email from public.alunos where id = c_aluno) is distinct from v_resp_antes then
    raise exception 'OP10_ABORTADA: o responsavel atual do aluno mudou (% -> %)', v_resp_antes,
      (select responsavel_atual_email from public.alunos where id = c_aluno);
  end if;
end
$op$;
