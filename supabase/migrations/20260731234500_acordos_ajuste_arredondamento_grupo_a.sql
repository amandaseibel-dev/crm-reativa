-- Ajuste de arredondamento (<= R$0,05) em 5 acordos antigos (nº 2,8,9,10,11).
-- Diferenca acumulada em 10 parcelas; ajusta APENAS a ultima parcela em aberto (#10),
-- sem tocar a parcela paga (#1). Backup das parcelas + auditoria.
create table if not exists public._backup_parcelas_ajuste_arred (
  parcela_id uuid, acordo_id uuid, numero int, valor_old numeric, valor_new numeric,
  lote text, executado_por text, criado_em timestamptz default now()
);
with alvo as (
  select a.id acordo_id, a.valor_total,
         (select round(sum(p.valor),2) from public.parcelas p where p.acordo_id=a.id) soma
  from public.acordos a
  where a.numero_acordo in (2,8,9,10,11)
),
ult as (
  select al.acordo_id, al.valor_total, al.soma,
         (select p.id from public.parcelas p where p.acordo_id=al.acordo_id and p.status<>'PAGO' order by p.numero desc limit 1) parcela_id
  from alvo al
  where abs(al.soma-al.valor_total) between 0.0001 and 0.05
)
insert into public._backup_parcelas_ajuste_arred(parcela_id,acordo_id,numero,valor_old,valor_new,lote,executado_por)
select p.id, p.acordo_id, p.numero, p.valor,
       round(p.valor + (u.valor_total - u.soma),2),
       'arred_20260731','amanda.seibel@aelbra.com.br'
from ult u join public.parcelas p on p.id=u.parcela_id
where not exists (select 1 from public._backup_parcelas_ajuste_arred b where b.parcela_id=p.id and b.lote='arred_20260731');
update public.parcelas p
set valor = b.valor_new, atualizado_em=now(),
    observacao = coalesce(observacao,'')||' | ajuste arredondamento <=R$0,05 (lote arred_20260731) p/ soma=valor_total'
from public._backup_parcelas_ajuste_arred b
where b.parcela_id=p.id and b.lote='arred_20260731' and p.valor=b.valor_old;
