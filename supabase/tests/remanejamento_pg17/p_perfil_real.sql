-- PERFIL REAL (B1): o remanejamento executado por GESTORA AUTENTICADA (role authenticated, JWT real) nao
-- pode ser barrado pelo gatilho bloquear_alteracoes_restritas_casos (producao, carregado aqui).
-- Controle negativo: um OPERADOR autenticado que tenta o mesmo UPDATE direto em casos TEM que ser barrado.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
update public.calibragem_parametros set valor = '700'::jsonb where chave = 'limite_carteira';
create temp table _pr on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 800, null, 2);
grant select on _pr to authenticated;
create table if not exists public.cg_perfil_previa (previa_id uuid);
delete from public.cg_perfil_previa;
grant select, insert on public.cg_perfil_previa to authenticated;

-- a previa e gerada antes (helper de teste, como postgres); so o REMANEJAMENTO roda como o perfil real
do $$
declare x record; p jsonb;
begin
  select * into x from _pr;
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br');
  insert into public.cg_perfil_previa values ((p->>'previa_id')::uuid);
end $$;

-- (a) Fernanda (gestao, nao e a Amanda) executa a RPC como authenticated, com JWT dela
set role authenticated;
select pg_temp.como('cobranca04@aelbra.com.br');
do $$
declare x record; r jsonb; pid uuid;
begin
  select * into x from _pr;
  select previa_id into pid from public.cg_perfil_previa limit 1;
  r := public.carteira_geral_mover(pid, 'perfil real: gestora Fernanda');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 1,
    format('perfil real: gestora executa o remanejamento sem bloqueio do gatilho (alunos_movidos=%s)', r->>'alunos_movidos'));
end $$;
reset role;

-- verificacao como postgres (o resultado e do banco, nao da sessao autenticada)
do $$
declare x record;
begin
  select * into x from _pr;
  perform pg_temp.afirma((select operador_email from public.casos where id = x.caso) = 'cobranca06@aelbra.com.br',
    'perfil real: caso foi para o destino');
  perform pg_temp.afirma((select caso_atualizado_por from public.casos where id = x.caso) = 'cobranca04@aelbra.com.br',
    'perfil real: caso_atualizado_por gravado pela gestora (quem executou)');
end $$;

-- (b) controle negativo: operador autenticado (Mauricio) tenta UPDATE direto mudando caso_atualizado_por
-- o operador precisa de SELECT/UPDATE em casos para que a TENTATIVA chegue ao gatilho (senao o erro seria de ACL)
grant select, update on public.casos to authenticated;
select pg_temp.como('cobranca06@aelbra.com.br');
set role authenticated;
do $$
declare x record; barrou boolean := false;
begin
  select * into x from _pr;
  begin
    update public.casos set caso_atualizado_por = 'tentativa@operador' where id = x.caso;
  exception when others then
    barrou := sqlerrm like '%somente para Amanda gestora%';
    if not barrou then raise; end if;
  end;
  perform pg_temp.afirma(barrou, 'controle negativo: operador autenticado e barrado pelo gatilho ao mudar caso_atualizado_por');
end $$;
reset role;

select 'PERFIL REAL OK' as resultado;
