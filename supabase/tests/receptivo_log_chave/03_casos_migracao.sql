-- DEPOIS da migration. Cada caso e uma asserção; falha = RAISE.
\set ON_ERROR_STOP on
drop table if exists _res;
create table _res (n text, caso text, esperado text, obtido text);

-- C1: mesmo instante, conversas diferentes -> contam separadamente
insert into public.whatsapp_conversas (id, telefone_e164, responsavel_email, responsavel_desde) values
  ('00000000-0000-0000-0000-00000000e001','5551920000001','op_b@test.local', timestamptz '2026-11-12 09:00:00-03'),
  ('00000000-0000-0000-0000-00000000e002','5551920000002','op_b@test.local', timestamptz '2026-11-12 09:00:00-03');
begin;
select public.fila_receptivo_registrar_atendimento('op_b@test.local','00000000-0000-0000-0000-00000000e001');
select public.fila_receptivo_registrar_atendimento('op_b@test.local','00000000-0000-0000-0000-00000000e002');
commit;
insert into _res values ('C1','mesmo instante, duas conversas: 2 linhas','2',
  (select count(*)::text from public.receptivo_atendimentos_log
    where operador_email='op_b@test.local' and responsavel_desde = timestamptz '2026-11-12 09:00:00-03'));
insert into _res values ('C1b','fila andou 2 (uma por conversa)','2',
  (select atendimentos_hoje::text from public.fila_receptivo where email='op_b@test.local'));

-- C2: mesma conversa, mesmo ciclo, respostas repetidas -> conta UMA vez
select public.fila_receptivo_registrar_atendimento('op_b@test.local','00000000-0000-0000-0000-00000000e001');
select public.fila_receptivo_registrar_atendimento('op_b@test.local','00000000-0000-0000-0000-00000000e001');
insert into _res values ('C2','mesma conversa/ciclo repetida: continua 1 linha da conversa e1','1',
  (select count(*)::text from public.receptivo_atendimentos_log
    where conversa_id='00000000-0000-0000-0000-00000000e001'));

-- C3: novo ciclo valido da mesma conversa -> conta de novo
update public.whatsapp_conversas set responsavel_desde = timestamptz '2026-11-12 15:00:00-03'
 where id='00000000-0000-0000-0000-00000000e001';
select public.fila_receptivo_registrar_atendimento('op_b@test.local','00000000-0000-0000-0000-00000000e001');
insert into _res values ('C3','novo ciclo da mesma conversa conta de novo: 2 linhas','2',
  (select count(*)::text from public.receptivo_atendimentos_log
    where conversa_id='00000000-0000-0000-0000-00000000e001'));

-- C4: manual (sem conversa) sempre conta
select public.fila_receptivo_registrar_atendimento('op_b@test.local');
select public.fila_receptivo_registrar_atendimento('op_b@test.local');
insert into _res values ('C4','manual nao e deduplicado: 2 linhas MANUAL novas','2',
  (select count(*)::text from public.receptivo_atendimentos_log
    where operador_email='op_b@test.local' and fonte='MANUAL' and atendido_em > now() - interval '1 hour'));

-- C5: historico preservado (nenhuma linha antiga sumiu nem mudou de ciclo/fonte)
insert into _res values ('C5','historico: todas as linhas anteriores continuam',
  (select count(*)::text from _snap_antes),
  (select count(*)::text from public.receptivo_atendimentos_log l join _snap_antes s using (id)
    where l.operador_email=s.operador_email and l.responsavel_desde is not distinct from s.responsavel_desde
      and l.fonte=s.fonte));

-- C6: backfill conservador: h1 recebe conversa_id; h2/h3/h4 ficam NULL
insert into _res values ('C6a','h1 (ciclo com uma conversa atual) recebe conversa_id c001','00000000-0000-0000-0000-00000000c001',
  (select coalesce(conversa_id::text,'NULL') from public.receptivo_atendimentos_log
    where operador_email='op_a@test.local' and fonte='WHATSAPP' and responsavel_desde = timestamptz '2026-11-01 10:00:00-03'));
insert into _res values ('C6b','h2 (ciclo ambiguo, 2 conversas) fica NULL','NULL',
  (select coalesce(conversa_id::text,'NULL') from public.receptivo_atendimentos_log
    where operador_email='op_b@test.local' and fonte='WHATSAPP' and responsavel_desde = timestamptz '2026-11-03 10:00:00-03'));
insert into _res values ('C6c','h3 (sem conversa atual) fica NULL','NULL',
  (select coalesce(conversa_id::text,'NULL') from public.receptivo_atendimentos_log
    where operador_email='op_b@test.local' and fonte='WHATSAPP' and responsavel_desde = timestamptz '2026-10-01 09:00:00-03'));
insert into _res values ('C6d','h4 (MANUAL) fica NULL','NULL',
  (select coalesce(conversa_id::text,'NULL') from public.receptivo_atendimentos_log
    where fonte='MANUAL' and atendido_em = timestamptz '2026-10-02 11:00:00-03'));

-- C7: legado protegido: linha sem conversa nao duplica (op, ciclo)
do $c7$
begin
  begin
    insert into public.receptivo_atendimentos_log (operador_email, responsavel_desde, fonte)
      values ('op_b@test.local', timestamptz '2026-10-01 09:00:00-03', 'WHATSAPP');
    insert into _res values ('C7','legado: segunda linha sem conversa no mesmo (op, ciclo) e barrada','ERRO_UNICIDADE','INSERIU');
  exception when unique_violation then
    insert into _res values ('C7','legado: segunda linha sem conversa no mesmo (op, ciclo) e barrada','ERRO_UNICIDADE','ERRO_UNICIDADE');
  end;
end $c7$;

-- C8: mesmo instante em conversas diferentes NAO e barrado pela chave nova
insert into _res values ('C8','indice novo tem conversa_id na chave',
  'uq_receptivo_log_operador_conversa_ciclo',
  (select indexname from pg_indexes where tablename='receptivo_atendimentos_log'
     and indexname='uq_receptivo_log_operador_conversa_ciclo'));

-- C9: auditoria de grants e de indices
insert into _res values ('C9a','registrar: authenticated SEM execute','false',
  has_function_privilege('authenticated','public.fila_receptivo_registrar_atendimento(text,uuid)','EXECUTE')::text);
insert into _res values ('C9b','registrar: anon SEM execute','false',
  has_function_privilege('anon','public.fila_receptivo_registrar_atendimento(text,uuid)','EXECUTE')::text);
insert into _res values ('C9c','indice antigo removido','0',
  (select count(*)::text from pg_indexes where tablename='receptivo_atendimentos_log'
     and indexname='uq_receptivo_log_operador_ciclo'));
insert into _res values ('C9d','FK conversa_id existe','1',
  (select count(*)::text from pg_constraint where conrelid='public.receptivo_atendimentos_log'::regclass
     and conname='receptivo_atendimentos_log_conversa_fkey'));

select n, caso, esperado, obtido, case when obtido is not distinct from esperado then 'OK' else 'FALHOU' end as veredito
  from _res order by n;

do $final$
declare v_f integer; v_t integer;
begin
  select count(*) filter (where obtido is distinct from esperado), count(*) into v_f, v_t from _res;
  raise notice 'RECEPTIVO LOG CHAVE: % asserções, % falhas', v_t, v_f;
  if v_f > 0 then raise exception '% asserções falharam', v_f using errcode='22023'; end if;
end $final$;

-- C10: REPROCESSAMENTO. Ciclo ja contado por linha ANTIGA (conversa NULL) nao conta de novo,
--      mesmo depois de a conversa ganhar conversa_id (h2 e ambiguo: 2 candidatas, fica NULL).
do $c10$
declare v_antes integer; v_depois integer; r1 boolean; r2 boolean;
begin
  select count(*) into v_antes from public.receptivo_atendimentos_log where operador_email='op_b@test.local';
  r1 := public.fila_receptivo_registrar_atendimento('op_b@test.local','00000000-0000-0000-0000-00000000c003');
  r2 := public.fila_receptivo_registrar_atendimento('op_b@test.local','00000000-0000-0000-0000-00000000c004');
  select count(*) into v_depois from public.receptivo_atendimentos_log where operador_email='op_b@test.local';
  insert into _res values ('C10a','reprocessar ciclo ambiguo ja contado (linha antiga NULL) nao conta de novo','false|false',
    r1::text || '|' || r2::text);
  insert into _res values ('C10b','nenhuma linha nova para o ciclo reprocessado','0', (v_depois - v_antes)::text);
end $c10$;

-- C11: reprocessar a conversa JA vinculada (c001, historico com conversa_id) nao duplica
do $c11$
declare v_antes integer; v_depois integer;
begin
  select count(*) into v_antes from public.receptivo_atendimentos_log where conversa_id='00000000-0000-0000-0000-00000000c001';
  perform public.fila_receptivo_registrar_atendimento('op_a@test.local','00000000-0000-0000-0000-00000000c001');
  select count(*) into v_depois from public.receptivo_atendimentos_log where conversa_id='00000000-0000-0000-0000-00000000c001';
  insert into _res values ('C11','reprocessar historico ja vinculado nao duplica','0', (v_depois - v_antes)::text);
end $c11$;

do $final2$
declare v_f integer; v_t integer;
begin
  select count(*) filter (where obtido is distinct from esperado), count(*) into v_f, v_t from _res;
  raise notice 'RECEPTIVO LOG CHAVE (com reprocessamento): % asserções, % falhas', v_t, v_f;
  if v_f > 0 then raise exception '% asserções falharam', v_f using errcode='22023'; end if;
end $final2$;
