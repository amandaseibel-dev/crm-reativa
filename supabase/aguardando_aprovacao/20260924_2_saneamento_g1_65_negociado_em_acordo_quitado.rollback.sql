-- ============================================================================
-- ROLLBACK do arquivo 2 (G1, 65 titulos) -- determinístico, por ID
-- ============================================================================
-- Restaura EXATAMENTE o que foi gravado em `_backup_saneamento_g1_20260924`,
-- titulo por titulo, e so para quem esta hoje no estado que o saneamento
-- deixou (PAGO/quitada). Titulo que alguem mexeu depois NAO e tocado -- ele
-- aparece na lista de recusados no fim.
--
-- Nao apaga pagamento, nao apaga vinculo, nao toca em parcela, nao toca em
-- acordo. So devolve situacao/status/acordo_id/motivo/proveniencia do titulo.
-- ============================================================================

begin;

do $$
declare v_qtd int;
begin
  select count(*) into v_qtd from public._backup_saneamento_g1_20260924;
  if v_qtd <> 65 then
    raise exception 'ABORTA: backup tem % linhas, esperado 65 -- confira a tabela antes', v_qtd;
  end if;
end $$;

-- quem esta no estado deixado pelo saneamento e pode voltar
create temporary table _g1_rev on commit drop as
select b.titulo_id
  from public._backup_saneamento_g1_20260924 b
  join public.acordos_titulos t on t.id = b.titulo_id
 where upper(coalesce(t.situacao,'')) = 'PAGO'
   and lower(coalesce(t.status,'')) = 'quitada';

update public.acordos_titulos t
   set situacao   = b.situacao_anterior,
       status     = b.status_anterior,
       acordo_id  = b.acordo_id_anterior,
       motivo_ajuste = b.motivo_ajuste_anterior,
       quitacao_origem = b.quitacao_origem_anterior,
       quitacao_origem_acordo_id = b.quitacao_origem_acordo_id_anterior,
       quitacao_origem_em = null,
       atualizado_em = now()
  from public._backup_saneamento_g1_20260924 b
 where t.id = b.titulo_id
   and t.id in (select titulo_id from _g1_rev);

-- relatorio: revertidos x recusados (mexidos por outra coisa depois)
do $$
declare v_rev int; v_rec int;
begin
  select count(*) into v_rev from _g1_rev;
  select count(*) into v_rec from public._backup_saneamento_g1_20260924 b
   where b.titulo_id not in (select titulo_id from _g1_rev);
  raise notice 'REVERTIDOS: % | RECUSADOS (estado mudou depois, conferir a mao): %', v_rev, v_rec;
end $$;

-- lista dos recusados, para conferencia manual
select b.titulo_id,
       b.situacao_anterior, b.status_anterior,
       t.situacao as situacao_hoje, t.status as status_hoje
  from public._backup_saneamento_g1_20260924 b
  join public.acordos_titulos t on t.id = b.titulo_id
 where not (upper(coalesce(t.situacao,'')) = 'PAGO' and lower(coalesce(t.status,'')) = 'quitada');

commit;

-- A tabela de backup NAO e derrubada: ela e a prova do que foi feito.
-- Para descartar depois de tudo conferido:
--   drop table public._backup_saneamento_g1_20260924;
