-- PROVAS DE LEITURA POR USUARIO E DE GRANTS, como papeis reais.
-- Qualquer afirmacao falsa aborta o job com 'FALHOU: ...'.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- grants
-- anon nao le nada do espelho
set role anon;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.ulbra_conversas;
  exception when insufficient_privilege then ok := true; end;
  perform public.afirmar(ok, 'anon nao le ulbra_conversas');
end $$;
reset role;

-- authenticated nao escreve direto no espelho, nem TRUNCATE (RLS nao cobre)
set role authenticated;
select set_config('teste.email', 'op1@x', false);
do $$
declare ok_ins boolean := false; ok_upd boolean := false; ok_del boolean := false; ok_trunc boolean := false;
begin
  begin insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, situacao, equipe, aluno_status)
        values ('hack', 'h', 'active', 'Reativa', 'vinculado');
  exception when insufficient_privilege then ok_ins := true; end;
  begin update public.ulbra_conversas set cliente_nome = 'x';
  exception when insufficient_privilege then ok_upd := true; end;
  begin delete from public.ulbra_conversas;
  exception when insufficient_privilege then ok_del := true; end;
  begin truncate public.ulbra_conversas;
  exception when insufficient_privilege then ok_trunc := true; end;
  perform public.afirmar(ok_ins, 'authenticated nao insere no espelho');
  perform public.afirmar(ok_upd, 'authenticated nao atualiza o espelho');
  perform public.afirmar(ok_del, 'authenticated nao apaga do espelho');
  perform public.afirmar(ok_trunc, 'authenticated NAO TRUNCA o espelho (grant revogado)');
end $$;

-- a porta de escrita da sincronizacao e so de service_role
do $$ declare ok boolean := false; begin
  ok := not has_function_privilege('authenticated', 'public.ulbra_sync_gravar(jsonb)', 'execute');
  perform public.afirmar(ok, 'authenticated NAO executa ulbra_sync_gravar');
end $$;
reset role;

-- ------------------------------------------ leitura: cada um ve o seu
-- op1: so conversa de aluno que e caso dele (A)
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 1, 'op1 le so a conversa do aluno da sua carteira (1)');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 1, 'op1 le so o atendimento sugerido a ele (x1)');
end $$;
reset role;

-- op2: conversa de B; atendimentos x2 (carteira) e x4 (rodizio)
set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 1, 'op2 le so a conversa do aluno da sua carteira (1)');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 2, 'op2 le os seus dois atendimentos (x2, x4)');
end $$;
reset role;

-- gestao: tudo, inclusive conferencia
set role authenticated; select set_config('teste.email', 'gestao@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 3, 'gestao le todas as conversas (3)');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 4, 'gestao le todos os atendimentos, inclusive conferencia (4)');
end $$;
reset role;

-- usuario inativo: nada
set role authenticated; select set_config('teste.email', 'inativo@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 0, 'usuario inativo nao le conversa');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 0, 'usuario inativo nao le atendimento');
end $$;
reset role;

-- --------------------------------- leitura POR USUARIO: marcar nao apaga o da outra pessoa
-- op1 marca c1 como lida
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_conversa_marcar_lida('c1');
  perform public.afirmar((r->>'ok')::boolean, 'op1 marca a propria leitura');
end $$;
reset role;

-- a linha de op1 existe; op2 e gestao NAO enxergam a linha de op1
set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_leitura_usuario where usuario_email = 'op1@x';
  perform public.afirmar(n = 0, 'op2 nao le a linha de leitura de op1');
end $$;
reset role;

set role authenticated; select set_config('teste.email', 'gestao@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_leitura_usuario where usuario_email = 'op1@x';
  perform public.afirmar(n = 0, 'gestao NAO le o marcador de leitura de terceiro');
end $$;
reset role;

-- op1 nao consegue gravar leitura em nome de outro
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare bloqueou boolean := false; begin
  begin
    insert into public.ulbra_leitura_usuario (usuario_email, ulbra_conversa_id, lido_ate)
    values ('op2@x', 'c2', now());
  exception when others then
    bloqueou := sqlerrm like '%row-level security%';
  end;
  perform public.afirmar(bloqueou, 'op1 nao grava leitura em nome de op2 (RLS)');
end $$;
reset role;

-- o aviso de op1 sumiu; o de op2 continua. Leitura nao e global.
do $$ declare nao_lida_para_op2 boolean; lida_por_op1 boolean; begin
  select not exists (select 1 from public.ulbra_leitura_usuario l
                      where l.ulbra_conversa_id = 'c1' and l.usuario_email = 'op2@x')
    into nao_lida_para_op2;
  select exists (select 1 from public.ulbra_leitura_usuario l
                  where l.ulbra_conversa_id = 'c1' and l.usuario_email = 'op1@x')
    into lida_por_op1;
  perform public.afirmar(nao_lida_para_op2, 'op2 continua sem marcar c1: a leitura de op1 nao e global');
  perform public.afirmar(lida_por_op1, 'op1 tem a propria marca em c1');
end $$;

-- ---------------------------------------------- assumir: dois donos e carteira
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_atendimento_assumir('x1');
  perform public.afirmar((r->>'ok')::boolean, 'op1 assume o atendimento sugerido a ele (x1)');
  r := public.ulbra_atendimento_assumir('x2');
  perform public.afirmar(r->>'motivo' = 'E_DA_CARTEIRA_DE_OUTRO', 'op1 NAO assume a carteira de op2 (x2)');
  r := public.ulbra_atendimento_assumir('x3');
  perform public.afirmar(r->>'motivo' = 'IDENTIDADE_NAO_CONFIRMADA', 'op1 NAO assume conferencia (x3)');
end $$;
reset role;

set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_atendimento_assumir('x1');
  perform public.afirmar(r->>'motivo' = 'JA_ASSUMIDO' and r->>'responsavel' = 'op1@x',
    'op2 chega depois e recebe JA_ASSUMIDO com o nome de quem chegou primeiro');
end $$;
reset role;

-- gestao pode assumir a carteira de outro (regra explicita)
set role authenticated; select set_config('teste.email', 'gestao@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_atendimento_assumir('x2');
  perform public.afirmar((r->>'ok')::boolean, 'gestao assume a carteira de op2 (excecao da gestao)');
end $$;
reset role;

select 'LEITURA POR USUARIO: todas as afirmacoes passaram' as resultado;
