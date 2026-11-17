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

-- 2) aluno com 2 casos e 1 vaga: sai inteiro (mesma regra da previa)
update public.calibragem_parametros set valor = '2'::jsonb where chave = 'limite_carteira';
create temp table _c on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 100, 40, 40);
do $$
declare dois record; p jsonb; r jsonb;
begin
  select * into dois from pg_temp.semear('carteira.geral@reativa.local', 900);
  insert into public.casos (id, aluno_id, caso_codigo, nome, cpf, cpf_limpo, matricula, chave_unificacao,
      operador_email, operador_nome, operador, status_atual, status_acionamento, total_em_aberto)
  select gen_random_uuid(), dois.aluno, 9999, 'x', 'c', 'c', 'm', 'k', 'carteira.geral@reativa.local', 'CARTEIRA GERAL', 'CARTEIRA GERAL', 'Em cobranca', 'MENSAGEM_ENVIADA', 1;
  p := pg_temp.previa(array[dois.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform pg_temp.afirma((p->'capacidade'->>'cabem')::int = 0 and (p->'capacidade'->>'sobram')::int = 2,
    'previa: aluno de 2 casos com 1 vaga -> cabem 0, sobram 2 ('||(p->'capacidade')::text||')');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'capacidade teste');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 0, 'execucao: nao move o aluno que nao cabe inteiro');
end $$;
select 'SALDO E CAPACIDADE OK' as resultado;
