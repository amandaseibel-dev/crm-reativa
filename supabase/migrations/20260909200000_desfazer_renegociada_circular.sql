-- ERRO MEU, DESFEITO. A "dobra do re-acordo" nao existia.
--
-- Eu li o titulo com tipo_boleto='Acordo' e documento = '0' || boleto da parcela
-- como sendo a parcela renegociada NUM ACORDO NOVO. Errado: em 273 dos 279
-- casos esse titulo pertence ao PROPRIO acordo da parcela. Nao e renegociacao --
-- e o mesmo boleto representado nas duas tabelas.
--
-- Consequencia: a migration 20260909160000 marcou 273 parcelas como RENEGOCIADA
-- e tirou R$ 275.623,06 de divida LEGITIMA da carteira. A ficha da Ana Carolina
-- Marins da Silva (acordo 53016, parcela 5 apontando para o proprio 53016) foi
-- o que expos isso -- uma ficha derrubou uma conclusao que 382 casamentos nao
-- derrubaram. Ver docs/ANTES_DE_APLICAR_UMA_REGRA.md.
--
-- Renegociacao de verdade e so quando o titulo esta vinculado a um acordo
-- DIFERENTE e esse acordo TEM pagamento: 5 casos, R$ 2.301,55.

create table if not exists public._backup_renegociada_circular_20260909 as
select p.id, p.acordo_id, p.status, p.renegociada_em, p.renegociada_no_acordo_id, now() as em
  from public.parcelas p where false;
alter table public._backup_renegociada_circular_20260909 enable row level security;
drop policy if exists sem_acesso on public._backup_renegociada_circular_20260909;
create policy sem_acesso on public._backup_renegociada_circular_20260909 for select using (false);

insert into public._backup_renegociada_circular_20260909
  (id, acordo_id, status, renegociada_em, renegociada_no_acordo_id, em)
select p.id, p.acordo_id, p.status, p.renegociada_em, p.renegociada_no_acordo_id, now()
  from public.parcelas p
 where p.status = 'RENEGOCIADA'
   and (p.renegociada_no_acordo_id = p.acordo_id
        or not exists (select 1 from public.parcelas p2
                        where p2.acordo_id = p.renegociada_no_acordo_id and p2.status = 'PAGO'));

update public.parcelas p
   set status = coalesce(b.status, case when p.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end),
       renegociada_em = null, renegociada_no_acordo_id = null, atualizado_em = now()
  from public._backup_parcela_re_acordo_20260909 b
 where b.id = p.id
   and p.id in (select id from public._backup_renegociada_circular_20260909);

update public.parcelas p
   set status = case when p.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
       renegociada_em = null, renegociada_no_acordo_id = null, atualizado_em = now()
 where p.status = 'RENEGOCIADA'
   and p.id in (select id from public._backup_renegociada_circular_20260909);

update public.acordos a
   set saldo = coalesce((select sum(p.valor) from public.parcelas p
                          where p.acordo_id = a.id and p.status in ('A_VENCER','VENCIDA')), 0),
       atualizado_em = now()
 where a.id in (select distinct acordo_id from public._backup_renegociada_circular_20260909);

update public.fluxo_acordos_config
   set explicacao = 'A parcela cujo boleto virou titulo negociado NUM ACORDO DIFERENTE, e que TEM pagamento, recebe o vinculo e o estado RENEGOCIADA. Nao cancela. ARMADILHA: em 273 de 279 casos o titulo pertence ao PROPRIO acordo -- nao e renegociacao, e o mesmo boleto nas duas tabelas. Sem a trava do acordo diferente, isso apaga divida legitima.'
 where etapa = 'parcela_re_acordada';

update public.invariante_config
   set explicacao = 'A parcela virou titulo e entrou num acordo DIFERENTE que TEM pagamento, mas continua VENCIDA ou A_VENCER no acordo antigo. Titulo do proprio acordo NAO conta: e o mesmo boleto nas duas tabelas.',
       base_09_09 = '5 casos reais (nao 278: os outros eram leitura errada minha)'
 where nome = 'parcela_re_acordada_ainda_cobrando';

-- As duas travas que faltavam, no fluxo e no vigia.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.fluxo_acordos_rodar(boolean)'::regprocedure);
  d := replace(d,
    'where p.boleto is not null and p.status in (''VENCIDA'',''A_VENCER'')
             and nv.status in (''ATIVO'',''QUITADO''))',
    'where p.boleto is not null and p.status in (''VENCIDA'',''A_VENCER'')
             and nv.status in (''ATIVO'',''QUITADO'')
             and nv.id <> p.acordo_id
             and exists (select 1 from public.parcelas pp
                          where pp.acordo_id = nv.id and pp.status = ''PAGO''))');
  d := replace(d,
    'where p.boleto is not null and p.status in (''VENCIDA'',''A_VENCER'')
           and nv.status in (''ATIVO'',''QUITADO'');',
    'where p.boleto is not null and p.status in (''VENCIDA'',''A_VENCER'')
           and nv.status in (''ATIVO'',''QUITADO'')
           and nv.id <> p.acordo_id
           and exists (select 1 from public.parcelas pp
                        where pp.acordo_id = nv.id and pp.status = ''PAGO'');');
  if position('nv.id <> p.acordo_id' in d) = 0 then
    raise exception 'MIGRATION ABORTADA: nao consegui inserir a trava do acordo diferente.';
  end if;
  execute d;
end $mig$;

do $mig2$
declare d text;
begin
  d := pg_get_functiondef('public.invariantes_rodar(text)'::regprocedure);
  d := replace(d,
    'where p.boleto is not null and p.status in (''VENCIDA'',''A_VENCER'')
           and nv.status in (''ATIVO'',''QUITADO'');',
    'where p.boleto is not null and p.status in (''VENCIDA'',''A_VENCER'')
           and nv.status in (''ATIVO'',''QUITADO'')
           and nv.id <> p.acordo_id
           and exists (select 1 from public.parcelas pp
                        where pp.acordo_id = nv.id and pp.status = ''PAGO'');');
  execute d;
end $mig2$;
