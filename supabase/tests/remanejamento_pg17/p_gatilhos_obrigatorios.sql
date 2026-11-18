-- GATILHOS OBRIGATORIOS (producao): encerramento, reposicao, relogio da fidelizacao, retorno no recalculo de acordo.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
update public.calibragem_parametros set valor = '700'::jsonb where chave = 'limite_carteira';

-- (1) ENCERRAMENTO: caso quitado fica encerrado operacionalmente e NAO entra no remanejamento
create temp table _g1 on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 400, null, 2);
do $$
declare x record; p jsonb;
begin
  select * into x from _g1;
  -- producao: quitado so encerra com saldo conferido zero (_caso_sem_saldo_conferido); zera o saldo
  update public.acordos_titulos set situacao = 'PAGO', status = 'quitada', valor_em_aberto = 0, saldo_corrigido = 0 where aluno_id = x.aluno;
  update public.casos set status_atual = 'QUITADO' where id = x.caso;
  perform pg_temp.afirma((select encerrado_operacional from public.casos where id = x.caso) is true,
    'encerramento: trg_casos_set_encerrado_operacional marca o caso quitado como encerrado');
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' = 'ENCERRADO', 'encerramento: previa bloqueia o caso encerrado (ENCERRADO)');
end $$;

-- (2) REPOSICAO: a protecao do caso cai (de protegido para nao protegido) -> o gatilho libera o caso e grava reposicao
create temp table _g2 on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 400, null, 40, 'ACORDO_FECHADO');  -- status protegido em producao (lista de caso_protegido_redistribuicao)
do $$
declare x record; n0 int; n1 int;
begin
  select * into x from _g2;
  n0 := (select count(*) from public.reposicao_carteira_fila);
  update public.casos set status_acionamento = 'MENSAGEM_ENVIADA' where id = x.caso;
  n1 := (select count(*) from public.reposicao_carteira_fila);
  perform pg_temp.afirma(n1 > n0, 'reposicao: trigger_repor grava reposicao_carteira_fila quando a protecao cai');
  perform pg_temp.afirma((select operador_email from public.casos where id = x.caso) is null,
    'reposicao: o caso sai do operador (volta para a fila)');
end $$;

-- (3) RELOGIO DA FIDELIZACAO: acionamento em alunos e copiado para casos (dia de Sao Paulo)
create temp table _g3 on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 400, null, 40);
do $$
declare x record; hoje_sp date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select * into x from _g3;
  update public.alunos set data_ultimo_acionamento = now() where id = x.aluno;
  perform pg_temp.afirma((select data_ultimo_acionamento from public.casos where id = x.caso) = hoje_sp,
    'relogio: trg_sync_acionamento_alunos_para_casos copia o acionamento para o caso (dia SP)');
end $$;

-- (4) RETORNO PRESERVADO no recalculo de acordo (trg_recalc_acordo -> recalcular_situacao_aluno)
create temp table _g4 on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 400, null, 40);
do $$
declare x record; antes date; depois date;
begin
  select * into x from _g4;
  update public.alunos set data_retorno = pg_temp.hoje() + 5, retorno_origem = 'OPERADOR' where id = x.aluno;
  select data_retorno into antes from public.alunos where id = x.aluno;
  insert into public.acordos (id, aluno_id, cpf, status, tipo, forma_pagamento, qtd_parcelas, entrada_paga, criado_em, atualizado_em, numero_acordo, valor_total, operador_responsavel_email, operador_responsavel_nome)
  values (gen_random_uuid(), x.aluno, (select cpf from public.alunos where id = x.aluno), 'ATIVO', 'PARCELADO', 'BOLETO', 1, false, now(), now(), floor(random()*1e9)::bigint, 100, 'cobranca05@aelbra.com.br', 'Luana');
  select data_retorno into depois from public.alunos where id = x.aluno;
  perform pg_temp.afirma(depois = antes, format('retorno: recalculo de acordo preserva o retorno agendado (antes %s, depois %s)', antes, depois));
end $$;
select 'GATILHOS OBRIGATORIOS OK' as resultado;
