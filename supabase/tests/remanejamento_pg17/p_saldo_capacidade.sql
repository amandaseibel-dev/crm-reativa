-- SALDO e CAPACIDADE revalidados na execucao.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
-- 1) quitacao entre previa e execucao: nao move
create temp table _q on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 500);
do $$
declare s record; p jsonb; r jsonb;
begin
  select * into s from _q;
  p := pg_temp.previa(array[s.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  update public.acordos_titulos set situacao = 'PAGO', status = 'quitada', valor_em_aberto = 0, saldo_corrigido = 0
   where aluno_id = s.aluno;
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'quitacao teste');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 0, 'quitado apos a previa: nao movido');
  perform pg_temp.afirma(pg_temp.dono(s.caso) = 'carteira.geral@reativa.local', 'quitado: segue na Carteira Geral');
end $$;

-- 2) capacidade: teto 1, Luana ja tem 1 caso; aluno de 1 caso NAO cabe (sobra 1, cabem 0).
-- (Aluno com dois casos abertos nao existe em producao: um aluno = um caso aberto.)
update public.calibragem_parametros set valor = '1'::jsonb where chave = 'limite_carteira';
create temp table _c on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 100, 40, 40);
do $$
declare x record; p jsonb; r jsonb;
begin
  select * into x from pg_temp.semear('carteira.geral@reativa.local', 900);
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform pg_temp.afirma((p->'capacidade'->>'cabem')::int = 0 and (p->'capacidade'->>'sobram')::int = 1,
    'previa: teto 1 com a Luana ocupada -> cabem 0, sobram 1 ('||(p->'capacidade')::text||')');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'capacidade teste');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 0, 'execucao: nao move quando nao ha vaga');
  perform pg_temp.afirma(pg_temp.dono(x.caso) = 'carteira.geral@reativa.local', 'caso segue na Carteira Geral');
end $$;
select 'SALDO E CAPACIDADE OK' as resultado;
