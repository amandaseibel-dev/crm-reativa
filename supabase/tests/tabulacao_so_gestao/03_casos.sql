-- CASOS — 13 cenários de permissão para a trava de tabulação somente gestão
--
-- Pré-condição: 01_ambiente.sql + 02_baseline.sql + o SQL de
-- 20261106140000_tabulacao_so_gestao_no_banco aplicados, nesta ordem.
--
-- COMO ESTE TESTE TROCA DE USUÁRIO, E POR QUE ASSIM:
--   * QUEM é a pessoa  -> GUC `teste.email`, que o stub de `auth.jwt()` lê.
--     É o análogo do token: a autorização nunca vem de argumento de função.
--   * QUAL é a conexão -> `\connect`, porque o gatilho libera
--     `session_user in ('postgres', ...)` e o CI roda psql como postgres.
--     Sem reconectar como `teste_app`, a trava não dispararia e os 13 casos
--     passariam sem testar nada. `set role` não serve: muda `current_user`,
--     não `session_user`.
--
-- A tabela de resultado é COMUM (não temporária) de propósito: tabela temp
-- morre no `\connect`, e este teste atravessa cinco conexões.

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

-- Fixtures. Dois alunos já carregam código só-gestão: em produção são 182, e
-- é por eles que a cláusula "só barra quando é NOVO" tem de continuar valendo.
insert into public.alunos (id, nome, status_atual, status_jornada, status_acionamento) values
  ('11111111-1111-1111-1111-111111111111','Aluno comum',        'CONTATAR','CONTATAR','CONTATAR'),
  ('22222222-2222-2222-2222-222222222222','Aluno ja em RF',     'RETORNO_FINANCEIRO','RETORNO_FINANCEIRO','RETORNO_FINANCEIRO'),
  ('33333333-3333-3333-3333-333333333333','Aluno ja cancelado', 'CANCELAMENTO_COBRANCA','CANCELAMENTO_COBRANCA','CANCELAMENTO_COBRANCA'),
  ('44444444-4444-4444-4444-444444444444','Aluno comum 2',      'CONTATAR','CONTATAR','CONTATAR')
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
  v_novo uuid;
begin
  -- Antes de tudo: a conexão é mesmo de não-superusuário? Se for postgres, o
  -- bypass de sistema liga e o resto do arquivo mente.
  if session_user = 'postgres' then
    raise exception 'CASO 0 falhou: a conexao continua como postgres, a trava nao seria exercida';
  end if;
  insert into public._trava_teste values
    (0, 'conexao de operador e sem superusuario', true, 'session_user=' || session_user);

  -- CASO 1: operador NAO grava RETORNO_FINANCEIRO. E a mensagem tem de dizer a
  -- verdade: restrita a gestao, SEM falar em "Encerrar cobranca".
  begin
    update public.alunos set status_jornada = 'RETORNO_FINANCEIRO'
     where id = '11111111-1111-1111-1111-111111111111';
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
     where id = '11111111-1111-1111-1111-111111111111';
    insert into public._trava_teste values (2, 'operador barrado em CANCELAMENTO_COBRANCA', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    v_erro := sqlerrm;
    insert into public._trava_teste values
      (2, 'operador barrado em CANCELAMENTO_COBRANCA', v_erro like '%Encerrar cobrança%', v_erro);
  end;

  -- CASO 3: tabulacao COMUM segue livre. A trava nao pode vazar para o resto.
  begin
    update public.alunos set status_jornada = 'MENSAGEM_ENVIADA'
     where id = '11111111-1111-1111-1111-111111111111';
    insert into public._trava_teste values (3, 'operador tabula MENSAGEM_ENVIADA', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (3, 'operador tabula MENSAGEM_ENVIADA', false, sqlerrm);
  end;

  -- CASO 4: reescrever codigo JA gravado passa. Sem isto, qualquer edicao na
  -- ficha dos 182 alunos de producao passaria a falhar para o operador.
  begin
    update public.alunos set status_atual = 'RETORNO_FINANCEIRO'
     where id = '22222222-2222-2222-2222-222222222222';
    insert into public._trava_teste values (4, 'reescrever RETORNO_FINANCEIRO ja gravado passa', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (4, 'reescrever RETORNO_FINANCEIRO ja gravado passa', false, sqlerrm);
  end;

  -- CASO 5: a terceira coluna tambem e vigiada (status_acionamento).
  begin
    update public.alunos set status_acionamento = 'RETORNO_FINANCEIRO'
     where id = '44444444-4444-4444-4444-444444444444';
    insert into public._trava_teste values (5, 'status_acionamento tambem e barrado', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    insert into public._trava_teste values (5, 'status_acionamento tambem e barrado', true, sqlerrm);
  end;

  -- CASO 6: status_atual tambem e vigiado.
  begin
    update public.alunos set status_atual = 'RETORNO_FINANCEIRO'
     where id = '44444444-4444-4444-4444-444444444444';
    insert into public._trava_teste values (6, 'status_atual tambem e barrado', false, 'o UPDATE passou');
  exception when insufficient_privilege then
    insert into public._trava_teste values (6, 'status_atual tambem e barrado', true, sqlerrm);
  end;

  -- CASO 7: INSERT -- a porta que o gatilho antigo nao cobria.
  begin
    insert into public.alunos (nome, status_jornada) values ('Nascendo em RF', 'RETORNO_FINANCEIRO')
      returning id into v_novo;
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

  -- CASO 9: a identidade vem do TOKEN. Mesma conexao, mesmo papel de banco --
  -- so o e-mail muda -- e a gestao passa onde o operador foi barrado. E a
  -- prova de que nao e o frontend que decide: aqui nao existe frontend.
  perform set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
  begin
    update public.alunos set status_jornada = 'RETORNO_FINANCEIRO'
     where id = '11111111-1111-1111-1111-111111111111';
    insert into public._trava_teste values (9, 'gestao grava RETORNO_FINANCEIRO', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (9, 'gestao grava RETORNO_FINANCEIRO', false, sqlerrm);
  end;

  -- CASO 10: gestao tambem INSERE.
  begin
    insert into public.alunos (nome, status_jornada) values ('Gestao criando em RF', 'RETORNO_FINANCEIRO');
    insert into public._trava_teste values (10, 'gestao INSERE aluno com RETORNO_FINANCEIRO', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (10, 'gestao INSERE aluno com RETORNO_FINANCEIRO', false, sqlerrm);
  end;
end
$teste$;

-- ===========================================================================
-- SISTEMA e CATÁLOGO (como postgres)
-- ===========================================================================
\connect "host=localhost port=5432 dbname=teste user=postgres password=postgres"

do $teste$
begin
  -- CASO 11: cron/backfill/service_role nao podem quebrar. Sem e-mail no
  -- "token", `auth.jwt()` e null -> bypass de sistema.
  perform set_config('teste.email', '', true);
  begin
    update public.alunos set status_jornada = 'RETORNO_FINANCEIRO'
     where id = '44444444-4444-4444-4444-444444444444';
    insert into public._trava_teste values (11, 'sistema grava sem ser barrado', true, 'passou, como deve');
  exception when others then
    insert into public._trava_teste values (11, 'sistema grava sem ser barrado', false, sqlerrm);
  end;
end
$teste$;

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
     where id = '11111111-1111-1111-1111-111111111111';
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
     where id = '11111111-1111-1111-1111-111111111111';
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
\echo '=== TRAVA DE TABULACAO SOMENTE GESTAO — 14 casos (0 a 13) ==='
select n, case when ok then 'OK  ' else 'FALHOU' end as resultado, caso, left(coalesce(detalhe,''), 90) as detalhe
  from public._trava_teste order by n;

do $$
declare
  v_faltou int;
  v_falhou int;
begin
  select count(*) into v_falhou from public._trava_teste where not ok;
  select 14 - count(distinct n) into v_faltou from public._trava_teste;

  if v_faltou <> 0 then
    raise exception 'faltaram % casos: algum bloco morreu antes de registrar o resultado', v_faltou;
  end if;
  if v_falhou <> 0 then
    raise exception '% caso(s) FALHARAM -- ver a tabela acima', v_falhou;
  end if;
  raise notice 'todos os 14 casos passaram';
end
$$;
