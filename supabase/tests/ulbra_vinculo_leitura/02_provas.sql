-- Provas: leitura so do banco, status certo por caso, sem vazamento.
\set ON_ERROR_STOP on
do $$ declare r jsonb; begin
  perform set_config('teste.email', 'op1@x', false);
  r := public.ulbra_vinculo_aluno('00000000-0000-0000-0000-00000000000a');
  perform public.afirmar(r->>'status' = 'vinculado' and r->>'url' = 'https://crm.ulbra.ai/app/clientes/777',
    'operador ve o link quando o vinculo e alta_cpf');
  r := public.ulbra_vinculo_aluno('00000000-0000-0000-0000-00000000000b');
  perform public.afirmar(r->>'status' = 'vinculado_nao_confirmado' and r->'url' is null,
    'vinculo sem confirmacao por CPF NUNCA devolve link');
  r := public.ulbra_vinculo_aluno('00000000-0000-0000-0000-00000000000c');
  perform public.afirmar(r->>'status' = 'sem_vinculo', 'aluno sem vinculo: sem_vinculo');
end $$;
do $$ declare r jsonb; begin
  perform set_config('teste.email', 'inativo@x', false);
  r := public.ulbra_vinculo_aluno('00000000-0000-0000-0000-00000000000a');
  perform public.afirmar(r->>'status' = 'sem_vinculo', 'usuario inativo nao le o vinculo');
end $$;
select 'LEITURA DO VINCULO: afirmacoes passaram' as resultado;
