-- PERFIS: quem nao e gestao nao remaneja; anon nao executa; a lista de dono
-- de liberacao nao aceita mais de um responsavel.
\i lib.sql
create temp table _s2 on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local');
grant select on _s2 to authenticated, anon;  -- o teste le a tabela ja como o papel em teste

-- 1) anon NAO tem EXECUTE (ACL de producao)
do $$ begin
  perform pg_temp.afirma(not has_function_privilege('anon', 'public.carteira_geral_previa(uuid[],text,text,boolean,jsonb,uuid[])', 'execute'),
    'anon sem EXECUTE em carteira_geral_previa');
  perform pg_temp.afirma(not has_function_privilege('anon', 'public.carteira_geral_mover(uuid,text)', 'execute'),
    'anon sem EXECUTE em carteira_geral_mover');
end $$;

-- 2) operador (authenticated, sem gestao) e barrado com mensagem de permissao
set role authenticated;
select pg_temp.como('cobranca05@aelbra.com.br');
do $$
declare s record;
begin
  select * into s from _s2;
  begin
    perform pg_temp.previa(array[s.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br');
    perform pg_temp.afirma(false, 'operador nao deveria gerar previa');
  exception when sqlstate '42501' then
    perform pg_temp.afirma(sqlerrm ~ 'Sem permissao', 'operador barrado: '||sqlerrm);
  end;
end $$;
reset role;

-- 3) sem JWT (cron) a previa e barrada
set role authenticated;
select pg_temp.como('');
do $$
declare s record;
begin
  select * into s from _s2;
  begin
    perform pg_temp.previa(array[s.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br');
    perform pg_temp.afirma(false, 'sem JWT nao deveria gerar previa');
  exception when sqlstate '42501' then
    perform pg_temp.afirma(true, 'sem JWT barrado');
  end;
end $$;
reset role;

-- 4) uma liberacao de fidelizacao so pode nomear o responsavel filtrado
select pg_temp.como('amanda.seibel@aelbra.com.br');
do $$
declare s record;
begin
  select * into s from _s2;
  begin
    perform pg_temp.previa(array[s.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br',
      '{"responsavel":"cobranca13@aelbra.com.br","liberar_fidelizacao_de":["cobranca13@aelbra.com.br","cobranca05@aelbra.com.br"]}');
    perform pg_temp.afirma(false, 'duas liberacoes deveriam ser recusadas');
  exception when sqlstate '22023' then
    perform pg_temp.afirma(sqlerrm ~ 'unico responsavel', 'duas liberacoes recusadas: '||sqlerrm);
  end;
end $$;
select 'PERFIS OK' as resultado;
