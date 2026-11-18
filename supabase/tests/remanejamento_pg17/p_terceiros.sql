-- TERCEIROS: casos protegidos de OUTRO operador ativo nao saem; e o que muda
-- entre previa e execucao (novo acionamento, troca de responsavel) e recusado.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create temp table _t on commit preserve rows as select * from pg_temp.semear('cobranca06@aelbra.com.br', 500, 3, 40);
create temp table _t2 on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 500, null, 2);
create temp table _t3 on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 500, null, 2);

do $$
declare m record; p jsonb; r jsonb;
begin
  -- (a) Mauricio acionou ha 3 dias: dentro dos 10 dias, bloqueado para Luana
  select * into m from _t;
  p := pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' = 'FIDELIZACAO_VIGENTE',
    'caso do Mauricio (acionado ha 3 dias) bloqueado para Luana');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'terceiro');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 0 and pg_temp.dono(m.caso) = 'cobranca06@aelbra.com.br',
    'caso protegido do Mauricio segue com ele');
end $$;

do $$
declare m record; p jsonb; r jsonb;
begin
  -- (b) previa ok; ANTES da execucao o caso ganha acionamento de hoje: recusa
  select * into m from _t2;
  p := pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' is null, 'previa: caso livre aceito');
  update public.casos set data_ultimo_acionamento = pg_temp.hoje(), status_acionamento = 'SOLICITADO_LINK' where id = m.caso;
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'novo acionamento');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 0, 'novo acionamento entre previa e execucao: recusado');
  perform pg_temp.afirma(pg_temp.dono(m.caso) = 'carteira.geral@reativa.local', 'caso segue na Carteira Geral');
end $$;

do $$
declare m record; p jsonb; r jsonb;
begin
  -- (c) previa ok; ANTES da execucao o responsavel da ficha muda: recusa
  select * into m from _t3;
  p := pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  update public.alunos set responsavel_atual_email = 'cobranca06@aelbra.com.br' where id = m.aluno;
  update public.casos set operador_email = 'cobranca06@aelbra.com.br' where id = m.caso;
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'troca');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 0, 'troca de responsavel entre previa e execucao: recusado');
  perform pg_temp.afirma(pg_temp.dono(m.caso) = 'cobranca06@aelbra.com.br', 'troca: caso segue com quem assumiu');
end $$;
select 'TERCEIROS OK' as resultado;
