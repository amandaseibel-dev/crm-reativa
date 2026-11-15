-- AÇÕES de app_teste com a contenção DESLIGADA (após 12p_off). Prova dois pontos:
-- (a) a leitura da flag pela função SECURITY DEFINER funciona com RLS habilitada e deny-all
--     (o dono lê a flag; usuários não) — se a contenção fica sempre ligada, a gestão não grava nunca;
-- (b) registros operacionais não relacionados seguem funcionando.
\set ON_ERROR_STOP on
-- (a) com a flag desligada, a RPC pela gestão grava o REGISTRO de um código restrito.
select public.teste_assert('definer lê flag desligada: RPC da gestão grava REGISTRO (uma linha)',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$select public.registrar_administrativo_termo_fisico('d1','TERMO_FISICO_ARQUIVADO')$sql$)->>'ok' = 'true')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'd1' and tipo = 'REGISTRO_ADMINISTRATIVO'$q$))->'rows')) = 1);
-- (b) operacional não relacionado: operador grava CONTATO/CONTATAR e gestão grava OBSERVACAO sem código.
select public.teste_assert('não relacionado: operador grava CONTATAR',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email) values ('d2','CONTATO','CONTATAR','operador.teste@exemplo.local')$sql$)->>'ok' = 'true');
select public.teste_assert('não relacionado: gestão grava OBSERVACAO sem código',
  public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,registrado_por_email) values ('d2','OBSERVACAO','obs','amanda.seibel@aelbra.com.br')$sql$)->>'ok' = 'true');
