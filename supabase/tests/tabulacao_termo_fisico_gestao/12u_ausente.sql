-- AÇÕES do login (app_teste) com a configuração AUSENTE: fail closed, nada é liberado.
\set ON_ERROR_STOP on
select public.teste_assert('config ausente: gestão recusada (fecha)',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,descricao,registrado_por_email) values ('c4','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','Registro administrativo do termo físico.','amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501')
  and (select count(*) from public.aluno_movimentacoes where aluno_id = 'c4') = 0);
