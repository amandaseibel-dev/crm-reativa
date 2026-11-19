-- CONTENCAO REAL B4 (mesmo destino, 1 vaga, 2 alunos elegiveis). Preparo.
-- Destino: Luana. Teto 3, ocupacao inicial 2 -> 1 vaga. Cada aluno tem a sua previa (cabem 1).
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create table if not exists public.cg_teste3_ids (nome text primary key, aluno uuid, caso uuid, previa text);
create table if not exists public.cg_teste3_res (sessao text primary key, resultado jsonb, inicio timestamptz, fim timestamptz);
create table if not exists public.cg_teste3_bar (sessao text primary key, ts timestamptz);
create table if not exists public.cg_teste3_flag (nome text primary key, ts timestamptz);
delete from public.cg_teste3_ids;
delete from public.cg_teste3_res;
delete from public.cg_teste3_bar;
delete from public.cg_teste3_flag;

do $$
declare x record; y record; pa jsonb; pb jsonb;
begin
  update public.calibragem_parametros set valor = '3'::jsonb where chave = 'limite_carteira';
  update public.casos set operador_email = 'carteira.geral@reativa.local', operador_nome = 'CARTEIRA GERAL', operador = 'CARTEIRA GERAL'
   where operador_email in ('cobranca05@aelbra.com.br','cobranca06@aelbra.com.br');
  perform pg_temp.semear('cobranca05@aelbra.com.br', 0, null, 40);
  perform pg_temp.semear('cobranca05@aelbra.com.br', 0, null, 40);
  select * into x from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  select * into y from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  pa := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  pb := pg_temp.previa(array[y.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform pg_temp.afirma((pa->'capacidade'->>'cabem')::int = 1 and (pb->'capacidade'->>'cabem')::int = 1,
    'contencao: cada previa, sozinha, cabe na unica vaga');
  insert into public.cg_teste3_ids values ('X', x.aluno, x.caso, pa->>'previa_id'), ('Y', y.aluno, y.caso, pb->>'previa_id');
end $$;
select 'CONT SETUP OK' as resultado;
