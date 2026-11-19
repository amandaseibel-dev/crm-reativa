-- CONCORRENCIA, preparo: duas previas para o MESMO caso (destinos diferentes)
-- e duas previas de capacidade (teto 2, cada uma cabe sozinha, juntas nao cabem).
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create table if not exists public.cg_teste_ids (nome text primary key, caso uuid, aluno uuid, previa text);
create table if not exists public.cg_teste_res (sessao text primary key, resultado jsonb);
do $$
declare c record; pa jsonb; pb jsonb; e1 record; e2 record; f1 record; f2 record; pe jsonb; pf jsonb;
begin
  update public.calibragem_parametros set valor = '2'::jsonb where chave = 'limite_carteira';
  -- zera a ocupacao de Luana e Mauricio deixada pelos testes anteriores (estado de teste)
  update public.casos set operador_email = 'carteira.geral@reativa.local', operador_nome = 'CARTEIRA GERAL', operador = 'CARTEIRA GERAL'
   where operador_email in ('cobranca05@aelbra.com.br','cobranca06@aelbra.com.br');
  select * into c from pg_temp.semear('carteira.geral@reativa.local', 400, null, 2);
  pa := pg_temp.previa(array[c.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');  -- Luana
  pb := pg_temp.previa(array[c.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');  -- Luana (mesmo destino: so um vence)
  insert into public.cg_teste_ids values ('MESMO', c.caso, c.aluno, pa->>'previa_id'), ('MESMO_B', null, null, pb->>'previa_id');
  select * into e1 from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  select * into e2 from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  select * into f1 from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  select * into f2 from pg_temp.semear('carteira.geral@reativa.local', 300, null, 2);
  pe := pg_temp.previa(array[e1.aluno, e2.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br');  -- Mauricio (Diego e vedado)
  pf := pg_temp.previa(array[f1.aluno, f2.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br');
  perform pg_temp.afirma((pe->'capacidade'->>'cabem')::int = 2 and (pf->'capacidade'->>'cabem')::int = 2,
    'cada previa, sozinha, cabe as 2 vagas');
  insert into public.cg_teste_ids values ('CAP_E', null, null, pe->>'previa_id'), ('CAP_F', null, null, pf->>'previa_id');
end $$;
select 'CONC SETUP OK' as resultado;
