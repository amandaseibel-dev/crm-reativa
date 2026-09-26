-- ============================================================================
-- ROLLBACK do arquivo 4 (caso Suelen), OPCAO 1 -- determinístico, por ID
-- ============================================================================
-- Devolve o vinculo para o acordo 3609 e o titulo para o estado gravado em
-- `_backup_saneamento_suelen_20260924`.
--
-- ATENCAO: reverter RESTAURA A DUPLA CONTAGEM de R$ 428,72 no saldo da aluna.
-- So faz sentido se a opcao 1 se mostrar errada.
-- ============================================================================

begin;

do $$
declare v_qtd int;
begin
  select count(*) into v_qtd from public._backup_saneamento_suelen_20260924
   where titulo_id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306';
  if v_qtd <> 1 then
    raise exception 'ABORTA: backup do caso Suelen nao encontrado';
  end if;

  -- so reverte se estiver no estado que a correcao deixou
  select count(*) into v_qtd from public.acordo_titulo_vinculo v
   where v.titulo_id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306'
     and v.acordo_id = '1e904398-dc1c-459c-956b-fdce05248f97';
  if v_qtd <> 1 then
    raise exception 'ABORTA: o vinculo nao esta no acordo 3528 -- alguem mexeu depois, conferir a mao';
  end if;
end $$;

update public.acordo_titulo_vinculo v
   set acordo_id = '2d310307-b610-45ab-9d02-2713cde83ad7'
 where v.titulo_id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306'
   and v.acordo_id = '1e904398-dc1c-459c-956b-fdce05248f97';

update public.acordos_titulos t
   set situacao = b.situacao_anterior,
       status = b.status_anterior,
       acordo_id = b.acordo_id_anterior,
       motivo_ajuste = b.motivo_ajuste_anterior,
       atualizado_em = now()
  from public._backup_saneamento_suelen_20260924 b
 where t.id = b.titulo_id
   and t.id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306';

do $$
declare v_falha int;
begin
  select count(*) into v_falha from public.acordos_titulos t
    join public._backup_saneamento_suelen_20260924 b on b.titulo_id = t.id
   where t.situacao is distinct from b.situacao_anterior
      or t.status is distinct from b.status_anterior
      or t.acordo_id is distinct from b.acordo_id_anterior;
  if v_falha > 0 then
    raise exception 'ABORTA: o titulo nao voltou ao estado do backup';
  end if;
  raise notice 'REVERTIDO: vinculo de volta no 3609, titulo restaurado (a dupla contagem de R$ 428,72 voltou)';
end $$;

commit;

--   drop table public._backup_saneamento_suelen_20260924;

-- ---------------------------------------------------------------------------
-- ROLLBACK DA OPCAO 2 (se for a escolhida), tambem por ID e a partir do backup
-- ---------------------------------------------------------------------------
-- begin;
-- update public.acordos_titulos t
--    set situacao = b.situacao_anterior,
--        status   = b.status_anterior,
--        motivo_ajuste = b.motivo_ajuste_anterior,
--        atualizado_em = now()
--   from public._backup_saneamento_suelen_20260924 b
--  where t.id = b.titulo_id
--    and t.id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306'
--    and upper(coalesce(t.situacao,'')) = 'DUPLICADA';
-- commit;
