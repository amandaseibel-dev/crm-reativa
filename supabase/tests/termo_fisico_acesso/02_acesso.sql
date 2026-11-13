-- Cenários de acesso com a migration aplicada. Falha o script no primeiro erro.
-- Papéis reais do Postgres (set role); e-mails de JWT simulados.

\set ON_ERROR_STOP on

-- ---------- Privilégios diretos (matriz, não depende de erro de função) ----------
select public.teste_assert('privilégio: anon sem nenhum acesso à tabela',
  not has_table_privilege('anon', 'public.aluno_termo_fisico_eventos', 'SELECT')
  and not has_table_privilege('anon', 'public.aluno_termo_fisico_eventos', 'INSERT')
  and not has_table_privilege('anon', 'public.aluno_termo_fisico_eventos', 'UPDATE')
  and not has_table_privilege('anon', 'public.aluno_termo_fisico_eventos', 'DELETE')
  and not has_table_privilege('anon', 'public.aluno_termo_fisico_eventos', 'TRUNCATE'));

select public.teste_assert('privilégio: service_role sem nenhum acesso à tabela',
  not has_table_privilege('service_role', 'public.aluno_termo_fisico_eventos', 'SELECT')
  and not has_table_privilege('service_role', 'public.aluno_termo_fisico_eventos', 'INSERT')
  and not has_table_privilege('service_role', 'public.aluno_termo_fisico_eventos', 'UPDATE')
  and not has_table_privilege('service_role', 'public.aluno_termo_fisico_eventos', 'DELETE')
  and not has_table_privilege('service_role', 'public.aluno_termo_fisico_eventos', 'TRUNCATE'));

select public.teste_assert('privilégio: authenticated só tem SELECT (RLS restringe a leitura)',
  has_table_privilege('authenticated', 'public.aluno_termo_fisico_eventos', 'SELECT')
  and not has_table_privilege('authenticated', 'public.aluno_termo_fisico_eventos', 'INSERT')
  and not has_table_privilege('authenticated', 'public.aluno_termo_fisico_eventos', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.aluno_termo_fisico_eventos', 'DELETE')
  and not has_table_privilege('authenticated', 'public.aluno_termo_fisico_eventos', 'TRUNCATE'));

select public.teste_assert('privilégio: public e anon não executam as RPCs nem a trigger',
  not has_function_privilege('public', 'public.termo_fisico_ler(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.termo_fisico_ler(text)', 'EXECUTE')
  and not has_function_privilege('public', 'public.termo_fisico_registrar(text,text,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.termo_fisico_registrar(text,text,boolean)', 'EXECUTE')
  and not has_function_privilege('public', 'public.aluno_termo_fisico_eventos_imutavel()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.aluno_termo_fisico_eventos_imutavel()', 'EXECUTE'));

select public.teste_assert('privilégio: service_role não executa as RPCs nem a trigger',
  not has_function_privilege('service_role', 'public.termo_fisico_ler(text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.termo_fisico_registrar(text,text,boolean)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.aluno_termo_fisico_eventos_imutavel()', 'EXECUTE'));

select public.teste_assert('privilégio: authenticated executa as duas RPCs',
  has_function_privilege('authenticated', 'public.termo_fisico_ler(text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.termo_fisico_registrar(text,text,boolean)', 'EXECUTE'));

-- ---------- Anônimo ----------
select public.teste_assert('anon: não lê a tabela',
  public.teste_consulta('anon', null, 'select * from public.aluno_termo_fisico_eventos')->>'ok' = 'false');
select public.teste_assert('anon: não executa termo_fisico_ler',
  public.teste_consulta('anon', null, 'select public.termo_fisico_ler(''42'')')->>'ok' = 'false');
select public.teste_assert('anon: não executa termo_fisico_registrar',
  public.teste_comando('anon', null, 'select public.termo_fisico_registrar(''42'',''ARQUIVADO'',false)')->>'ok' = 'false');

-- ---------- Gestão registra; operador não vê nada ----------
select public.teste_assert('gestão (Amanda): registra em andamento, com aviso',
  public.teste_comando('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_registrar(''42'',''EM_ANDAMENTO'',true)')->>'ok' = 'true');

-- Operador: a leitura direta não traz linha nenhuma (RLS), sem erro.
select public.teste_assert('operador: lê a tabela e não vê nenhuma linha',
  public.teste_consulta('authenticated', 'operador.teste@exemplo.local',
    'select * from public.aluno_termo_fisico_eventos')->>'ok' = 'true'
  and jsonb_array_length((public.teste_consulta('authenticated', 'operador.teste@exemplo.local',
    'select * from public.aluno_termo_fisico_eventos')->'rows')) = 0);
select public.teste_assert('operador: não executa termo_fisico_ler',
  public.teste_consulta('authenticated', 'operador.teste@exemplo.local',
    'select public.termo_fisico_ler(''42'')')->>'ok' = 'false');
select public.teste_assert('operador: não executa termo_fisico_registrar',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    'select public.termo_fisico_registrar(''42'',''ARQUIVADO'',false)')->>'ok' = 'false');
select public.teste_assert('operador: não insere direto na tabela',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    $sql$insert into public.aluno_termo_fisico_eventos (aluno_id, situacao, autor_email)
         values ('42','ARQUIVADO','x@y')$sql$)->>'ok' = 'false');
select public.teste_assert('operador: não atualiza nem apaga direto',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    'update public.aluno_termo_fisico_eventos set situacao=''ARQUIVADO''')->>'ok' = 'false'
  and public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    'delete from public.aluno_termo_fisico_eventos')->>'ok' = 'false');
select public.teste_assert('operador: não consegue TRUNCATE',
  public.teste_comando('authenticated', 'operador.teste@exemplo.local',
    'truncate public.aluno_termo_fisico_eventos')->>'ok' = 'false');

-- Notificações: o operador não recebe nem vê aviso de termo físico.
select public.teste_assert('operador: não vê aviso de termo físico',
  jsonb_array_length((public.teste_consulta('authenticated', 'operador.teste@exemplo.local',
    $sql$select id from public.notificacoes where tipo = 'TERMO_FISICO'$sql$)->'rows')) = 0);

-- ---------- Gestão: leitura, validação, histórico ----------
select public.teste_assert('gestão (Amanda): lê situação e 1 registro com autor',
  (public.teste_consulta('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_ler(''42'') as r')->'rows'->0->'r'->>'situacao') = 'EM_ANDAMENTO'
  and jsonb_array_length(public.teste_consulta('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_ler(''42'') as r')->'rows'->0->'r'->'eventos') = 1
  and (public.teste_consulta('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_ler(''42'') as r')->'rows'->0->'r'->'eventos'->0->>'autor_email') = 'amanda.seibel@aelbra.com.br');

select public.teste_assert('ADM (cobranca07): registra arquivado, com aviso',
  public.teste_comando('authenticated', 'cobranca07@aelbra.com.br',
    'select public.termo_fisico_registrar(''42'',''ARQUIVADO'',true)')->>'ok' = 'true');
select public.teste_assert('ADM: lê situação ARQUIVADO e 2 registros',
  (public.teste_consulta('authenticated', 'cobranca07@aelbra.com.br',
    'select public.termo_fisico_ler(''42'') as r')->'rows'->0->'r'->>'situacao') = 'ARQUIVADO'
  and jsonb_array_length(public.teste_consulta('authenticated', 'cobranca07@aelbra.com.br',
    'select public.termo_fisico_ler(''42'') as r')->'rows'->0->'r'->'eventos') = 2);

select public.teste_assert('gestão: situação inválida é recusada',
  public.teste_comando('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_registrar(''42'',''QUITADO'',false)')->>'ok' = 'false');
select public.teste_assert('gestão: aluno vazio é recusado',
  public.teste_comando('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_registrar(''  '',''ARQUIVADO'',false)')->>'ok' = 'false');

-- ---------- Avisos: só para os destinatários, nunca para o autor ----------
select public.teste_assert('aviso: registro da Amanda avisa ADM e Fernanda; o da ADM avisa Amanda e Fernanda',
  (select array_agg(usuario_destino_email order by usuario_destino_email)
     from public.notificacoes where tipo = 'TERMO_FISICO')
  = array['amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br']::text[]);

select public.teste_assert('Fernanda lê o próprio aviso',
  jsonb_array_length(public.teste_consulta('authenticated', 'cobranca04@aelbra.com.br',
    $sql$select id from public.notificacoes where tipo = 'TERMO_FISICO'$sql$)->'rows') >= 1);

-- ---------- Dono e service_role: nenhuma alteração do histórico ----------
select public.teste_assert('dono: UPDATE bloqueado por trigger',
  public.teste_comando(null, null, 'update public.aluno_termo_fisico_eventos set situacao=''ARQUIVADO''')->>'err' like '%append-only%');
select public.teste_assert('dono: DELETE bloqueado por trigger',
  public.teste_comando(null, null, 'delete from public.aluno_termo_fisico_eventos')->>'err' like '%append-only%');
select public.teste_assert('dono: TRUNCATE bloqueado por trigger',
  public.teste_comando(null, null, 'truncate public.aluno_termo_fisico_eventos')->>'err' like '%append-only%');
select public.teste_assert('service_role: não lê, não insere, não trunca',
  public.teste_consulta('service_role', null, 'select * from public.aluno_termo_fisico_eventos')->>'ok' = 'false'
  and public.teste_comando('service_role', null,
    $sql$insert into public.aluno_termo_fisico_eventos (aluno_id, situacao, autor_email)
         values ('1','ARQUIVADO','x@y')$sql$)->>'ok' = 'false'
  and public.teste_comando('service_role', null, 'truncate public.aluno_termo_fisico_eventos')->>'ok' = 'false');

select public.teste_assert('histórico intacto após as tentativas de alteração',
  (select count(*) from public.aluno_termo_fisico_eventos) = 2);
