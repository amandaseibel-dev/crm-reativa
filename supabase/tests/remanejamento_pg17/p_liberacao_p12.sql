-- P12: liberar_fidelizacao_de so aceita OPERADOR ATIVO. Recusa (22023) antes de gravar a previa:
-- Carteira Geral, operador inativo e gerencia. Operador ativo elegivel e aceito, e a previa so informa a
-- liberacao quando ela tem efeito (caso fidelizado do dono liberado nesta previa).
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
update public.calibragem_parametros set valor = '700'::jsonb where chave = 'limite_carteira';
-- fidelizado: acionamento ha 3 dias (dentro dos 10); nao fidelizado: sem acionamento
create temp table _pm on commit preserve rows as select * from pg_temp.semear('cobranca06@aelbra.com.br', 400, 3, 40);
create temp table _pn on commit preserve rows as select * from pg_temp.semear('cobranca06@aelbra.com.br', 400, null, 40);

do $$
declare m record; n0 int; n1 int; ok_recusa int := 0;
begin
  select * into m from _pm;
  select count(*) into n0 from public.carteira_geral_previas;

  -- RECUSAS (22023): a recusa nao grava previa
  begin
    perform pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br',
      '{"responsavel":"carteira.geral@reativa.local","liberar_fidelizacao_de":["carteira.geral@reativa.local"]}');
    perform pg_temp.afirma(false, 'recusa Carteira Geral: deveria ser recusada');
  exception when sqlstate '22023' then
    ok_recusa := ok_recusa + 1;
    perform pg_temp.afirma(sqlerrm ~ 'operador ativo', 'recusa Carteira Geral (22023): '||sqlerrm);
  end;
  begin
    perform pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br',
      '{"responsavel":"cobranca03@aelbra.com.br","liberar_fidelizacao_de":["cobranca03@aelbra.com.br"]}');
    perform pg_temp.afirma(false, 'recusa operador inativo: deveria ser recusada');
  exception when sqlstate '22023' then
    ok_recusa := ok_recusa + 1;
    perform pg_temp.afirma(sqlerrm ~ 'cobranca03', 'recusa operador inativo (22023): '||sqlerrm);
  end;
  begin
    perform pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br',
      '{"responsavel":"amanda.seibel@aelbra.com.br","liberar_fidelizacao_de":["amanda.seibel@aelbra.com.br"]}');
    perform pg_temp.afirma(false, 'recusa gerencia: deveria ser recusada');
  exception when sqlstate '22023' then
    ok_recusa := ok_recusa + 1;
    perform pg_temp.afirma(sqlerrm ~ 'amanda', 'recusa gerencia (22023): '||sqlerrm);
  end;
  perform pg_temp.afirma(ok_recusa = 3, format('recusas: %s de 3 com SQLSTATE 22023', ok_recusa));

  -- DADOS INTACTOS: nenhuma previa gravada pelas recusas
  select count(*) into n1 from public.carteira_geral_previas;
  perform pg_temp.afirma(n1 = n0, format('recusas nao gravam previa (antes=%s depois=%s)', n0, n1));
end $$;

do $$
declare m record; n record; p jsonb;
begin
  select * into m from _pm;
  select * into n from _pn;

  -- PERMITIDO: operador ativo elegivel, liberado, com caso fidelizado -> aceito, liberacao informada e com efeito
  p := pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br',
    '{"responsavel":"cobranca06@aelbra.com.br","liberar_fidelizacao_de":["cobranca06@aelbra.com.br"]}');
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' is null, 'permitido: operador ativo liberado, caso sem bloqueio');
  perform pg_temp.afirma(p->'liberar_fidelizacao_de' = '["cobranca06@aelbra.com.br"]'::jsonb,
    'permitido: a previa informa a liberacao porque ela tem efeito');

  -- SEM EFEITO: operador ativo liberado, mas sem caso fidelizado nesta previa -> aceito, NAO informa liberacao
  p := pg_temp.previa(array[n.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br',
    '{"responsavel":"cobranca06@aelbra.com.br","liberar_fidelizacao_de":["cobranca06@aelbra.com.br"]}');
  perform pg_temp.afirma(p->'liberar_fidelizacao_de' = '[]'::jsonb,
    'sem efeito: a previa NAO informa liberacao sem caso fidelizado');

  -- SEM LIBERACAO: o mesmo caso fidelizado, sem liberar -> bloqueado e nada informado
  p := pg_temp.previa(array[m.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br', '{}');
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' is not null,
    'sem liberacao: caso fidelizado segue bloqueado');
  perform pg_temp.afirma(p->'liberar_fidelizacao_de' = '[]'::jsonb, 'sem liberacao: nada informado');
end $$;


-- EFEITO (critério P12): destino que nao e OPERADOR, e caso fidelizado ja bloqueado por outro motivo (ENCERRADO)
-- nao produzem efeito: a previa NAO pode informar a liberacao.
do $$
declare m record; p jsonb;
begin
  select * into m from _pm;
  p := pg_temp.previa(array[m.aluno], 'CARTEIRA_GERAL', null,
    '{"responsavel":"cobranca06@aelbra.com.br","liberar_fidelizacao_de":["cobranca06@aelbra.com.br"]}');
  perform pg_temp.afirma(p->'liberar_fidelizacao_de' = '[]'::jsonb,
    'sem efeito: destino CARTEIRA_GERAL nao informa liberacao');
end $$;

do $$
declare q record; p jsonb;
begin
  -- acionamento JURIDICO: o caso e ENCERRADO (encerrado_operacional, verificado antes de PROTEGIDO em cg_bloqueio).
-- A proteção de producao tambem cobre JURIDICO; o motivo reportado e ENCERRADO. O semear
  -- grava p_acion em status_acionamento (o que a regra le); p_status vai para status_atual (nao protege).
  select * into q from pg_temp.semear('cobranca06@aelbra.com.br', 400, 3, 40, p_acion => 'JURIDICO');
  p := pg_temp.previa(array[q.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br',
    '{"responsavel":"cobranca06@aelbra.com.br","liberar_fidelizacao_de":["cobranca06@aelbra.com.br"]}');
  raise notice 'bloqueio do caso protegido: %', p->'itens'->0->>'bloqueio';
  perform pg_temp.afirma(p->'itens'->0->>'bloqueio' = 'ENCERRADO',
    'fidelizado com acionamento JURIDICO segue bloqueado (motivo ENCERRADO) com a liberacao');
  perform pg_temp.afirma(p->'liberar_fidelizacao_de' = '[]'::jsonb,
    'sem efeito: caso bloqueado por outro motivo nao informa liberacao');
end $$;
select 'LIBERACAO P12 OK' as resultado;
