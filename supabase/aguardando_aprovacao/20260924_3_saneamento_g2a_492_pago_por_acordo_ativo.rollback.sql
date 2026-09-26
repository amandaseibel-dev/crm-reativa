-- ============================================================================
-- ROLLBACK do arquivo 3 (G2-A, 492 titulos) -- determinístico, por ID
-- ============================================================================
-- Devolve cada titulo ao estado EXATO gravado em
-- `_backup_saneamento_g2a_20260924`: PAGO/quitada, com o motivo_ajuste, o
-- acordo_id e a proveniencia que tinham antes (que era NULA -- por isso o
-- rollback deixa `quitacao_origem` nulo de novo, e nao 'ACORDO').
--
-- So reverte quem esta hoje no estado que o saneamento deixou
-- (NEGOCIADO/vinculada). Titulo que alguem mexeu depois NAO e tocado e sai
-- listado no fim, para conferencia a mao.
--
-- Nao apaga pagamento, nao apaga vinculo, nao toca em parcela nem em acordo.
-- ============================================================================

begin;

do $$
declare v_qtd int;
begin
  select count(*) into v_qtd from public._backup_saneamento_g2a_20260924;
  if v_qtd <> 492 then
    raise exception 'ABORTA: backup tem % linhas, esperado 492 -- confira a tabela antes', v_qtd;
  end if;
end $$;

create temporary table _g2a_rev on commit drop as
select b.titulo_id
  from public._backup_saneamento_g2a_20260924 b
  join public.acordos_titulos t on t.id = b.titulo_id
 where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
   and lower(coalesce(t.status,'')) = 'vinculada';

update public.acordos_titulos t
   set situacao   = b.situacao_anterior,
       status     = b.status_anterior,
       acordo_id  = b.acordo_id_anterior,
       motivo_ajuste = b.motivo_ajuste_anterior,
       quitacao_origem = b.quitacao_origem_anterior,
       quitacao_origem_acordo_id = b.quitacao_origem_acordo_id_anterior,
       quitacao_origem_em = null,
       atualizado_em = now()
  from public._backup_saneamento_g2a_20260924 b
 where t.id = b.titulo_id
   and t.id in (select titulo_id from _g2a_rev);

do $$
declare v_rev int; v_rec int; v_ok int;
begin
  select count(*) into v_rev from _g2a_rev;

  select count(*) into v_ok
    from public._backup_saneamento_g2a_20260924 b
    join public.acordos_titulos t on t.id = b.titulo_id
   where t.id in (select titulo_id from _g2a_rev)
     and upper(coalesce(t.situacao,'')) = 'PAGO'
     and lower(coalesce(t.status,'')) = 'quitada';
  if v_ok <> v_rev then
    raise exception 'ABORTA: % de % titulo(s) nao voltaram para PAGO/quitada', v_ok, v_rev;
  end if;

  select count(*) into v_rec from public._backup_saneamento_g2a_20260924 b
   where b.titulo_id not in (select titulo_id from _g2a_rev);
  raise notice 'REVERTIDOS: % | RECUSADOS (estado mudou depois, conferir a mao): %', v_rev, v_rec;
end $$;

select b.titulo_id, b.acordo_numero,
       b.situacao_anterior, b.status_anterior,
       t.situacao as situacao_hoje, t.status as status_hoje
  from public._backup_saneamento_g2a_20260924 b
  join public.acordos_titulos t on t.id = b.titulo_id
 where not (upper(coalesce(t.situacao,'')) = 'PAGO' and lower(coalesce(t.status,'')) = 'quitada');

commit;

-- A tabela de backup NAO e derrubada: ela e a prova do que foi feito.
--   drop table public._backup_saneamento_g2a_20260924;
