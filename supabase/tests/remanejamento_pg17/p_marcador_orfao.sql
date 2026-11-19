-- MARCADOR ORFAO: segue_dono devolve o aluno DEPOIS do remanejamento.
-- trg_giro_limpar_marca (producao) zera a marca no BEFORE trigger; o marcador do nosso lote
-- nao e escrito por essa rotina, entao fica orfao (giro nulo, lote preenchido).
-- O rollback (passo 2) deve limpar esse marcador orfao. Grava o estado para o rollback.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create table if not exists public.cg_orfao (nome text primary key, caso uuid, aluno uuid);
do $$
declare x record; p jsonb; r jsonb;
begin
  select * into x from pg_temp.semear('carteira.geral@reativa.local', 500, null, 2);
  update public.calibragem_parametros set valor = '700'::jsonb where chave = 'limite_carteira';
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'orfao');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 1 and pg_temp.marca(x.caso) is not null, 'orfao: marcado pelo remanejamento');
  -- zera o saldo para o aluno nao ter mensalidade (condicao de segue_dono)
  update public.acordos_titulos set situacao = 'PAGO', status = 'quitada', valor_em_aberto = 0, saldo_corrigido = 0 where aluno_id = x.aluno;
  -- acordo ATIVO de operador (Mauricio) -> segue_dono devolve o aluno ao dono do acordo
  insert into public.acordos (id, aluno_id, cpf, status, tipo, forma_pagamento, qtd_parcelas, entrada_paga, criado_em, atualizado_em, numero_acordo, valor_total, operador_responsavel_email, operador_responsavel_nome)
  values (gen_random_uuid(), x.aluno, (select cpf from public.alunos where id = x.aluno), 'ATIVO', 'PARCELADO', 'BOLETO', 1, false, now(), now(), floor(random()*1e9)::bigint, 100, 'cobranca06@aelbra.com.br', 'Mauricio');
  perform pg_temp.afirma((select responsavel_atual_email from public.alunos where id = x.aluno) = 'cobranca06@aelbra.com.br',
    'orfao: segue_dono devolveu o aluno ao dono do acordo');
  perform pg_temp.afirma(pg_temp.marca(x.caso) is null, 'orfao: trg_giro_limpar_marca zerou a marca');
  perform pg_temp.afirma((select remanejamento_lote_id from public.casos where id = x.caso) is not null,
    'orfao: o MARCADOR ficou orfao (lote preenchido, marca nula)');
  insert into public.cg_orfao values ('ORFAO', x.caso, x.aluno);
end $$;
select 'ORFAO PREPARADO' as resultado;
