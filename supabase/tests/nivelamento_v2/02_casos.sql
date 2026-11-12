-- CASOS DO NIVELAMENTO V2. Roda DEPOIS de 01_ambiente.sql e da migration
-- 20261112120000 e da 20261112120100. Cada bloco falha com RAISE EXCEPTION.
\set ON_ERROR_STOP on

create or replace function pg_temp.afirma(p_ok boolean, p_msg text) returns void
language plpgsql as $$
begin
  if not p_ok then raise exception 'FALHOU: %', p_msg; end if;
  raise notice 'OK: %', p_msg;
end $$;

-- ---------------------------------------------------------------- DADOS -----
insert into public.usuarios(email, nome) values
  ('opa@t.local','OPA'), ('opb@t.local','OPB'), ('opc@t.local','OPC'),
  ('opd@t.local','OPD'), ('ope@t.local','OPE'), ('amanda.seibel@aelbra.com.br','AMANDA');

-- alunos com titulos (saldo = coalesce ficha/cobranca)
insert into public.acordos_titulos(aluno_id, situacao, valor_original, saldo_corrigido, valor_cobranca_ajustado)
select a, 'ABERTO', v, v, adj from (values
  ('00000000-0000-0000-0000-00000000a001'::uuid, 1000::numeric, 800::numeric),   -- ajustado 800 (ficha/cobranca)
  ('00000000-0000-0000-0000-00000000a002'::uuid, 500, null),
  ('00000000-0000-0000-0000-00000000a003'::uuid, 500, null),
  ('00000000-0000-0000-0000-00000000a004'::uuid, 500, null),
  ('00000000-0000-0000-0000-00000000a005'::uuid, 300, null),
  ('00000000-0000-0000-0000-00000000a006'::uuid, 300, null),
  ('00000000-0000-0000-0000-00000000a007'::uuid, 400, null),
  ('00000000-0000-0000-0000-00000000a008'::uuid, 400, null),
  ('00000000-0000-0000-0000-00000000a009'::uuid, 700, null),
  ('00000000-0000-0000-0000-00000000a00a'::uuid, 150, null),
  ('00000000-0000-0000-0000-00000000a00b'::uuid, 400, null)   -- NE da secao 11
) t(a, v, adj);

-- OPA: A1 (acordo fechado, conta), A2 (normal, conta), A3 (encerrado, nao conta)
insert into public.casos(id, aluno_id, cpf_limpo, nome, operador_email, operador_nome, status_atual, status_acionamento)
values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000a001','111','A1','opa@t.local','OPA','Acordo em dia','ACORDO FECHADO'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000a002','112','A2','opa@t.local','OPA','Sem contato',null),
 ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000a003','113','A3','opa@t.local','OPA','ENCERRADO',null);

-- Livres para reposicao (sem dono)
insert into public.casos(id, aluno_id, cpf_limpo, nome, status_atual) values
 ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000a00a','901','L1','Sem contato'),
 ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000a00a','902','L2','Sem contato'),
 ('20000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000a00a','903','L3','Sem contato');

-- ---------------------------------------------------- 1. OCUPACAO ----------
do $$
begin
  perform pg_temp.afirma(public.nivelamento_ocupacao('opa@t.local') = 2,
    'ocupacao conta acordo e exclui encerrado (esperado 2)');
  perform pg_temp.afirma(public.nivelamento_acionaveis('opa@t.local') = 1,
    'acionaveis exclui protegido (esperado 1)');
end $$;

-- ---------------------------------------------------- 2. SALDO CENTAVOS ----
do $$
begin
  perform pg_temp.afirma(public.nivelamento_saldo_caso_centavos('10000000-0000-0000-0000-000000000001') = 80000,
    'saldo usa valor_cobranca_ajustado (800,00 = 80000 centavos), nao saldo original');
  perform pg_temp.afirma(public.nivelamento_saldo_caso_centavos('10000000-0000-0000-0000-000000000002') = 50000,
    'saldo sem ajuste usa saldo_corrigido (500,00)');
end $$;

-- ---------------------------------------- 3. NEGOCIACAO NAO REPOE ----------
do $$
declare r jsonb;
begin
  r := public.nivelamento_reposicao_por_baixas(50);
  perform pg_temp.afirma((r->>'reposicoes_aplicadas')::int = 0,
    'sem baixa REALIZADA: zero reposicoes (acordo/negociacao nao libera vaga)');
  perform pg_temp.afirma(not exists (select 1 from public.calibragem_auditoria
                                      where evento = 'REPOSICAO_V2' and caso_id = '10000000-0000-0000-0000-000000000001'),
    'acordo fechado nao gera REPOSICAO_V2');
end $$;

-- ------------------------------------------ 4. REPOSICAO POR BAIXA ----------
insert into public.baixas_pagamento(aluno_id, aluno_cpf, valor_pago, status_baixa, baixado_em)
values ('a', '111', 100, 'REALIZADA', now());

do $$
declare r jsonb; v_owner text;
begin
  r := public.nivelamento_reposicao_por_baixas(50);
  perform pg_temp.afirma((r->>'reposicoes_aplicadas')::int = 1,
    'baixa REALIZADA de capacidade livre gera exatamente 1 reposicao');
  select operador_email into v_owner from public.casos where id = '20000000-0000-0000-0000-000000000001';
  perform pg_temp.afirma(v_owner = 'opa@t.local', 'reposicao entregue ao operador do pagamento (opa)');
  r := public.nivelamento_reposicao_por_baixas(50);
  perform pg_temp.afirma((r->>'reposicoes_aplicadas')::int = 0,
    'segunda rodada nao repete a mesma baixa (idempotencia)');
end $$;

-- ------------------------------------------ 5. MESMO PAGAMENTO (MESMO LINK) ------
insert into public.casos(id, aluno_id, cpf_limpo, nome, status_atual) values
  ('20000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-00000000a00a','961','L6','Sem contato');
-- Duas baixas do MESMO link de pagamento = um pagamento. Uma reposicao, uma duplicata.
insert into public.baixas_pagamento(id, aluno_id, aluno_cpf, solicitacao_link_id, valor_pago, status_baixa, baixado_em)
values ('90000000-0000-0000-0000-000000000001','a','111','a0000000-0000-0000-0000-000000000001',100,'REALIZADA',now()),
       ('90000000-0000-0000-0000-000000000002','a','111','a0000000-0000-0000-0000-000000000001',100,'REALIZADA',now());

do $$
declare r jsonb;
begin
  r := public.nivelamento_reposicao_por_baixas(50);
  perform pg_temp.afirma((r->>'reposicoes_aplicadas')::int = 1,
    'mesmo link: UMA reposicao (a primeira baixa), a segunda nao gera outra');
  perform pg_temp.afirma((select count(*) from public.calibragem_auditoria
                           where evento='REPOSICAO_V2_DUPLICADA') = 1,
    'mesmo link: segunda baixa registrada como REPOSICAO_V2_DUPLICADA');
  perform pg_temp.afirma((select count(*) from public.casos where id in ('20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000003') and operador_email = 'opa@t.local') = 1,
    'exatamente UM caso livre recebeu o pagamento (sem duplicar)');
end $$;

-- ------------------------------------ 5b. PAGAMENTOS DISTINTOS, MESMO CPF/VALOR/DIA
insert into public.baixas_pagamento(id, aluno_id, aluno_cpf, solicitacao_link_id, valor_pago, status_baixa, baixado_em)
values ('90000000-0000-0000-0000-000000000003','a','111','a0000000-0000-0000-0000-000000000002',100,'REALIZADA',now()),
       ('90000000-0000-0000-0000-000000000004','a','111','a0000000-0000-0000-0000-000000000003',100,'REALIZADA',now());

do $$
declare r jsonb;
begin
  r := public.nivelamento_reposicao_por_baixas(50);
  perform pg_temp.afirma((r->>'reposicoes_aplicadas')::int = 2,
    'dois pagamentos distintos (links diferentes), mesmo cpf/valor/dia: DUAS reposicoes (nao suprime evento legitimo)');
end $$;

-- ---------------------------------------- 6. OPERADOR ACIMA DO TETO ---------
update public.calibragem_parametros set valor = to_jsonb(2) where chave = 'limite_carteira';
insert into public.baixas_pagamento(id, aluno_id, aluno_cpf, valor_pago, status_baixa, baixado_em)
values ('90000000-0000-0000-0000-000000000005','a','111',50,'REALIZADA',now());

do $$
declare r jsonb;
begin
  r := public.nivelamento_reposicao_por_baixas(50);
  perform pg_temp.afirma((r->>'reposicoes_aplicadas')::int = 0,
    'operador no teto (2 de 2): baixa nao gera reposicao');
  perform pg_temp.afirma(exists (select 1 from public.calibragem_auditoria where evento = 'REPOSICAO_V2_SEM_VAGA'),
    'baixa sem vaga registrada como REPOSICAO_V2_SEM_VAGA');
end $$;

-- 6b. SEM CREDITO: a baixa recebida no teto NAO vira reposicao quando a vaga abrir.
update public.calibragem_parametros set valor = to_jsonb(700) where chave = 'limite_carteira';
insert into public.casos(id, aluno_id, cpf_limpo, nome, status_atual) values
  ('20000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-00000000a00a','959','L9','Sem contato');
do $$
declare r jsonb;
begin
  r := public.nivelamento_reposicao_por_baixas(50);
  perform pg_temp.afirma((r->>'reposicoes_aplicadas')::int = 0,
    '6b: vaga abriu depois, mas a baixa ja processada no teto NAO gera credito (zero reposicao)');
  perform pg_temp.afirma((select operador_email from public.casos where id = '20000000-0000-0000-0000-000000000009') is null,
    '6b: caso livre permanece livre (nenhum credito acumulado)');
end $$;

-- ------------------------------------------ 7. BAIXA HISTORICA E STATUS -----
insert into public.baixas_pagamento(aluno_id, aluno_cpf, valor_pago, status_baixa, baixado_em)
values ('a','111',70,'REALIZADA','2020-01-01'),       -- anterior ao corte
       ('a','111',80,'DEVOLVIDA', now());              -- nao realizada

do $$
declare r jsonb;
begin
  r := public.nivelamento_reposicao_por_baixas(50);
  perform pg_temp.afirma((r->>'reposicoes_aplicadas')::int = 0,
    'baixa historica (antes do corte) e baixa DEVOLVIDA nao geram reposicao');
  perform pg_temp.afirma(not exists (select 1 from public.calibragem_auditoria a
                                      join public.baixas_pagamento b on a.situacao_posterior->>'baixa_id' = b.id::text
                                     where b.baixado_em < '2020-02-01'),
    'baixa historica nao foi nem processada');
end $$;

-- ---------------------------------- 8b. SIMULACAO SEM JWT NAO AUTORIZA (gate 2)
do $$
begin
  begin
    perform public.calibragem_simular_teste();
    raise exception 'FALHOU: simulacao sem JWT passou';
  exception when sqlstate '42501' then
    raise notice 'OK: simulacao sem JWT recusada apos o gate (forma 2 removida)';
  end;
end $$;

-- ------------------------------------ 9. TROCA NO TETO, MESMO SALDO -------
update public.calibragem_parametros set valor = to_jsonb(2) where chave = 'limite_carteira';
insert into public.usuarios(email,nome) values ('opc@t.local','OPC') on conflict do nothing;
insert into public.casos(id, aluno_id, cpf_limpo, nome, operador_email, operador_nome, status_atual) values
 ('30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000a002','301','C1','opc@t.local','OPC','Sem contato'),
 ('30000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000a003','302','C2','opc@t.local','OPC','Sem contato'),
 ('30000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000a004','303','NC','null','x','Sem contato');
update public.casos set operador_email = null, operador_nome = null where id = '30000000-0000-0000-0000-000000000003';

do $$
declare r record; v_antes int; v_depois int; v_troca uuid;
begin
  perform set_config('teste.email', 'opc@t.local', false);
  v_antes := public.nivelamento_ocupacao('opc@t.local');
  select * into r from public.assumir_caso_livre('30000000-0000-0000-0000-000000000003');
  perform set_config('teste.email', '', false);
  perform pg_temp.afirma(r.sucesso, 'assumir no teto com par de mesmo saldo: sucesso');
  v_depois := public.nivelamento_ocupacao('opc@t.local');
  perform pg_temp.afirma(v_antes = v_depois, 'carteira nao aumenta (troca 1 por 1)');
  perform pg_temp.afirma(r.caso_liberado in ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002'),
    'caso liberado e um caso de OPC com mesmo saldo');
  select caso_compensacao_id into v_troca from public.calibragem_auditoria
   where evento = 'TROCA_V2_ENTRADA' and caso_id = '30000000-0000-0000-0000-000000000003';
  perform pg_temp.afirma(v_troca is not null, 'entrada registrada com caso compensado');
  perform pg_temp.afirma(exists (select 1 from public.calibragem_auditoria
           where evento = 'TROCA_V2_SAIDA' and caso_id = r.caso_liberado
             and situacao_posterior->>'troca_id' = (select situacao_posterior->>'troca_id' from public.calibragem_auditoria
                                                     where evento='TROCA_V2_ENTRADA' and caso_id='30000000-0000-0000-0000-000000000003')),
    'saida registrada com o MESMO troca_id da entrada');
end $$;

-- --------------------------------- 10. SEM CORRESPONDENTE: NAO PARCIAL -------
insert into public.usuarios(email,nome) values ('opd@t.local','OPD') on conflict do nothing;
insert into public.casos(id, aluno_id, cpf_limpo, nome, operador_email, operador_nome, status_atual) values
 ('40000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000a005','401','D1','opd@t.local','OPD','Sem contato'),
 ('40000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000a006','402','D2','opd@t.local','OPD','Sem contato'),
 ('40000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000a009','403','ND','null','x','Sem contato');
update public.casos set operador_email = null, operador_nome = null where id = '40000000-0000-0000-0000-000000000003';

do $$
declare r record; v_n int;
begin
  perform set_config('teste.email', 'opd@t.local', false);
  select * into r from public.assumir_caso_livre('40000000-0000-0000-0000-000000000003');
  perform set_config('teste.email', '', false);
  perform pg_temp.afirma(r.sucesso = false, 'sem caso de mesmo saldo: recusa (sucesso = false)');
  select count(*) into v_n from public.casos where operador_email = 'opd@t.local';
  perform pg_temp.afirma(v_n = 2, 'sem troca parcial: carteira do OPD intacta (2 casos)');
  perform pg_temp.afirma((select operador_email from public.casos where id='40000000-0000-0000-0000-000000000003') is null,
    'caso pretendido continua livre');
  perform pg_temp.afirma(not exists (select 1 from public.calibragem_auditoria
           where caso_id in ('40000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002')
             and evento like 'TROCA_V2%'),
    'nenhuma movimentacao de troca registrada na recusa');
end $$;

-- ------------------------------------ 11. PROTECAO: SAIDA NUNCA PROTEGIDA ---
insert into public.usuarios(email,nome) values ('ope@t.local','OPE') on conflict do nothing;
insert into public.casos(id, aluno_id, cpf_limpo, nome, operador_email, operador_nome, status_atual, status_acionamento) values
 ('50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000a007','501','E1','ope@t.local','OPE','Acordo em dia','ACORDO FECHADO'),
 ('50000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000a008','502','E2','ope@t.local','OPE','Sem contato',null),
 ('50000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000a00b','503','NE','null','x','Sem contato',null);
update public.casos set operador_email = null, operador_nome = null where id = '50000000-0000-0000-0000-000000000003';

do $$
declare r record;
begin
  perform set_config('teste.email', 'ope@t.local', false);
  select * into r from public.assumir_caso_livre('50000000-0000-0000-0000-000000000003');
  perform set_config('teste.email', '', false);
  perform pg_temp.afirma(r.sucesso and r.caso_liberado = '50000000-0000-0000-0000-000000000002',
    'troca escolhe o caso NORMAL (E2) e nunca o caso protegido (E1)');
  perform pg_temp.afirma((select operador_email from public.casos where id='50000000-0000-0000-0000-000000000001') = 'ope@t.local',
    'caso protegido (acordo) permanece com o operador');
end $$;

-- ------------------------------------- 12. CRON E CUTOVER (estado pos-migration)
do $$
begin
  perform pg_temp.afirma(not exists (select 1 from cron.job where jobid = 48),
    'job 48 antigo desativado (removido do agendamento)');
  perform pg_temp.afirma(exists (select 1 from cron.job where jobname = 'nivelamento_v2_reposicao'
                                                          and schedule = '7 * * * *'),
    'reposicao V2 agendada a cada hora (minuto 7)');
  perform pg_temp.afirma(exists (select 1 from public.nivelamento_v2_backup where nome = 'cron:48'),
    'backup do job 48 gravado para rollback');
end $$;

-- ---------------------------------------- 14. CORTE PERTENCE A MIGRATION ----
do $$
begin
  perform pg_temp.afirma(exists (select 1 from public.calibragem_parametros where chave = 'nivelamento_v2_desde'),
    'corte nivelamento_v2_desde gravado pela migration');
end $$;
