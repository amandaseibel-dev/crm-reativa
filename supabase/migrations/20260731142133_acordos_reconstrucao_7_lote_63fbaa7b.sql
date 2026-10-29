-- Reconstrucao dos 7 acordos ATIVOS em revisao (lote 63fbaa7b), conciliados
-- individualmente por CPF+base contra a origem em quarentena
-- (_backup_parcelas_acordo_erro_import, importacao_id=63fbaa7b). A entrada (doc 01)
-- consta ABERTA na origem ("Titulos em Aberto"), logo integra a obrigacao: incluida
-- como parcela is_entrada=true. valor_total do cabecalho estava so com o parcelado
-- (bug do import) e e corrigido para entrada+parcelas. Backup + auditoria.
-- Nao usa o lote de risco 743aafd3 (filtrado por importacao_id).
create table if not exists public._backup_acordos_recon_63fbaa7b (
  acordo_id uuid, numero_acordo bigint, valor_total_old numeric,
  qtd_parcelas_old int, saldo_old numeric, snapshot jsonb, criado_em timestamptz default now()
);
insert into public._backup_acordos_recon_63fbaa7b(acordo_id,numero_acordo,valor_total_old,qtd_parcelas_old,saldo_old,snapshot)
select a.id,a.numero_acordo,a.valor_total,a.qtd_parcelas,a.saldo,to_jsonb(a.*)
from public.acordos a
join public.acordos_revisao_parcelas r on r.acordo_id=a.id
where not exists (select 1 from public._backup_acordos_recon_63fbaa7b b where b.acordo_id=a.id);
with rev as (
  select r.acordo_id, r.aluno_id, regexp_replace(coalesce(r.cpf,''),'\D','','g') cpf_n
  from public.acordos_revisao_parcelas r
),
src as (
  select rev.acordo_id, rev.aluno_id,
    right(regexp_replace(b.documento,'\D','','g'),2)::int numero,
    coalesce(b.valor_original,b.valor_em_aberto,0) valor,
    b.vencimento,
    (right(regexp_replace(b.documento,'\D','','g'),2)='01') is_entrada
  from rev
  join public._backup_parcelas_acordo_erro_import b
    on regexp_replace(coalesce(b.cpf,''),'\D','','g')=rev.cpf_n
   and b.importacao_id='63fbaa7b-9a3a-41de-aacf-156aa3b715db'
   and length(regexp_replace(coalesce(b.documento,''),'\D','','g'))>=10
)
insert into public.parcelas(id,acordo_id,numero,valor,vencimento,status,is_entrada,observacao,criado_em,atualizado_em)
select gen_random_uuid(), s.acordo_id, s.numero, s.valor, s.vencimento,
  case when s.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
  s.is_entrada,
  'Reconstruida da origem (lote 63fbaa7b, quarentena) - conciliacao individual CPF+base; entrada=doc 01 (ABERTA na origem).',
  now(), now()
from src s
where not exists (select 1 from public.parcelas p where p.acordo_id=s.acordo_id);
insert into public._backup_completar_parcelas_lote(lote,acordo_id,acao,parcela_id,executado_por)
select 'recon_63fbaa7b_20260731', p.acordo_id, 'PARCELA_CRIADA', p.id, 'amanda.seibel@aelbra.com.br'
from public.parcelas p
join public.acordos_revisao_parcelas r on r.acordo_id=p.acordo_id
where not exists (select 1 from public._backup_completar_parcelas_lote l where l.parcela_id=p.id and l.lote='recon_63fbaa7b_20260731');
with agg as (select acordo_id, round(sum(valor),2) tot, count(*) qtd from public.parcelas group by acordo_id)
update public.acordos a
set valor_total=agg.tot, saldo=agg.tot, qtd_parcelas=agg.qtd, atualizado_em=now()
from agg
join public.acordos_revisao_parcelas r on r.acordo_id=agg.acordo_id
where a.id=agg.acordo_id;
update public.acordos_revisao_parcelas r
set status='RESOLVIDO', resolvido_em=now(), resolvido_por='amanda.seibel@aelbra.com.br'
where r.status='PENDENTE'
  and exists (select 1 from public.parcelas p where p.acordo_id=r.acordo_id);
