-- AÇÕES de app_teste com objetos pertencentes a dono_teste (NOSUPERUSER, BYPASSRLS), FORCE RLS ligado.
-- Não usa superusuário para provar o comportamento. Contenção controlada pelo prep 12p.
\set ON_ERROR_STOP on
-- Contenção desligada (estado do prep 12p_off antes deste arquivo): gestão ativa grava pela RPC.
-- Contagem ANTES, do MESMO aluno enviado à RPC (a RPC confere o aluno antes da contenção).
select (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','gestao.titular@exemplo.local',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'a0000000-0000-0000-0000-000000000042' and tipo = 'REGISTRO_ADMINISTRATIVO'$q$))->'rows')) as n_antes_42 \gset
select public.teste_assert('dono_teste + FORCE: gestão ativa grava com contenção desligada',
  (public.teste_comando('authenticated','gestao.titular@exemplo.local',
    $sql$select public.registrar_administrativo_termo_fisico('a0000000-0000-0000-0000-000000000042','TERMO_FISICO_ARQUIVADO')$sql$)->>'ok' = 'true')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','gestao.titular@exemplo.local',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'a0000000-0000-0000-0000-000000000042' and tipo = 'REGISTRO_ADMINISTRATIVO'$q$))->'rows')) = :n_antes_42 + 1);
-- Usuário comum não lê nem altera a flag (RLS sem policy + sem grant).
select public.teste_assert('dono_teste + FORCE: operador não lê a flag (42501)',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$select 1 from public.termo_fisico_contencao$sql$)->>'code' = '42501');
