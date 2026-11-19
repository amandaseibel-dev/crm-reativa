-- CONCORRENCIA B4, preparo: DOIS destinos diferentes, cada um com 1 vaga (teto 3, ocupacao inicial 2).
-- Grupo A (2 alunos elegiveis) vai para a Luana; grupo B (2 alunos elegiveis) vai para a Mauricio.
-- Cada sessao move a sua previa. Com 1 vaga por destino, cada sessao deve mover exatamente 1 aluno.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create table if not exists public.cg_teste2_ids (nome text primary key, aluno uuid, caso uuid, previa text);
create table if not exists public.cg_teste2_res (sessao text primary key, resultado jsonb);
create table if not exists public.cg_teste2_bar (sessao text primary key);
delete from public.cg_teste2_ids;
delete from public.cg_teste2_res;
delete from public.cg_teste2_bar;

do $$
declare a1 record; a2 record; b1 record; b2 record; pa jsonb; pb jsonb;
begin
  update public.calibragem_parametros set valor = '3'::jsonb where chave = 'limite_carteira';
  -- zera ocupacao herdada de outros testes (estado de teste), como o setup de concorrencia anterior
  update public.casos set operador_email = 'carteira.geral@reativa.local', operador_nome = 'CARTEIRA GERAL', operador = 'CARTEIRA GERAL'
   where operador_email in ('cobranca05@aelbra.com.br','cobranca06@aelbra.com.br');
  -- ocupacao inicial por destino: 2 casos cada
  perform pg_temp.semear('cobranca05@aelbra.com.br', 0, null, 40);
  perform pg_temp.semear('cobranca05@aelbra.com.br', 0, null, 40);
  perform pg_temp.semear('cobranca06@aelbra.com.br', 0, null, 40);
  perform pg_temp.semear('cobranca06@aelbra.com.br', 0, null, 40);
  -- grupos elegiveis (saldo > 0, sem acionamento recente)
  select * into a1 from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  select * into a2 from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  select * into b1 from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  select * into b2 from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);

  pa := pg_temp.previa(array[a1.aluno, a2.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');  -- Luana
  pb := pg_temp.previa(array[b1.aluno, b2.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br');  -- Mauricio
  perform pg_temp.afirma((pa->'capacidade'->>'cabem')::int = 1 and (pb->'capacidade'->>'cabem')::int = 1,
    'previa: cada destino tem exatamente 1 vaga');

  insert into public.cg_teste2_ids values
    ('A1', a1.aluno, a1.caso, null), ('A2', a2.aluno, a2.caso, null),
    ('B1', b1.aluno, b1.caso, null), ('B2', b2.aluno, b2.caso, null),
    ('PA', null, null, pa->>'previa_id'), ('PB', null, null, pb->>'previa_id');
end $$;
select 'CONC2 SETUP OK' as resultado;
