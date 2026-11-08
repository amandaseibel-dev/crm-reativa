-- Reabertura de pendencia: so a gestao reabre. A pendencia nao some.
\set ON_ERROR_STOP on

-- operador comum: negado
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_detalhe_reabrir('cz');
  perform public.afirmar(r->>'motivo' = 'ACESSO_NEGADO', 'operador nao reabre pendencia');
end $$;
reset role;

-- gestao: reabre. A conferencia do estado e feita como superusuario: a fila
-- e a pendencia nao tem leitura direta para authenticated (por design).
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_detalhe_reabrir('cz');
  perform public.afirmar((r->>'ok')::boolean, 'gestao reabre a pendencia');
end $$;
reset role;

do $$ declare n int; t int; rec int; begin
  select count(*) into n from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cz';
  perform public.afirmar(n = 1, 'pendencia reaberta volta a fila');
  select tentativas into t from public.ulbra_detalhe_fila where ulbra_conversa_id = 'cz';
  perform public.afirmar(t = 0, 'reabertura zera as tentativas');
  select count(*) into rec from public.ulbra_detalhe_pendencias
   where ulbra_conversa_id = 'cz' and recuperada_em is not null;
  perform public.afirmar(rec = 1, 'a pendencia continua registrada, agora como recuperada');
end $$;

select 'REABERTURA DE PENDENCIA: afirmacoes passaram' as resultado;
