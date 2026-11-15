-- AÇÕES de app_teste com objetos pertencentes a dono_teste (NOSUPERUSER, BYPASSRLS), FORCE RLS ligado.
-- Não usa superusuário para provar o comportamento. Contenção controlada pelo prep 12p.
\set ON_ERROR_STOP on
-- Contenção desligada (estado do prep 12p_off antes deste arquivo): gestão ativa grava pela RPC.
select public.teste_assert('dono_teste + FORCE: gestão ativa grava com contenção desligada',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$select public.registrar_administrativo_termo_fisico('e1','TERMO_FISICO_ARQUIVADO')$sql$)->>'ok' = 'true'));
-- Usuário comum não lê nem altera a flag (RLS sem policy + sem grant).
select public.teste_assert('dono_teste + FORCE: operador não lê a flag (42501)',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$select 1 from public.termo_fisico_contencao$sql$)->>'code' = '42501');
