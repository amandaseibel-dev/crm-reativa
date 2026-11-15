-- AÇÕES do login (app_teste) com a configuração AUSENTE: fail closed, nada é liberado.
\set ON_ERROR_STOP on
select public.teste_assert('config ausente: gestão recusada (fecha)',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,descricao,registrado_por_email) values ('c4','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','Registro administrativo do termo físico.','amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'c4'$q$))->'rows')) = 0);
-- Linha ausente: RPC e UPDATE direto também recusados (fail closed), sem alteração.
select public.teste_assert('config ausente: RPC recusada à gestão (42501), sem linha',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$select public.registrar_administrativo_termo_fisico('c5','TERMO_FISICO_ARQUIVADO')$sql$)->>'code' = '42501')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'c5'$q$))->'rows')) = 0);
select public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
  $sql$update public.aluno_movimentacoes set status_novo = 'TERMO_FISICO_EM_ANDAMENTO' where aluno_id = 'c1'$sql$);
select public.teste_assert('config ausente: UPDATE de linha restrita não altera o código',
  (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'c1' and status_novo = 'TERMO_FISICO_ARQUIVADO'$q$))->'rows')) = 1);
