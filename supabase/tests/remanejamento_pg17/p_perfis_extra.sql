-- PERFIS EXTRA: Fernanda (supervisora, gestao) e Amanda ADM (gestao) executam;
-- replicacao: authenticated nao consegue session_replication_role.
\i lib.sql
create temp table _pe on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
do $$
declare x record; p jsonb;
begin
  select * into x from _pe;
  perform pg_temp.como('cobranca04@aelbra.com.br');
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' is null, 'Fernanda (gestao) gera previa');
  perform pg_temp.como('cobranca07@aelbra.com.br');
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' is null, 'Amanda ADM (gestao) gera previa');
end $$;
-- replicacao: como authenticated, nao pode desligar triggers da sessao
set role authenticated;
select pg_temp.como('cobranca05@aelbra.com.br');
do $$
begin
  begin
    execute 'set session_replication_role = replica';
    perform pg_temp.afirma(false, 'replica: authenticated NAO deveria mudar session_replication_role');
  exception when insufficient_privilege then
    perform pg_temp.afirma(true, 'replica: authenticated barrado (insufficient_privilege)');
  end;
end $$;
reset role;
select 'PERFIS EXTRA OK' as resultado;
