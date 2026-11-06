-- CASOS — 19 cenários de permissão para a trava de tabulação somente gestão
--
-- Pré-condição: 01_ambiente.sql + 02_baseline.sql + o SQL de
-- 20261106140000_tabulacao_so_gestao_no_banco aplicados, nesta ordem.
--
-- COMO ESTE TESTE TROCA DE USUÁRIO, E POR QUE ASSIM:
--   * QUEM é a pessoa  -> GUC `teste.email`, que o stub de `auth.jwt()` lê.
--     É o análogo do token: a autorização nunca vem de argumento de função.
--   * QUAL é a conexão -> `\connect`, porque o gatilho libera
--     `session_user in ('postgres', ...)` e o CI roda psql como postgres.
--     Sem reconectar como `teste_app`, a trava não dispararia e os casos
--     passariam EM VERDE SEM TESTAR NADA. `set role` não serve: muda
--     `current_user`, não `session_user`. O CASO 0 cobra isso.
--
-- UM ALUNO POR CASO, de propósito. Os blocos `do` comitam, e o estado
-- atravessa as conexões: reusar aluno faz um caso herdar o status que o
-- anterior gravou -- e foi exatamente assim que a primeira versão desta suíte
-- ficaria vermelha por contaminação, não por defeito do SQL.
--
-- A tabela de resultado é COMUM (não temporária): tabela temp morre no
-- `\connect`, e este teste atravessa cinco conexões.

\set ON_ERROR_STOP on

-- ===========================================================================
-- PREPARO (como postgres)
-- ===========================================================================

drop table if exists public._trava_teste;
create table public._trava_teste (n int, caso text, ok boolean, detalhe text);
grant select, insert on public._trava_teste to teste_app, authenticated;

-- A tabulação da frente. Entra aqui, e não em 01_ambiente, porque a ORDEM de
-- implantação é: primeiro a linha no catálogo, depois a trava. É esta linha
-- que faz a trava passar a valer para ela -- sem migration nova.
insert into public.tabulacoes
  (codigo, rotulo, ordem, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
   ativa, somente_gestao, sistema, bloqueia_acionamento, exige_processo, efeito_desfecho)
values
  ('RETORNO_FINANCEIRO','Retorno do financeiro',340,'FINANCEIRO','NENHUM',null,'CONTATAR',
   true, true, false, false, false, null)
on conflict (codigo) do nothing;

-- Fixtures: um aluno por caso.
-- Os que nascem com código só-gestão representam os 182 de produção.
insert into public.alunos (id, nome, status_atual, status_jornada, status_acionamento) values
  ('a0000001-0000-0000-0000-000000000001','c1 comum',        'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000002-0000-0000-0000-000000000002','c2 comum',        'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000003-0000-0000-0000-000000000003','c3 comum',        'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000004-0000-0000-0000-000000000004','c4 ja em RF',     'RETORNO_FINANCEIRO','RETORNO_FINANCEIRO','RETORNO_FINANCEIRO'),
  ('a0000005-0000-0000-0000-000000000005','c5 comum',        'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000006-0000-0000-0000-000000000006','c6 comum',        'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000007-0000-0000-0000-000000000007','c7 comum',        'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000008-0000-0000-0000-000000000008','c8 comum',        'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000009-0000-0000-0000-000000000009','c9 comum',        'CONTATAR','CONTATAR','CONTATAR'),
  -- O aluno do CASO 18: codigo bloqueado com espaco sobrando.
  ('a0000010-0000-0000-0000-000000000010','c18 comum',       'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000012-0000-0000-0000-000000000012','c12 comum',       'CONTATAR','CONTATAR','CONTATAR'),
  ('a0000013-0000-0000-0000-000000000013','c13 comum',       'CONTATAR','CONTATAR','CONTATAR'),
  -- O aluno do CASO 14: ja carrega RETORNO_FINANCEIRO, como ficam os casos que
  -- a gestao carimba e que SEGUEM na carteira do operador.
  ('a0000014-0000-0000-0000-000000000014','c14 ja em RF',    'CONTATAR','RETORNO_FINANCEIRO','CONTATAR'),
  -- O aluno do CASO 15: ja cancelado, para provar que um codigo bloqueado nao
  -- destranca OUTRO codigo bloqueado.
  ('a0000015-0000-0000-0000-000000000015','c15 ja cancelado','CANCELAMENTO_COBRANCA','CANCELAMENTO_COBRANCA','CANCELAMENTO_COBRANCA'),
  -- O aluno do CASO 16: codigo bloqueado em UMA coluna so, para provar que nao
  -- se pode copia-lo para outra.
  ('a0000016-0000-0000-0000-000000000016','c16 cancel em 1 col','CANCELAMENTO_COBRANCA','CONTATAR','CONTATAR'),
  -- O aluno do CASO 17: edicao de rotina num aluno que carrega codigo
  -- bloqueado. Tem de PASSAR -- sao os 182 de producao.
  ('a0000017-0000-0000-0000-000000000017','c17 ja cancelado','CANCELAMENTO_COBRANCA','CANCELAMENTO_COBRANCA','CONTATAR')
on conflict (id) do nothing;

-- ===========================================================================
-- OPERADOR -- conexão sem superusuário, identidade de operador
-- ===========================================================================
\connect "host=localhost port=5432 dbname=teste user=teste_app password=teste"

set session "teste.email" = 'cobranca05@aelbra.com.br';
set session "teste.role"  = 'authenticated';

do $teste$
declare
  v_erro text;
begin
  -- CASO 0: a conexao e mesmo de nao-superusuario? Se for postgres, o bypass
  -- de sistema liga e TODO o resto deste arquivo mente.
  if session_user = 'postgres' then
    raise exception 'CASO 0 falhou: a conexao continua como postgres, a trava nao seria exercida';
  end if;
  insert into public._trava_teste values
    (0, 'conexao de operador e sem superusuario', true, 'session_user=' || session_user);

  -- CASO 1: operador NAO grava RETORNO_FINANCEIRO. E a mensagem tem de dizer a
  -- verdade: restrita a gestao, SEM falar em "Encerrar cobranca".
  begin
    update public.alunos set status_jornada = 'RETORNO_FINANCEIRO'
     where id = 'a0000001-0000-0000-0000-000000000001';
    insert into public._trava_teste values (1, 'operador barrado em RETORNO_FINANCEIRO', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    v_erro := sqlerrm;
    insert into public._trava_teste values
      (1, 'operador barrado em RETORNO_FINANCEIRO',
       v_erro like '%restrita à gestão%' and v_erro not like '%Encerrar cobrança%',
       v_erro);
  end;

  -- CASO 2: a trava historica de encerramento NAO regrediu, e a mensagem dela
  -- continua palavra por palavra a que os operadores conhecem.
  begin
    update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA'
     where id = 'a0000002-0000-0000-0000-000000000002';
    insert into public._trava_teste values (2, 'operador barrado em CANCELAMENTO_COBRANCA', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    v_erro := sqlerrm;
    insert into public._trava_teste values
      (2, 'operador barrado em CANCELAMENTO_COBRANCA', v_erro like '%Encerrar cobrança%', v_erro);
  end;

  -- CASO 3: tabulacao COMUM segue livre. A trava nao pode vazar para o resto.
  begin
    update public.alunos set status_jornada = 'MENSAGEM_ENVIADA'
     where id = 'a0000003-0000-0000-0000-000000000003';
    insert into public._trava_teste values (3, 'operador tabula MENSAGEM_ENVIADA', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (3, 'operador tabula MENSAGEM_ENVIADA', false, sqlerrm);
  end;

  -- CASO 4: reescrever NA MESMA COLUNA o codigo que ja estava la passa.
  begin
    update public.alunos set status_atual = 'RETORNO_FINANCEIRO'
     where id = 'a0000004-0000-0000-0000-000000000004';
    insert into public._trava_teste values (4, 'reescrever RETORNO_FINANCEIRO na mesma coluna passa', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (4, 'reescrever RETORNO_FINANCEIRO na mesma coluna passa', false, sqlerrm);
  end;

  -- CASO 5: a coluna status_acionamento tambem e vigiada.
  begin
    update public.alunos set status_acionamento = 'RETORNO_FINANCEIRO'
     where id = 'a0000005-0000-0000-0000-000000000005';
    insert into public._trava_teste values (5, 'status_acionamento tambem e barrado', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    insert into public._trava_teste values (5, 'status_acionamento tambem e barrado', true, sqlerrm);
  end;

  -- CASO 6: a coluna status_atual tambem e vigiada.
  begin
    update public.alunos set status_atual = 'RETORNO_FINANCEIRO'
     where id = 'a0000006-0000-0000-0000-000000000006';
    insert into public._trava_teste values (6, 'status_atual tambem e barrado', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    insert into public._trava_teste values (6, 'status_atual tambem e barrado', true, sqlerrm);
  end;

  -- CASO 7: INSERT -- a porta que o gatilho antigo nao cobria.
  begin
    insert into public.alunos (nome, status_jornada) values ('Nascendo em RF', 'RETORNO_FINANCEIRO');
    insert into public._trava_teste values (7, 'operador nao INSERE aluno com RETORNO_FINANCEIRO', false, 'o INSERT passou');
  exception when insufficient_privilege then
    insert into public._trava_teste values (7, 'operador nao INSERE aluno com RETORNO_FINANCEIRO', true, sqlerrm);
  end;

  -- CASO 8: INSERT comum segue livre -- cadastro de aluno novo nao pode quebrar.
  begin
    insert into public.alunos (nome, status_jornada) values ('Nascendo normal', 'CONTATAR');
    insert into public._trava_teste values (8, 'operador INSERE aluno com CONTATAR', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (8, 'operador INSERE aluno com CONTATAR', false, sqlerrm);
  end;

  -- ========================================================================
  -- CASO 14: A REGRESSAO QUE REPROVOU A PRIMEIRA VERSAO DESTA MIGRATION.
  --
  -- O aluno JA carrega RETORNO_FINANCEIRO (a gestao carimbou, e o caso seguiu
  -- na carteira do operador). Com o portao comparando CONJUNTOS (`&&`), isso
  -- bastava para destrancar cancelamento: `v_antigo` sobrepunha a lista
  -- bloqueada e o portao era pulado inteiro. E `trg_tabulacao_efeito_financeiro`
  -- nao tem portao proprio -- ia aplicar DEVOLVE_PARCELA.
  -- Com a decisao POR COLUNA, tem de barrar.
  -- ========================================================================
  begin
    update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA'
     where id = 'a0000014-0000-0000-0000-000000000014';
    insert into public._trava_teste values
      (14, 'aluno com RETORNO_FINANCEIRO nao destranca CANCELAMENTO', false,
       'o UPDATE passou: codigo so-gestao virou chave para encerrar cobranca');
  exception when insufficient_privilege then
    insert into public._trava_teste values
      (14, 'aluno com RETORNO_FINANCEIRO nao destranca CANCELAMENTO', true, sqlerrm);
  end;

  -- CASO 15: um codigo bloqueado nao destranca OUTRO codigo bloqueado.
  begin
    update public.alunos set status_jornada = 'JURIDICO'
     where id = 'a0000015-0000-0000-0000-000000000015';
    insert into public._trava_teste values
      (15, 'cancelado nao destranca JURIDICO', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    insert into public._trava_teste values (15, 'cancelado nao destranca JURIDICO', true, sqlerrm);
  end;

  -- CASO 16: nao se pode COPIAR codigo bloqueado de uma coluna para outra.
  -- `status_atual` ja e CANCELAMENTO; `status_jornada` nao -- e e status_jornada
  -- que dispara o efeito financeiro.
  begin
    update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA'
     where id = 'a0000016-0000-0000-0000-000000000016';
    insert into public._trava_teste values
      (16, 'nao copia codigo bloqueado de uma coluna para outra', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    insert into public._trava_teste values
      (16, 'nao copia codigo bloqueado de uma coluna para outra', true, sqlerrm);
  end;

  -- CASO 17: edicao de ROTINA num aluno que carrega codigo bloqueado tem de
  -- PASSAR. Sao os 182 de producao: se isto barrar, o operador perde a ficha
  -- deles. Aqui o operador tabula uma coluna comum e as bloqueadas ficam como
  -- estao -- o NEW as carrega iguais, e e por isso que a comparacao e por
  -- coluna e nao "existe codigo bloqueado no NEW?".
  begin
    update public.alunos set status_acionamento = 'MENSAGEM_ENVIADA'
     where id = 'a0000017-0000-0000-0000-000000000017';
    insert into public._trava_teste values
      (17, 'edicao de rotina em aluno ja cancelado passa', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values
      (17, 'edicao de rotina em aluno ja cancelado passa', false, sqlerrm);
  end;

  -- ========================================================================
  -- CASO 18: ESPACO NAO E DISFARCE. `v_bloqueadas` normaliza com
  -- `upper(btrim(codigo))`; se o lado do NEW nao fizesse `btrim`,
  -- 'CANCELAMENTO_COBRANCA ' passaria o portao. No servidor o valor ficaria
  -- inerte (os consumidores comparam por igualdade exata), mas `casoNoKpi` na
  -- Minha Carteira classifica por SUBSTRING dos status concatenados -- o caso
  -- apareceria como encerrado na tela sem nunca ter sido encerrado.
  -- ========================================================================
  begin
    update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA '
     where id = 'a0000010-0000-0000-0000-000000000010';
    insert into public._trava_teste values
      (18, 'codigo bloqueado com espaco sobrando tambem e barrado', false,
       'o UPDATE passou: espaco no fim driblou o portao');
  exception when insufficient_privilege then
    insert into public._trava_teste values
      (18, 'codigo bloqueado com espaco sobrando tambem e barrado', true, sqlerrm);
  end;

  -- CASO 9: a identidade vem do TOKEN. Mesma conexao, mesmo papel de banco --
  -- so o e-mail muda -- e a gestao passa onde o operador foi barrado. E a
  -- prova de que nao e o frontend que decide: aqui nao existe frontend.
  perform set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
  begin
    update public.alunos set status_jornada = 'RETORNO_FINANCEIRO'
     where id = 'a0000007-0000-0000-0000-000000000007';
    insert into public._trava_teste values (9, 'gestao grava RETORNO_FINANCEIRO', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (9, 'gestao grava RETORNO_FINANCEIRO', false, sqlerrm);
  end;

  -- CASO 10: gestao tambem INSERE, e tambem troca entre codigos bloqueados
  -- (o endurecimento dos casos 15 e 16 nao pode atingir quem e gestao).
  begin
    insert into public.alunos (nome, status_jornada) values ('Gestao criando em RF', 'RETORNO_FINANCEIRO');
    update public.alunos set status_jornada = 'JURIDICO'
     where id = 'a0000008-0000-0000-0000-000000000008';
    insert into public._trava_teste values (10, 'gestao INSERE e troca codigo bloqueado', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (10, 'gestao INSERE e troca codigo bloqueado', false, sqlerrm);
  end;

  -- CASO 11: SISTEMA -- cron/backfill nao podem quebrar. Sem e-mail no "token",
  -- `auth.jwt()` e null -> bypass de sistema. Este caso roda AQUI, na conexao
  -- de `teste_app`, e nao na de postgres: na de postgres ele ficaria verde pelo
  -- bypass de `session_user` e nao provaria o caminho do jwt nulo.
  perform set_config('teste.email', '', false);
  begin
    update public.alunos set status_jornada = 'RETORNO_FINANCEIRO'
     where id = 'a0000009-0000-0000-0000-000000000009';
    insert into public._trava_teste values
      (11, 'sistema (jwt nulo) grava sem ser barrado', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values
      (11, 'sistema (jwt nulo) grava sem ser barrado', false, sqlerrm);
  end;
end
$teste$;

-- ===========================================================================
-- MEXER NO CATÁLOGO (como postgres)
-- ===========================================================================
\connect "host=localhost port=5432 dbname=teste user=postgres password=postgres"

-- FAIL-CLOSED: desmarca CANCELAMENTO_COBRANCA no catálogo. O piso literal tem
-- de continuar barrando -- um UPDATE descuidado na tela /tabulacoes não pode
-- afrouxar a trava de encerramento que existe desde agosto.
update public.tabulacoes set somente_gestao = false where codigo = 'CANCELAMENTO_COBRANCA';

-- CATÁLOGO MANDA: marca uma tabulação comum. Tem de passar a barrar sozinha,
-- sem migration nova -- é o ganho desta migration.
update public.tabulacoes set somente_gestao = true where codigo = 'AGUARDANDO_BAIXA';

\connect "host=localhost port=5432 dbname=teste user=teste_app password=teste"

set session "teste.email" = 'cobranca05@aelbra.com.br';
set session "teste.role"  = 'authenticated';

do $teste$
begin
  -- CASO 12: FAIL-CLOSED -- catalogo desmarcado, piso literal ainda barra.
  begin
    update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA'
     where id = 'a0000012-0000-0000-0000-000000000012';
    insert into public._trava_teste values
      (12, 'piso literal barra mesmo com o catalogo desmarcado', false,
       'o UPDATE passou: desmarcar no catalogo afrouxou a trava de encerramento');
  exception when insufficient_privilege then
    insert into public._trava_teste values
      (12, 'piso literal barra mesmo com o catalogo desmarcado', true, sqlerrm);
  end;

  -- CASO 13: CATALOGO MANDA -- tabulacao comum marcada passa a ser barrada.
  begin
    update public.alunos set status_jornada = 'AGUARDANDO_BAIXA'
     where id = 'a0000013-0000-0000-0000-000000000013';
    insert into public._trava_teste values
      (13, 'catalogo manda: tabulacao recem-marcada passa a barrar', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    insert into public._trava_teste values
      (13, 'catalogo manda: tabulacao recem-marcada passa a barrar', true, sqlerrm);
  end;
end
$teste$;

-- ===========================================================================
-- VEREDITO (como postgres)
-- ===========================================================================
\connect "host=localhost port=5432 dbname=teste user=postgres password=postgres"

-- Devolve o catálogo ao estado real, para o arquivo poder rodar duas vezes.
update public.tabulacoes set somente_gestao = true  where codigo = 'CANCELAMENTO_COBRANCA';
update public.tabulacoes set somente_gestao = false where codigo = 'AGUARDANDO_BAIXA';

\echo ''
\echo '=== TRAVA DE TABULACAO SOMENTE GESTAO — 19 casos (0 a 18) ==='
select n, case when ok then 'OK  ' else 'FALHOU' end as resultado, caso, left(coalesce(detalhe,''), 90) as detalhe
  from public._trava_teste order by n;

do $$
declare
  v_faltou int;
  v_falhou int;
begin
  select count(*) into v_falhou from public._trava_teste where not ok;
  select 19 - count(distinct n) into v_faltou from public._trava_teste;

  if v_faltou <> 0 then
    raise exception 'faltaram % casos: algum bloco morreu antes de registrar o resultado', v_faltou;
  end if;
  if v_falhou <> 0 then
    raise exception '% caso(s) FALHARAM -- ver a tabela acima', v_falhou;
  end if;
  raise notice 'todos os 19 casos passaram';
end
$$;
