-- ROLLBACK, parte A: prepara casos remanejados e depois uma gravacao alheia.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create table if not exists public.cg_teste_ids (nome text primary key, caso uuid, aluno uuid);
do $$
declare z record; x record; y record; w record; p jsonb;
begin
  select * into z from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);  -- Z: nosso, intacto
  select * into x from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);  -- X: outra rotina, MESMA data
  select * into y from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);  -- Y: outra rotina, OUTRA data
  insert into public.cg_teste_ids values ('Z', z.caso, z.aluno), ('X', x.caso, x.aluno), ('Y', y.caso, y.aluno);
  p := pg_temp.previa(array[z.aluno, x.aluno, y.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform public.carteira_geral_mover((p->>'previa_id')::uuid, 'rollback teste');
  -- outra rotina regrava a marca SEM marcador (como o giro faria)
  update public.casos set giro_fidelizacao_ate = pg_temp.hoje() + 10 where id = x.caso;
  update public.casos set giro_fidelizacao_ate = pg_temp.hoje() + 3 where id = y.caso;
  perform pg_temp.afirma((select remanejamento_lote_id from public.casos where id = x.caso) is null,
    'gatilho: outra rotina com a MESMA data soltou o marcador de X');
  perform pg_temp.afirma((select remanejamento_lote_id from public.casos where id = y.caso) is null,
    'gatilho: outra rotina com outra data soltou o marcador de Y');
  perform pg_temp.afirma((select remanejamento_lote_id from public.casos where id = z.caso) is not null,
    'Z mantem o marcador do nosso lote');
end $$;
select 'ROLLBACK A OK' as resultado;
