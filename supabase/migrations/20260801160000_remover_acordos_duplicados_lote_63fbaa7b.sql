-- Remove 7 acordos duplicados (stubs recriados na importacao dupla do lote
-- 63fbaa7b, corrida entre chunks). Mantem o gemeo original (com eventual
-- pagamento). Backup preservado; corrige a dobra de saldo. Aplicada em prod.
create table if not exists public._backup_acordos_dup_20260801 as select * from public.acordos where false;
create table if not exists public._backup_parcelas_dup_20260801 as select * from public.parcelas where false;
insert into public._backup_acordos_dup_20260801
select * from public.acordos
where numero_acordo in (2558,2587,2652,2657,2666,2672,2686) and criado_por_email='importacao@sistema'
  and not exists (select 1 from public._backup_acordos_dup_20260801 b where b.id=acordos.id);
insert into public._backup_parcelas_dup_20260801
select p.* from public.parcelas p
where p.acordo_id in (select id from public.acordos where numero_acordo in (2558,2587,2652,2657,2666,2672,2686) and criado_por_email='importacao@sistema')
  and not exists (select 1 from public._backup_parcelas_dup_20260801 b where b.id=p.id);
delete from public.parcelas where acordo_id in (select id from public.acordos where numero_acordo in (2558,2587,2652,2657,2666,2672,2686) and criado_por_email='importacao@sistema');
delete from public.acordos where numero_acordo in (2558,2587,2652,2657,2666,2672,2686) and criado_por_email='importacao@sistema';
