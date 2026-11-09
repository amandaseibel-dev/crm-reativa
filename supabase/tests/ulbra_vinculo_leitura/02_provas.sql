-- PROVAS DE AUTORIZACAO E DE VAZAMENTO. Qualquer afirmacao falsa aborta com FALHOU.
\set ON_ERROR_STOP on
create or replace function pg_temp.chamar(p_email text, p_uid text, p_aluno uuid) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  perform set_config('teste.email', p_email, false);
  perform set_config('teste.uid', coalesce(p_uid, ''), false);
  select public.ulbra_vinculo_aluno(p_aluno) into r;
  return r;
end $$;

-- OPERADOR 1: so o proprio aluno
do $$ declare r jsonb; begin
  r := pg_temp.chamar('op1@x', null, '00000000-0000-0000-0000-00000000000a');
  perform public.afirmar(r->>'status' = 'vinculado' and r->>'url' = 'https://crm.ulbra.ai/app/clientes/777',
    'op1 ve o vinculo do PROPRIO aluno (A)');
  r := pg_temp.chamar('op1@x', null, '00000000-0000-0000-0000-00000000000b');
  perform public.afirmar(r->>'status' = 'sem_acesso' and r->'url' is null and r->'ulbra_cliente_id' is null,
    'op1 NAO ve o vinculo de aluno de outro operador (B): sem_acesso, sem url');
  r := pg_temp.chamar('op1@x', null, '00000000-0000-0000-0000-00000000000d');
  perform public.afirmar(r->>'status' = 'sem_acesso', 'op1 nao sabe se D tem vinculo: sem_acesso');
  r := pg_temp.chamar('op1@x', null, '00000000-0000-0000-0000-00000000000c');
  perform public.afirmar(r->>'status' = 'sem_vinculo', 'op1 ve sem_vinculo no proprio aluno sem vinculo (C)');
  r := pg_temp.chamar('op1@x', null, '00000000-0000-0000-0000-00000000000e');
  perform public.afirmar(r->>'status' = 'vinculado_nao_confirmado' and r->'url' is null,
    'vinculo sem CPF confirmado nunca devolve link, mesmo do proprio aluno');
  r := pg_temp.chamar('op1@x', null, '00000000-0000-0000-0000-0000000000ff');
  perform public.afirmar(r->>'status' = 'sem_acesso', 'UUID inexistente: sem_acesso, sem revelar existencia');
end $$;

-- OPERADOR 2: simetrico
do $$ declare r jsonb; begin
  r := pg_temp.chamar('op2@x', null, '00000000-0000-0000-0000-00000000000b');
  perform public.afirmar(r->>'status' = 'vinculado', 'op2 ve o proprio aluno (B)');
  r := pg_temp.chamar('op2@x', null, '00000000-0000-0000-0000-00000000000a');
  perform public.afirmar(r->>'status' = 'sem_acesso' and r->'url' is null, 'op2 NAO ve o aluno do op1 (A)');
end $$;

-- GESTAO e SUPERVISOR: perfis amplos leem qualquer aluno
do $$ declare r jsonb; begin
  r := pg_temp.chamar('amanda.seibel@aelbra.com.br', null, '00000000-0000-0000-0000-00000000000b');
  perform public.afirmar(r->>'status' = 'vinculado', 'gestao (gerencia) ve o aluno de qualquer operador');
  r := pg_temp.chamar('sup@x', null, '00000000-0000-0000-0000-00000000000a');
  perform public.afirmar(r->>'status' = 'vinculado', 'supervisor ve qualquer aluno');
end $$;

-- INATIVO: nada, mesmo sendo responsavel
do $$ declare r jsonb; begin
  r := pg_temp.chamar('inativo@x', null, '00000000-0000-0000-0000-00000000000a');
  perform public.afirmar(r->>'status' = 'sem_acesso' and r->'url' is null, 'usuario inativo: sem_acesso');
end $$;

-- PAINEL DA TV: nunca le
do $$ declare r jsonb; begin
  r := pg_temp.chamar('painel.tv@reativa.local', '00000000-0000-0000-0000-0000000000a5',
                      '00000000-0000-0000-0000-00000000000a');
  perform public.afirmar(r->>'status' = 'sem_acesso' and r->'url' is null, 'painel da TV: sem_acesso');
end $$;

-- ANON: sem EXECUCAO (permission denied), nao so "sem dados"
do $$ declare barrado boolean := false; begin
  perform set_config('teste.email', '', false);
  set local role anon;
  begin
    perform public.ulbra_vinculo_aluno('00000000-0000-0000-0000-00000000000a');
  exception when insufficient_privilege then barrado := true;
  end;
  reset role;
  perform public.afirmar(barrado, 'anon NAO executa a funcao (permission denied)');
end $$;

select 'AUTORIZACAO DO VINCULO: afirmacoes passaram' as resultado;
