-- CRIACAO DO PAPEL TEMPORARIO DE LEITURA DO EXPORT (nivelamento V2).
-- Executar como dono do projeto, no SQL Editor, em PRODUCAO, sob autorizacao especifica.
-- NAO altera dados operacionais. A senha NAO passa por este arquivo: o administrador
-- a define localmente com a ultima linha (substitua o marcador por ele mesmo, sem registrar).
-- Falha (e nao cria nada pela metade) se o papel ja existir.
\set ON_ERROR_STOP on
begin;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'leitor_defs') then
    raise exception 'papel leitor_defs ja existe: nada criado. Rode a remocao antes.';
  end if;
end $$;
create role leitor_defs login nosuperuser nocreatedb nocreaterole noinherit connection limit 2;
alter role leitor_defs set default_transaction_read_only = on;
grant connect on database postgres to leitor_defs;
grant usage on schema public to leitor_defs;
grant usage on schema internal to leitor_defs;
commit;
-- Passo separado, feito pelo administrador localmente (nao registrar o valor):
--   alter role leitor_defs password '<senha gerada pelo administrador>';
