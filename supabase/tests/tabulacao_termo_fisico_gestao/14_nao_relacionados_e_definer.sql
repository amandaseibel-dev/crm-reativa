-- AÇÕES de app_teste com a contenção DESLIGADA (após 12p_off). Prova dois pontos:
-- (a) a leitura da flag pela função SECURITY DEFINER funciona com RLS habilitada e deny-all
--     (o dono lê a flag; usuários não) — se a contenção fica sempre ligada, a gestão não grava nunca;
-- (b) registros operacionais não relacionados seguem funcionando.
\set ON_ERROR_STOP on
-- (a) com a flag desligada, a RPC pela gestão grava o REGISTRO de um código restrito.
-- Contagem ANTES, do MESMO aluno enviado à RPC (o aluno precisa existir: a RPC confere antes da contenção).
select (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','gestao.titular@exemplo.local',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'a0000000-0000-0000-0000-000000000042' and tipo = 'REGISTRO_ADMINISTRATIVO'$q$))->'rows')) as n_antes_42 \gset
select public.teste_assert('definer lê flag desligada: RPC da gestão grava REGISTRO (uma linha)',
  (public.teste_comando('authenticated','gestao.titular@exemplo.local',
    $sql$select public.registrar_administrativo_termo_fisico('a0000000-0000-0000-0000-000000000042','TERMO_FISICO_ARQUIVADO')$sql$)->>'ok' = 'true')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','gestao.titular@exemplo.local',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'a0000000-0000-0000-0000-000000000042' and tipo = 'REGISTRO_ADMINISTRATIVO'$q$))->'rows')) = :n_antes_42 + 1);
-- (b) operacional não relacionado: operador grava CONTATO/CONTATAR e gestão grava OBSERVACAO sem código.
select public.teste_assert('não relacionado: operador grava CONTATAR',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email) values ('d2','CONTATO','CONTATAR','operador.teste@exemplo.local')$sql$)->>'ok' = 'true');
select public.teste_assert('não relacionado: gestão grava OBSERVACAO sem código',
  public.teste_comando('authenticated','gestao.titular@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,registrado_por_email) values ('d2','OBSERVACAO','obs','gestao.titular@exemplo.local')$sql$)->>'ok' = 'true');
