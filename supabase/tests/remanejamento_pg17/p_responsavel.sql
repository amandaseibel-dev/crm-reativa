-- RESPONSAVEL e ACORDO com os GUARDAS e GATILHOS REAIS de producao carregados.
--  (a) escrita indevida de responsavel e recusada (authenticated);
--  (b) atribuicao pelo caminho oficial e permitida;
--  (c) segue_dono: acordo do proprio dono sem mensalidade -> aluno segue o dono;
--  (d) segue_dono: acordo de terceiro com mensalidade em aberto -> aluno NAO muda;
--  (e) preservacao: mover o aluno nao altera o responsavel do acordo.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');

-- (a) escrita direta de responsavel por authenticated: barrada pelo guard
create temp table _a on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 100, null, 40);
grant select, update on public.alunos to authenticated;
set role authenticated;
select pg_temp.como('cobranca05@aelbra.com.br');
do $$
declare x record;
begin
  select * into x from _a;
  begin
    update public.alunos set responsavel_atual_email = 'cobranca06@aelbra.com.br' where id = x.aluno;
    perform pg_temp.afirma(false, 'escrita indevida: authenticated NAO deveria trocar responsavel');
  exception when others then
    perform pg_temp.afirma(sqlerrm ~ 'SEM_PERMISSAO', 'escrita indevida recusada: '||sqlerrm);
  end;
end $$;
reset role;

-- (b) atribuicao permitida: o caminho oficial (executor) troca o responsavel
select pg_temp.como('amanda.seibel@aelbra.com.br');
do $$
declare x record;
begin
  select * into x from _a;
  perform internal.set_resp_aluno(x.aluno, 'cobranca06@aelbra.com.br', 'Mauricio', 'ATRIBUICAO_TESTE', 'teste', 'amanda.seibel@aelbra.com.br', 'Amanda');
  perform pg_temp.afirma((select responsavel_atual_email from public.alunos where id = x.aluno) = 'cobranca06@aelbra.com.br',
    'atribuicao permitida pelo caminho oficial');
end $$;

-- (c) segue_dono: Mauricio fecha acordo ATIVO do aluno SEM mensalidade em aberto -> aluno segue o dono
create temp table _c on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 0, null, 40);
do $$
declare x record;
begin
  select * into x from _c;
  -- o semear de saldo 0 nao cria titulo; por isso o aluno nao tem mensalidade em aberto
  insert into public.acordos (id, aluno_id, cpf, status, tipo, forma_pagamento, qtd_parcelas, entrada_paga, criado_em, atualizado_em, numero_acordo, valor_total, operador_responsavel_email, operador_responsavel_nome)
  values (gen_random_uuid(), x.aluno, (select cpf from public.alunos where id = x.aluno), 'ATIVO', 'PARCELADO', 'BOLETO', 1, false, now(), now(), floor(random()*1e9)::bigint, 100, 'cobranca06@aelbra.com.br', 'Mauricio');
  perform pg_temp.afirma((select responsavel_atual_email from public.alunos where id = x.aluno) = 'cobranca06@aelbra.com.br',
    'segue_dono: acordo ativo de operador sem mensalidade -> aluno segue o dono (producao)');
end $$;

-- (d) segue_dono: acordo de terceiro com mensalidade em aberto -> aluno NAO muda
create temp table _d on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 500, null, 40);
do $$
declare x record;
begin
  select * into x from _d;
  insert into public.acordos (id, aluno_id, cpf, status, tipo, forma_pagamento, qtd_parcelas, entrada_paga, criado_em, atualizado_em, numero_acordo, valor_total, operador_responsavel_email, operador_responsavel_nome)
  values (gen_random_uuid(), x.aluno, (select cpf from public.alunos where id = x.aluno), 'ATIVO', 'PARCELADO', 'BOLETO', 1, false, now(), now(), floor(random()*1e9)::bigint, 100, 'cobranca06@aelbra.com.br', 'Mauricio');
  perform pg_temp.afirma((select responsavel_atual_email from public.alunos where id = x.aluno) = 'cobranca05@aelbra.com.br',
    'segue_dono: com mensalidade em aberto o aluno NAO muda de dono');
end $$;

-- (e) preservacao: mover o aluno nao altera o responsavel do acordo
do $$
declare x record; p jsonb; r jsonb; antes text;
begin
  select * into x from _d;
  select operador_responsavel_email into antes from public.acordos where aluno_id = x.aluno limit 1;
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'preservacao');
  perform pg_temp.afirma((select operador_responsavel_email from public.acordos where aluno_id = x.aluno limit 1) = antes,
    'preservacao: responsavel do acordo nao mudou com a movimentacao do aluno');
end $$;

select 'RESPONSAVEL OK' as resultado;
