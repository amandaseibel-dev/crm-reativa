-- ROLLBACK de 20261112180000_juridico_encaminhamento.sql
--
-- PITR nao esta habilitado: rollback nao e restore. Este arquivo:
--   1. RECUSA rodar se ainda houver aluno bloqueado por caso desta aba --
--      derrubar as tabelas com bloqueio ativo deixaria aluno em 'JURIDICO' sem
--      registro de quem bloqueou nem do estado anterior. Levante antes, caso a
--      caso, por `juridico_caso_remover` (so alcanca APROVADO) ou decida com a
--      gestao o destino dos ja enviados;
--   2. guarda copia das quatro tabelas em `_backup_juridico_*` (com RLS e sem
--      grant) antes de remover;
--   3. remove funcoes, tabelas e sequence. Nenhum titulo, parcela ou acordo e
--      tocado -- a migration tambem nao os tocou.

begin;

do $guarda$
declare v_n int;
begin
  select count(*) into v_n
    from public.juridico_casos
   where status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO');
  if v_n > 0 then
    raise exception 'rollback juridico: % caso(s) com cobranca bloqueada por esta aba. Levante os bloqueios antes.', v_n;
  end if;
end
$guarda$;

create table public._backup_juridico_lotes_20261112 as table public.juridico_lotes;
create table public._backup_juridico_casos_20261112 as table public.juridico_casos;
create table public._backup_juridico_casos_titulos_20261112 as table public.juridico_casos_titulos;
create table public._backup_juridico_historico_20261112 as table public.juridico_historico;
alter table public._backup_juridico_lotes_20261112 enable row level security;
alter table public._backup_juridico_casos_20261112 enable row level security;
alter table public._backup_juridico_casos_titulos_20261112 enable row level security;
alter table public._backup_juridico_historico_20261112 enable row level security;
revoke all on public._backup_juridico_lotes_20261112, public._backup_juridico_casos_20261112,
              public._backup_juridico_casos_titulos_20261112, public._backup_juridico_historico_20261112
  from public, anon, authenticated;

do $drop$
declare r record;
begin
  for r in
    select p.oid::regprocedure as assinatura
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'juridico\_%' or p.proname like '\_juridico\_%')
  loop
    execute format('drop function %s cascade', r.assinatura);
  end loop;
end
$drop$;

drop table public.juridico_historico;
drop table public.juridico_casos_titulos;
drop table public.juridico_casos;
drop table public.juridico_lotes;
drop sequence public.juridico_protocolo_seq;

commit;
