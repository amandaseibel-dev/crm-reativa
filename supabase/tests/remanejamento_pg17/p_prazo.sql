-- PRAZO: 10 dias integrais para o caso remanejado; liberacao so depois do 10o
-- dia, pela regra oficial (data da marca). Depende da #936 (liberar por data).
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create temp table _p on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 800, null, 2);
do $$
declare s record; p jsonb; r jsonb; m date;
begin
  select * into s from _p;
  p := pg_temp.previa(array[s.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'remanejamento teste');
  m := pg_temp.marca(s.caso);
  perform pg_temp.afirma(m = pg_temp.hoje() + 10, 'marca = hoje + 10 ('||m||')');
  perform pg_temp.afirma(pg_temp.dono(s.caso) = 'cobranca05@aelbra.com.br', 'caso com a Luana');
  perform pg_temp.afirma((select remanejamento_lote_id from public.casos where id = s.caso) is not null, 'marcador do lote gravado');
  -- dia 9: ainda protegido (marca no futuro). Ficha parada ha 2 dias: so a MARCA pode segurar.
  update public.alunos set responsavel_atual_em = now() - interval '2 days' where id = s.aluno;
  update public.casos set giro_fidelizacao_ate = pg_temp.hoje() + 1 where id = s.caso;
  perform public.liberar_casos_fidelizacao_vencida(100000);
  perform pg_temp.afirma(pg_temp.dono(s.caso) = 'cobranca05@aelbra.com.br', 'dentro dos 10 dias: nao solta');
  -- dia 11: marca venceu, ficha parada ha mais de um dia (tempo simulado) -> solta
  update public.alunos set responsavel_atual_em = now() - interval '2 days' where id = s.aluno;
  update public.casos set giro_fidelizacao_ate = pg_temp.hoje() - 1 where id = s.caso;
  perform public.liberar_casos_fidelizacao_vencida(100000);
  perform pg_temp.afirma(pg_temp.dono(s.caso) is null, 'apos o 10o dia: solta (regra por data, #936)');
end $$;

-- FRONTEIRA: caso_em_giro_fidelizacao e inclusivo (giro >= hoje em SP). Marca = hoje ainda protege;
-- marca = ontem libera. Ficha parada ha 2 dias nas duas pontas, para que so a marca decida.
create temp table _q on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 800, null, 2);
do $$
declare s record; p jsonb; r jsonb;
begin
  select * into s from _q;
  p := pg_temp.previa(array[s.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'fronteira do prazo');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 1, 'fronteira: caso movido para a fronteira');
  update public.alunos set responsavel_atual_em = now() - interval '2 days' where id = s.aluno;
  -- marca = hoje (dia 10, inclusivo): ainda protegido
  update public.casos set giro_fidelizacao_ate = pg_temp.hoje() where id = s.caso;
  perform public.liberar_casos_fidelizacao_vencida(100000);
  perform pg_temp.afirma(pg_temp.dono(s.caso) = 'cobranca05@aelbra.com.br', 'fronteira: marca = hoje AINDA protege (inclusivo)');
  -- marca = ontem: liberado
  update public.casos set giro_fidelizacao_ate = pg_temp.hoje() - 1 where id = s.caso;
  perform public.liberar_casos_fidelizacao_vencida(100000);
  perform pg_temp.afirma(pg_temp.dono(s.caso) is null, 'fronteira: marca = ontem libera');
end $$;
select 'PRAZO OK' as resultado;
