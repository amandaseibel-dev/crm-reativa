-- REMOCAO SEGURA DO PAPEL TEMPORARIO leitor_defs. Executar SEMPRE apos a extracao,
-- inclusive se ela falhar. Ordem: bloquear logins -> encerrar sessoes -> revogar
-- privilegios -> conferir dependencias -> DROP ROLE simples (sem CASCADE, sem DROP OWNED).
\set ON_ERROR_STOP on
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'leitor_defs') then
    raise notice 'papel leitor_defs nao existe: nada a remover.';
    return;
  end if;
end $$;

-- 1) bloqueia novos logins
alter role leitor_defs nologin;

-- 2) encerra sessoes existentes do papel (nao encerra a propria sessao)
select pg_terminate_backend(pid)
  from pg_stat_activity
 where usename = 'leitor_defs' and pid <> pg_backend_pid();

-- 3) revoga todos os privilegios concedidos
revoke usage on schema public   from leitor_defs;
revoke usage on schema internal from leitor_defs;
revoke connect on database postgres from leitor_defs;

-- 4) confere dependencias antes de remover: parar se houver posse de objetos
--    ou privilegios remanescentes (nao usar DROP OWNED / CASCADE)
do $$
declare v_own int; v_acl int;
begin
  select count(*) into v_own
    from pg_shdepend d join pg_roles r on r.oid = d.refobjid
   where r.rolname = 'leitor_defs' and d.deptype = 'o';
  if v_own > 0 then
    raise exception 'REMOCAO BLOQUEADA: leitor_defs ainda e dono de % objeto(s). Revisar manualmente.', v_own;
  end if;
  select count(*) into v_acl
    from pg_shdepend d join pg_roles r on r.oid = d.refobjid
   where r.rolname = 'leitor_defs' and d.deptype = 'a';
  if v_acl > 0 then
    raise exception 'REMOCAO BLOQUEADA: % privilegio(s) remanescente(s) de leitor_defs. Revisar manualmente.', v_acl;
  end if;
end $$;

-- 5) remocao simples
drop role leitor_defs;
