-- AÇÕES do login não privilegiado (app_teste). B1 (contenção) e B4 (aluno que já contém código restrito).
-- Estado do aluno a0000000-...042 é preparado como TERMO_FISICO_ARQUIVADO por 11p_prep_contencao_on.sql (postgres).
\set ON_ERROR_STOP on

-- B1: com a contenção, a gestão NÃO registra mais (42501 de permissão); nada é gravado.
-- B1: a recusa é da CONTENÇÃO (mensagem exata) e não acrescenta linha. Compara contagem ANTES e DEPOIS
-- (a fixture 07 já gravou REGISTRO para este aluno, então zero não é o critério).
do $$ declare n0 int; n1 int; r jsonb; begin
  select jsonb_array_length((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'a0000000-0000-0000-0000-000000000042' and tipo = 'REGISTRO_ADMINISTRATIVO'$q$))->'rows') into n0;
  r := public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',$q$select public.registrar_administrativo_termo_fisico('a0000000-0000-0000-0000-000000000042','TERMO_FISICO_ARQUIVADO')$q$);
  select jsonb_array_length((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.aluno_movimentacoes where aluno_id = 'a0000000-0000-0000-0000-000000000042' and tipo = 'REGISTRO_ADMINISTRATIVO'$q$))->'rows') into n1;
  if r->>'ok' = 'true' or r->>'err' not like 'Registro de termo físico suspenso%' then raise exception 'FALHOU B1: recusa esperada da contenção, obtido %', r; end if;
  if n0 <> n1 then raise exception 'FALHOU B1: linha gravada (% -> %)', n0, n1; end if;
end $$;

-- B4a: aluno já em código restrito. Operador tenta trocar para outro código restrito: recusa exata, sem alteração parcial.
select public.teste_assert('B4a: operador recusado ao trocar código restrito por outro (42501, mensagem exata)',
  (public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$update public.alunos set status_atual = 'TERMO_FISICO_EM_ANDAMENTO' where id = 'a0000000-0000-0000-0000-000000000042'$sql$)->>'code' = '42501')
  and (select count(*) from jsonb_array_elements((public.teste_consulta('authenticated','amanda.seibel@aelbra.com.br',$q$select 1 from public.alunos where id = 'a0000000-0000-0000-0000-000000000042' and status_atual = 'TERMO_FISICO_ARQUIVADO'$q$))->'rows')) = 1);

-- B4b: alteração legítima do mesmo aluno (sair do código restrito para CONTATAR) é permitida ao operador.
select public.teste_assert('B4b: operador sai do código restrito para CONTATAR (legítimo)',
  public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$update public.alunos set status_atual = 'CONTATAR' where id = 'a0000000-0000-0000-0000-000000000042'$sql$)->>'ok' = 'true');
