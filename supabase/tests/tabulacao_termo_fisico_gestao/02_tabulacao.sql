-- Tabulação restrita à gestão: gestão permitida, operador recusado, e ausência
-- de efeitos fora do histórico. Roda DEPOIS da migration.
\set ON_ERROR_STOP on

-- ---------- Catálogo ----------
select public.teste_assert('catálogo: as duas linhas existem, ativas, somente gestão, sem efeito financeiro e sem retorno',
  (select count(*) from public.tabulacoes
    where codigo in ('TERMO_FISICO_EM_ANDAMENTO','TERMO_FISICO_ARQUIVADO')
      and ativa and somente_gestao and efeito_desfecho is null
      and retorno_modo = 'NENHUM' and proxima_acao = 'CONTATAR') = 2);

select public.teste_assert('catálogo: rótulos aprovados preservados',
  (select rotulo from public.tabulacoes where codigo = 'TERMO_FISICO_EM_ANDAMENTO') = 'Possui termo físico assinado, em andamento'
  and (select rotulo from public.tabulacoes where codigo = 'TERMO_FISICO_ARQUIVADO') = 'Termo físico arquivado, quitado');

-- ---------- Operador recusado (servidor) ----------
select public.teste_assert('operador: não grava TERMO_FISICO_EM_ANDAMENTO no histórico (42501)',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_EM_ANDAMENTO','operador.teste@exemplo.local')$sql$)->>'code' = '42501');

select public.teste_assert('operador: não grava TERMO_FISICO_ARQUIVADO mesmo com espaço e minúsculas (42501)',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','FINALIZACAO_ATENDIMENTO',' termo_fisico_arquivado ','operador.teste@exemplo.local')$sql$)->>'code' = '42501');

select public.teste_assert('operador: a mensagem de recusa diz que a tabulação é restrita à gestão',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','FINALIZACAO_ATENDIMENTO','TERMO_FISICO_ARQUIVADO','operador.teste@exemplo.local')$sql$)->>'err' like '%restrita à gestão%');

-- Operador continua gravando tabulação comum (não foi bloqueado em geral).
select public.teste_assert('operador: grava tabulação comum normalmente',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','FINALIZACAO_ATENDIMENTO','CONTATAR','operador.teste@exemplo.local')$sql$)->>'ok' = 'true');

select public.teste_assert('operador: grava movimentação sem status (ex.: observação) normalmente',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email)
         values ('a1','CONTATO','obs','operador.teste@exemplo.local')$sql$)->>'ok' = 'true');


-- Espaços em branco que o btrim não removia (tab, quebra de linha, retorno).
select public.teste_assert('operador: recusado com TAB, quebra de linha e retorno ao redor do código (42501)',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    E'insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email) values (\'a1\',\'FINALIZACAO_ATENDIMENTO\',E\'\\tTERMO_FISICO_ARQUIVADO\\n\\r\',\'operador.teste@exemplo.local\')')->>'code' = '42501');

-- UPDATE do operador em status_novo: negado (sem privilégio, e a trigger cobre UPDATE OF status_novo).
-- UPDATE do operador em status_novo de movimentação da gestão: a trigger (UPDATE OF status_novo) recusa.
-- Fixture legítimo: a movimentação de REGISTRO é da GESTÃO ATIVA (Amanda), não do operador.
select public.teste_assert('fixture: gestão ativa grava REGISTRO de termo para o aluno a2',
  public.teste_comando('authenticated', 'gestao.titular@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, descricao, registrado_por_email)
         values ('a2','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_EM_ANDAMENTO','Registro administrativo do termo físico.','gestao.titular@exemplo.local')$sql$)->>'ok' = 'true');
-- UPDATE do operador: sem policy de UPDATE (como em produção) a RLS afeta zero linhas; a linha da gestão não muda.
select public.teste_comando('authenticated', 'operador.teste@exemplo.local',
  'update public.aluno_movimentacoes set status_novo = ''TERMO_FISICO_ARQUIVADO'' where aluno_id = ''a2''');
-- Verificação como AUTHENTICATED (a policy de SELECT é 'to authenticated'; app_teste NOINHERIT não a aplica).
select public.teste_assert('operador: o status da movimentação continua o mesmo após a tentativa',
  (public.teste_consulta('authenticated','operador.teste@exemplo.local',
    $sql$select 1 from public.aluno_movimentacoes where aluno_id = 'a2' and status_novo = 'TERMO_FISICO_EM_ANDAMENTO'$sql$)->>'ok') = 'true'
  and (public.teste_consulta('authenticated','operador.teste@exemplo.local',
    $sql$select 1 from public.aluno_movimentacoes where aluno_id = 'a2' and status_novo = 'TERMO_FISICO_EM_ANDAMENTO'$sql$)->'rows') is not null
  and (select jsonb_array_length((public.teste_consulta('authenticated','operador.teste@exemplo.local',
    $sql$select 1 from public.aluno_movimentacoes where aluno_id = 'a2' and status_novo = 'TERMO_FISICO_EM_ANDAMENTO'$sql$))->'rows')) = 1);

-- Unicode invisível: a normalização [A-Z0-9_] não deixa passar.
select public.teste_assert('operador: recusado com U+200B, U+FEFF, U+00A0 e U+3000 ao redor do código (42501)',
  (public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    E'insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email) values (\'a1\',\'FINALIZACAO_ATENDIMENTO\',E\'\\u200B\\uFEFFTERMO_FISICO_ARQUIVADO\\u00A0\\u3000\',\'operador.teste@exemplo.local\')')->>'code' = '42501'));


-- Locale: caracteres que o upper() converte em ASCII em alguns locales (dotless i, long s).
-- Remoção ASCII ANTES do upper: 'TERMO_FIıSICO_ARQUIVADO' vira 'TERMO_FISICO_ARQUIVADO' e é recusado.
select public.teste_assert('operador: recusado com ı (U+0131) no meio do código (42501)',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','FINALIZACAO_ATENDIMENTO','TERMO_FIıSICO_ARQUIVADO','operador.teste@exemplo.local')$sql$)->>'code' = '42501');
select public.teste_assert('operador: recusado com ſ (U+017F) no código (42501)',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','FINALIZACAO_ATENDIMENTO','TERMO_FISICOſ_ARQUIVADO','operador.teste@exemplo.local')$sql$)->>'code' = '42501');


-- Desfazer do operador que restauraria código restrito: recusado inteiro, com mensagem clara.
select public.teste_assert('desfazer: operador não restaura código restrito (42501 e "Nada foi desfeito")',
  (public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','ACAO_DESFEITA','TERMO_FISICO_ARQUIVADO','operador.teste@exemplo.local')$sql$)->>'err') like '%Nada foi desfeito%');

-- Sem perfil e diretoria: nenhum é gestão, a trigger recusa.
select public.teste_assert('usuário sem perfil (fora de usuario_e_gestao): recusado (42501)',
  public.teste_comando('authenticated', 'semperfil@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','FINALIZACAO_ATENDIMENTO','TERMO_FISICO_ARQUIVADO','semperfil@exemplo.local')$sql$)->>'code' = '42501');
select public.teste_assert('diretoria (fora da lista de gestão): recusada (42501)',
  public.teste_comando('authenticated', 'diretoria.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','FINALIZACAO_ATENDIMENTO','TERMO_FISICO_ARQUIVADO','diretoria.teste@exemplo.local')$sql$)->>'code' = '42501');

-- anon: sem nenhum privilégio de INSERT no histórico.
select public.teste_assert('anon: não grava no histórico (42501)',
  public.teste_comando('anon', null,
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo) values ('a1','FINALIZACAO_ATENDIMENTO','TERMO_FISICO_ARQUIVADO')$sql$)->>'code' = '42501');

-- Código restrito que NÃO é dos dois (ex.: RETORNO_FINANCEIRO) não é barrado por esta mudança.
select public.teste_assert('escopo: RETORNO_FINANCEIRO não é barrado por esta mudança (desfazer preservado)',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','ACAO_DESFEITA','RETORNO_FINANCEIRO','operador.teste@exemplo.local')$sql$)->>'ok' = 'true');


-- ---------- Gestão permitida ----------
select public.teste_assert('gestão (Amanda): grava TERMO_FISICO_EM_ANDAMENTO no histórico',
  public.teste_comando('authenticated', 'gestao.titular@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, descricao, registrado_por_email, registrado_por_nome)
         values ('a1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_EM_ANDAMENTO','registro','gestao.titular@exemplo.local','Amanda')$sql$)->>'ok' = 'true');

select public.teste_assert('gestão (ADM): grava TERMO_FISICO_ARQUIVADO no histórico',
  public.teste_comando('authenticated', 'gestao.c@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, descricao, registrado_por_email)
         values ('a1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','registro','gestao.c@exemplo.local')$sql$)->>'ok' = 'true');

select public.teste_assert('gestão (Fernanda): grava TERMO_FISICO_ARQUIVADO no histórico',
  public.teste_comando('authenticated', 'gestao.b@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, descricao, registrado_por_email)
         values ('a1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','registro','gestao.b@exemplo.local')$sql$)->>'ok' = 'true');

-- Histórico: data, hora e autor gravados.
-- Leitura como gestão (select using true): visibilidade completa; controle positivo = 1 linha.
select public.teste_assert('histórico: registro tem autor, data e hora',
  (select jsonb_array_length((public.teste_consulta('authenticated','gestao.titular@exemplo.local',
    $q$select 1 from public.aluno_movimentacoes
    where aluno_id = 'a1' and status_novo = 'TERMO_FISICO_EM_ANDAMENTO' and registrado_por_email = 'gestao.titular@exemplo.local'
      and registrado_em is not null and tipo = 'REGISTRO_ADMINISTRATIVO'$q$))->'rows')) = 1);

-- ---------- Ausência de efeitos ----------
select public.teste_assert('sem contato: o tipo REGISTRO_ADMINISTRATIVO NÃO é acionamento',
  public.eh_tipo_acionamento('REGISTRO_ADMINISTRATIVO') = false);

select public.teste_assert('sem efeito financeiro: catálogo do registro tem efeito_desfecho NULL',
  (select count(*) from public.tabulacoes where codigo like 'TERMO_FISICO_%' and efeito_desfecho is not null) = 0);

select public.teste_assert('sem retorno: registro não define retorno nem próxima ação diferente de CONTATAR',
  (select count(*) from public.tabulacoes where codigo like 'TERMO_FISICO_%' and (retorno_modo <> 'NENHUM' or proxima_acao <> 'CONTATAR')) = 0);

-- service_role (claim) NÃO tem bypass: a claim não é prova de identidade (B2). Sem caminho de serviço
-- documentado para estes códigos, a recusa é a regra. Mensagem e SQLSTATE exatos; nada gravado.
select public.teste_assert('service_role (claim): recusado com mensagem exata, sem linha gravada',
  (public.teste_comando('service_role', 'sistema@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','SISTEMA','TERMO_FISICO_ARQUIVADO','sistema@exemplo.local')$sql$)->>'code' = '42501')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','gestao.titular@exemplo.local',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'a1' and tipo = 'SISTEMA'$q$))->'rows')) = 0);

-- Triagem Prime: a descrição padronizada NÃO casa com as palavras que a triagem procura.
-- Texto idêntico ao de DESCRICAO_REGISTRO_ADMINISTRATIVO (src/utils/tabulacoes.js).
select public.teste_assert('fixture: gestão grava REGISTRO para a3 (descrição padronizada)',
  public.teste_comando('authenticated','gestao.titular@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, descricao, registrado_por_email)
         values ('a3','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','Registro administrativo do termo físico.','gestao.titular@exemplo.local')$sql$)->>'ok' = 'true');
-- Controle positivo: o fixture a3 existe e é visível à gestão (1 linha) antes de afirmar 0 palavras-chave.
select public.teste_assert('triagem Prime: fixture a3 visível (controle positivo)',
  (select jsonb_array_length((public.teste_consulta('authenticated','gestao.titular@exemplo.local',
    $q$select 1 from public.aluno_movimentacoes where aluno_id = 'a3'$q$))->'rows')) = 1);
select public.teste_assert('triagem Prime: descrição padronizada não ativa nenhuma palavra-chave',
  (select jsonb_array_length((public.teste_consulta('authenticated','gestao.titular@exemplo.local',
    $q$select 1 from public.aluno_movimentacoes
    where aluno_id = 'a3'
      and (descricao ilike '%fies%' or descricao ilike '%isen%' or descricao ilike '%bolsa%'
           or descricao ilike '%tranc%' or (descricao ilike '%cancel%' and descricao ilike '%matr%')
           or descricao ilike '%desist%')$q$))->'rows')) = 0);

-- Não é acionamento (lista de tipos de produção) e não tem efeito financeiro.
select public.teste_assert('não é acionamento: tipo REGISTRO_ADMINISTRATIVO fora de eh_tipo_acionamento',
  public.eh_tipo_acionamento('REGISTRO_ADMINISTRATIVO') = false);
