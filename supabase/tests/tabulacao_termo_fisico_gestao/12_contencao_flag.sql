-- AÇÕES do login não privilegiado (app_teste) com a contenção LIGADA. Negativas exatas, sem alteração.
\set ON_ERROR_STOP on
-- RPC pela gestão: recusada (42501), sem linha nova.
-- A RPC exige aluno existente (22023 antes da contenção): usa o aluno real da fixture; a recusa é da CONTENÇÃO.
select public.teste_assert('contenção: RPC recusada pela mensagem da contenção, sem linha em c2',
  ((public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$select public.registrar_administrativo_termo_fisico('a0000000-0000-0000-0000-000000000042','TERMO_FISICO_ARQUIVADO')$sql$)->>'err') like 'Registro de termo físico suspenso%')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'c2'$q$))->'rows')) = 0);
-- INSERT direto pela gestão: REGISTRO de cada código restrito recusado.
select public.teste_assert('contenção: INSERT direto REGISTRO (EM_ANDAMENTO) recusado à gestão',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,descricao,registrado_por_email) values ('c2','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_EM_ANDAMENTO','Registro administrativo do termo físico.','amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'c2'$q$))->'rows')) = 0);
-- INSERT direto de CONTATO com código restrito pela gestão: recusado.
select public.teste_assert('contenção: INSERT de código restrito em CONTATO recusado à gestão',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email) values ('c2','CONTATO','TERMO_FISICO_ARQUIVADO','amanda.seibel@aelbra.com.br')$sql$)->>'code' = '42501')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'c2'$q$))->'rows')) = 0);
-- UPDATE pela gestão de linha restrita existente: nada muda (sem policy de UPDATE; e a trigger recusa).
select public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
  $sql$update public.aluno_movimentacoes set status_novo = 'TERMO_FISICO_EM_ANDAMENTO' where aluno_id = 'c1'$sql$);
select public.teste_assert('contenção: UPDATE de linha restrita não altera o código',
  (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'c1' and status_novo = 'TERMO_FISICO_ARQUIVADO'$q$))->'rows')) = 1);
-- Operacional não relacionado continua gravando durante a contenção.
select public.teste_assert('contenção: operador grava CONTATAR normal (não relacionado)',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email) values ('c3','CONTATO','CONTATAR','operador.teste@exemplo.local')$sql$)->>'ok' = 'true');
-- Manipulação da flag: usuário não lê nem altera a configuração.
select public.teste_assert('flag: gestão não altera contencao_ativa (42501)',
  public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$update public.termo_fisico_contencao set contencao_ativa = false where id$sql$)->>'code' = '42501');
select public.teste_assert('flag: operador não lê a configuração (42501)',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$select 1 from public.termo_fisico_contencao$sql$)->>'code' = '42501');
-- app_teste (login, sem SET ROLE) não altera a configuração: permissão negada de verdade.
do $$
declare v_state text; v_ok boolean := false;
begin
  begin
    update public.termo_fisico_contencao set contencao_ativa = false where id;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    v_ok := (v_state = '42501');
  end;
  if not v_ok then raise exception 'FALHOU: app_teste conseguiu alterar contencao_ativa'; end if;
end $$;

-- authenticated: sem policy de UPDATE, a RLS filtra a zero linhas ANTES da trigger. Esta recusa é da RLS,
-- não da trigger: o teste exige apenas que nada mude (a trigger é provada em 13).
select public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
  $sql$update public.aluno_movimentacoes set status_novo = 'TERMO_FISICO_EM_ANDAMENTO' where aluno_id = 'c1'$sql$);
select public.teste_assert('RLS (não a trigger) impede UPDATE de authenticated: linha inalterada',
  (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'c1' and status_novo = 'TERMO_FISICO_ARQUIVADO'$q$))->'rows')) = 1);
