-- PROTECAO REAL (funcoes e estruturas de producao): cada fonte de protecao
-- real impede a movimentacao; a liberacao positiva e idempotente.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');

-- 1) confirmacao financeira aberta (solicitacoes_confirmacao_pagamento)
create temp table _r1 on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
insert into public.solicitacoes_confirmacao_pagamento (id, aluno_id, aluno_cpf, status, operador_email, criado_em, atualizado_em)
select gen_random_uuid(), r.aluno::text, (select cpf from public.alunos where id = r.aluno), 'AGUARDANDO_CONFIRMACAO', 'cobranca05@aelbra.com.br', now(), now() from _r1 r;
-- 2) link vivo (links_pagamento, por cpf)
create temp table _r2 on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
insert into public.links_pagamento (id, aluno_id, aluno_cpf, status, criado_em, solicitado_em, enviado_ao_aluno_em)
select gen_random_uuid(), r.aluno::text, (select cpf from public.alunos where id = r.aluno), 'LINK_ENVIADO_AO_ALUNO', now(), now(), now() from _r2 r;
-- 3) acordo ativo (acordos, por cpf do aluno)
create temp table _r3 on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
insert into public.acordos (id, aluno_id, cpf, status, tipo, forma_pagamento, qtd_parcelas, entrada_paga, criado_em, atualizado_em, numero_acordo, valor_total)
select gen_random_uuid(), r.aluno, (select cpf from public.alunos where id = r.aluno), 'ATIVO', 'PARCELADO', 'BOLETO', 1, false, now(), now(), floor(random()*1e9)::bigint, 300 from _r3 r;
-- 4) baixa aguardando (baixas_pagamento, por cpf)
create temp table _r4 on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
insert into public.baixas_pagamento (id, aluno_id, aluno_cpf, status_baixa, recebido_em, atualizado_em)
select gen_random_uuid(), r.aluno::text, (select cpf from public.alunos where id = r.aluno), 'AGUARDANDO_BAIXA', now(), now() from _r4 r;

do $$
declare x record; p jsonb; r jsonb; n int := 0;
begin
  for x in select * from _r1 union all select * from _r2 union all select * from _r3 union all select * from _r4 loop
    n := n + 1;
    p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
    perform pg_temp.afirma(p->'itens'->0->>'bloqueio' = 'PROTEGIDO', 'fonte real '||n||': caso protegido na previa');
    r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'protecao real');
    perform pg_temp.afirma((r->>'alunos_movidos')::int = 0 and pg_temp.dono(x.caso) = 'carteira.geral@reativa.local',
      'fonte real '||n||': nao movido na execucao');
  end loop;
end $$;

-- 5) LIBERACAO POSITIVA: responsavel (Mauricio) com caso fidelizado por ACIONAMENTO recente,
--    liberado explicitamente neste lote -> move; e marca de 10 dias gravada.
select pg_temp.como('amanda.seibel@aelbra.com.br');
create temp table _lib on commit preserve rows as select * from pg_temp.semear('cobranca06@aelbra.com.br', 400, 3, 40);
do $$
declare m record; p jsonb; r jsonb;
begin
  select * into m from _lib;
  p := pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br', '{"responsavel":"cobranca06@aelbra.com.br","liberar_fidelizacao_de":["cobranca06@aelbra.com.br"]}');
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' is null, 'liberacao positiva: previa aceita com liberacao do responsavel filtrado');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'liberacao autorizada');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 1 and pg_temp.dono(m.caso) = 'cobranca05@aelbra.com.br',
    'liberacao positiva: caso movido para a Luana. execucao='||r::text||' previa_item='||(p->'itens'->0)::text||' dono='||coalesce(pg_temp.dono(m.caso),'-'));
  perform pg_temp.afirma(pg_temp.marca(m.caso) = pg_temp.hoje() + 10, 'liberacao positiva: marca de 10 dias gravada');
end $$;

-- 6) IDEMPOTENCIA: mesma previa executada duas vezes nao move de novo
do $$
declare m record; p jsonb; r jsonb; ok boolean := false;
begin
  select * into m from _lib;
  p := pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  begin
    perform public.carteira_geral_mover((p->>'previa_id')::uuid, 'um');
  exception when others then null;
  end;
  begin
    perform public.carteira_geral_mover((p->>'previa_id')::uuid, 'dois');
    perform pg_temp.afirma(false, 'idempotencia: segunda execucao deveria falhar');
  exception when others then
    perform pg_temp.afirma(sqlerrm ~ 'ja foi executada', 'idempotencia: segunda execucao recusada ('||sqlerrm||')');
  end;
end $$;

-- 7) liberacao diaria executada duas vezes: o mesmo caso nao e solto duas vezes, nem o rollback de estado
do $$
declare m record; a int; b int;
begin
  select * into m from _lib;
  update public.alunos set responsavel_atual_em = now() - interval '2 days' where id = m.aluno;
  update public.casos set giro_fidelizacao_ate = pg_temp.hoje() - 1 where id = m.caso;
  a := public.liberar_casos_fidelizacao_vencida(100000);
  b := public.liberar_casos_fidelizacao_vencida(100000);
  perform pg_temp.afirma(b = 0, 'idempotencia diaria: segunda rodada nao solta nada (primeira '||a||', segunda '||b||')');
end $$;

select 'PROTECAO REAL OK' as resultado;
