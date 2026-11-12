-- ROLLBACK: conferencia depois de aplicar o rollback da migration.
\set ON_ERROR_STOP on
drop table if exists _rb;
create table _rb (n text, caso text, esperado text, obtido text);
insert into _rb values ('R1','indice antigo volta','1',
  (select count(*)::text from pg_indexes where tablename='receptivo_atendimentos_log' and indexname='uq_receptivo_log_operador_ciclo'));
insert into _rb values ('R2','indice novo sai','0',
  (select count(*)::text from pg_indexes where tablename='receptivo_atendimentos_log' and indexname in ('uq_receptivo_log_operador_conversa_ciclo','uq_receptivo_log_operador_ciclo_legado')));
insert into _rb values ('R3','historico preservado (todas as linhas da foto antes continuam)',
  (select count(*)::text from _snap_antes),
  (select count(*)::text from public.receptivo_atendimentos_log l join _snap_antes s using (id)));
insert into _rb values ('R4','coluna conversa_id nao foi apagada','1',
  (select count(*)::text from information_schema.columns where table_name='receptivo_atendimentos_log' and column_name='conversa_id'));
insert into _rb values ('R5','grants: registrar segue sem authenticated','false',
  has_function_privilege('authenticated','public.fila_receptivo_registrar_atendimento(text,uuid)','EXECUTE')::text);
select n, caso, esperado, obtido, case when obtido is not distinct from esperado then 'OK' else 'FALHOU' end as veredito from _rb order by n;
do $f$ declare v integer; begin
  select count(*) into v from _rb where obtido is distinct from esperado;
  raise notice 'ROLLBACK RECEPTIVO: % falhas', v;
  if v > 0 then raise exception '% asserções falharam', v using errcode='22023'; end if;
end $f$;
