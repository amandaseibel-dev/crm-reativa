-- REGISTRO_ADMINISTRATIVO: autorização e ausência de efeitos IMPOSTAS NO BANCO (INSERT e UPDATE).
-- Roda depois da migração. Usa o mesmo ambiente simulado dos demais testes.
\set ON_ERROR_STOP on

-- ---------- Legítimos: gestão, dois códigos ----------
select public.teste_assert('legítimo: gestão (Amanda) grava REGISTRO + EM_ANDAMENTO',
  public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,descricao,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_EM_ANDAMENTO','Registro administrativo do termo físico.','amanda.seibel@aelbra.com.br')$sql$)->>'ok' = 'true');
select public.teste_assert('legítimo: gestão (ADM) grava REGISTRO + ARQUIVADO',
  public.teste_comando('authenticated','cobranca07@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,descricao,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','Registro administrativo do termo físico.','cobranca07@aelbra.com.br')$sql$)->>'ok' = 'true');
select public.teste_assert('legítimo: gestão (Fernanda) grava REGISTRO + ARQUIVADO',
  public.teste_comando('authenticated','cobranca04@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,descricao,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','Registro administrativo do termo físico.','cobranca04@aelbra.com.br')$sql$)->>'ok' = 'true');

-- ---------- Negados: operador e quem não é gestão ----------
select public.teste_assert('negado: operador não grava REGISTRO com código restrito (42501)',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_EM_ANDAMENTO','operador.teste@exemplo.local')$sql$)->>'code' = '42501');
select public.teste_assert('negado: usuário sem perfil não grava REGISTRO (42501)',
  public.teste_comando('authenticated','semperfil@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','semperfil@exemplo.local')$sql$)->>'code' = '42501');
select public.teste_assert('negado: diretoria não grava REGISTRO (42501)',
  public.teste_comando('authenticated','diretoria.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','diretoria.teste@exemplo.local')$sql$)->>'code' = '42501');

-- ---------- Negados: gestão, mas código não permitido para o registro ----------
select public.teste_assert('negado: gestão não grava REGISTRO com código comum (42501)',
  public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','CONTATAR','amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501');
select public.teste_assert('negado: gestão não grava REGISTRO sem código (42501)',
  public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO',null,'amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501');

-- ---------- Negados: campos operacionais no registro (sem efeito operacional) ----------
select public.teste_assert('negado: REGISTRO com data de retorno é recusado (42501)',
  public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,data_retorno,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO',now()+interval '2 days','amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501');
select public.teste_assert('negado: REGISTRO com status anterior é recusado (42501)',
  public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_anterior,status_novo,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','CONTATAR','TERMO_FISICO_ARQUIVADO','amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501');
select public.teste_assert('negado: REGISTRO com valor é recusado (42501)',
  public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,valor_movimentacao,registrado_por_email)
         values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO',100,'amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501');

-- ---------- Burla por tipo, código, espaço e Unicode ----------
select public.teste_assert('burla: FINALIZACAO com código restrito é recusada para operador (42501)',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
         values ('r1','FINALIZACAO_ATENDIMENTO','TERMO_FISICO_ARQUIVADO','operador.teste@exemplo.local')$sql$)->>'code' = '42501');
select public.teste_assert('burla: código restrito com espaço/tab/Unicode no REGISTRO é recusado para operador (42501)',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    E'insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email) values (\'r1\',\'REGISTRO_ADMINISTRATIVO\',\'\\u200B TERMO_FISICO_ARQUIVADO\\t\',\'operador.teste@exemplo.local\')')->>'code' = '42501');
select public.teste_assert('burla: UPDATE do operador mudando tipo ou código não altera nenhuma linha da gestão',
  (public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$update public.aluno_movimentacoes set tipo = 'FINALIZACAO_ATENDIMENTO', status_novo = 'TERMO_FISICO_ARQUIVADO' where aluno_id = 'r1' and registrado_por_email = 'amanda.seibel@aelbra.com.br'$sql$)->>'ok') in ('true','false')
  and (select count(*) from public.aluno_movimentacoes where aluno_id = 'r1' and tipo = 'REGISTRO_ADMINISTRATIVO') >= 1
  and (select count(*) from public.aluno_movimentacoes where aluno_id = 'r1' and tipo = 'FINALIZACAO_ATENDIMENTO') = 0);
-- UPDATE do operador que tenta criar REGISTRO a partir de FINALIZACAO: nenhuma linha muda (sem policy de UPDATE).
insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
  values ('r9','FINALIZACAO_ATENDIMENTO','CONTATAR','operador.teste@exemplo.local');
select public.teste_comando('authenticated','operador.teste@exemplo.local',
  $sql$update public.aluno_movimentacoes set tipo = 'REGISTRO_ADMINISTRATIVO', status_novo = 'TERMO_FISICO_ARQUIVADO' where aluno_id = 'r9'$sql$);
select public.teste_assert('burla: UPDATE do operador não criou REGISTRO a partir de FINALIZACAO',
  (select count(*) from public.aluno_movimentacoes where aluno_id = 'r9' and tipo = 'REGISTRO_ADMINISTRATIVO') = 0
  and (select count(*) from public.aluno_movimentacoes where aluno_id = 'r9' and tipo = 'FINALIZACAO_ATENDIMENTO') = 1);

-- ---------- Ausência de efeitos operacionais no aluno ----------
select public.teste_assert('efeito: gravar REGISTRO não altera o estado do aluno (status_atual, jornada, acionamento)',
  (select status_atual||'|'||status_jornada||'|'||status_acionamento from public.alunos where id = 'a0000000-0000-0000-0000-000000000042') = 'CONTATAR|CONTATAR|CONTATAR');
select public.teste_assert('efeito: tipo REGISTRO_ADMINISTRATIVO não é acionamento',
  public.eh_tipo_acionamento('REGISTRO_ADMINISTRATIVO') = false);
