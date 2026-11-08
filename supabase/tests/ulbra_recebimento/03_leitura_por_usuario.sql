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

-- PILOTO DE OBSERVACAO: as duas portas de acao estao fechadas para
-- `authenticated`, nao so para `anon`. Esta e a afirmacao central do piloto --
-- sem ela, qualquer operador ativo assumiria ou dispensaria atendimento.
do $$ begin
  perform public.afirmar(not has_function_privilege('authenticated', 'public.ulbra_atendimento_assumir(text)', 'execute'),
    'PILOTO: authenticated NAO executa ulbra_atendimento_assumir');
  perform public.afirmar(not has_function_privilege('authenticated', 'public.ulbra_atendimento_dispensar(text,text)', 'execute'),
    'PILOTO: authenticated NAO executa ulbra_atendimento_dispensar');
  -- as funcoes CONTINUAM existindo e executaveis por service_role: o fim do
  -- piloto e um grant, nao um redeploy.
  perform public.afirmar(to_regprocedure('public.ulbra_atendimento_assumir(text)') is not null,
    'PILOTO: a funcao assumir continua criada');
  perform public.afirmar(has_function_privilege('service_role', 'public.ulbra_atendimento_assumir(text)', 'execute'),
    'PILOTO: service_role continua executando assumir');
end $$;

-- Funcoes de escrita da etapa 1: anon nunca executa; authenticated executa so as de usuario.
do $$ begin
  perform public.afirmar(not has_function_privilege('anon', 'public.ulbra_atendimento_assumir(text)', 'execute'),
    'anon NAO executa ulbra_atendimento_assumir');
  perform public.afirmar(not has_function_privilege('anon', 'public.ulbra_atendimento_dispensar(text,text)', 'execute'),
    'anon NAO executa ulbra_atendimento_dispensar');
  perform public.afirmar(not has_function_privilege('anon', 'public.ulbra_conversa_marcar_lida(text)', 'execute'),
    'anon NAO executa ulbra_conversa_marcar_lida');
  perform public.afirmar(not has_function_privilege('anon', 'public.ulbra_detalhe_reabrir(text)', 'execute'),
    'anon NAO executa ulbra_detalhe_reabrir');
end $$;

-- a porta de escrita da sincronizacao e so de service_role
do $$ declare ok boolean := false; begin
  ok := not has_function_privilege('authenticated', 'public.ulbra_sync_gravar(jsonb)', 'execute');
  perform public.afirmar(ok, 'authenticated NAO executa ulbra_sync_gravar');
end $$;
reset role;

-- -------------------------------- PILOTO: painel restrito a gestao
-- op1 tem caso com o aluno A, e o atendimento x1 esta com destino CARTEIRA
-- para ele. No piloto, nada disso o faz enxergar: a policy nao tem ramo de
-- operador. E a prova de que a restricao NAO depende de a fila do rodizio
-- estar vazia -- x1 chega a op1 por CARTEIRA, nao por RODIZIO.
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 0, 'PILOTO: op1 NAO le conversa, nem a da propria carteira');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 0, 'PILOTO: op1 NAO le atendimento, nem o sugerido a ele por CARTEIRA');
end $$;
reset role;

-- op2: tem carteira (x2) e rodizio (x4). Tambem nao ve nada.
set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 0, 'PILOTO: op2 NAO le conversa');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 0, 'PILOTO: op2 NAO le atendimento, nem o do rodizio (x4)');
end $$;
reset role;

-- O destino CONTINUA gravado: e o que o piloto mede. Conferido como
-- superusuario, porque authenticated nao le fora da gestao.
reset role;
do $$ declare n int; begin
  select count(*) into n from public.ulbra_atendimentos
   where destino_motivo in ('CARTEIRA', 'RODIZIO') and destino_email is not null;
  perform public.afirmar(n >= 2,
    'PILOTO: a sincronizacao segue gravando destino (CARTEIRA/RODIZIO) para medicao');
end $$;

-- gestao: tudo, inclusive conferencia
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
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

set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
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

-- ------------------------------------------- PILOTO: a chamada morre no grant
-- Nao e so "nao deve": e `insufficient_privilege` antes de entrar na funcao.
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare barrou_assumir boolean := false; barrou_dispensar boolean := false; begin
  begin perform public.ulbra_atendimento_assumir('x1');
  exception when insufficient_privilege then barrou_assumir := true; end;
  begin perform public.ulbra_atendimento_dispensar('x1', 'teste');
  exception when insufficient_privilege then barrou_dispensar := true; end;
  perform public.afirmar(barrou_assumir,   'PILOTO: assumir barra op1 no grant (insufficient_privilege)');
  perform public.afirmar(barrou_dispensar, 'PILOTO: dispensar barra op1 no grant (insufficient_privilege)');
end $$;
reset role;

-- A gestao tambem nao assume no piloto: o portao e o grant de `authenticated`,
-- nao o perfil. Isso e proposital -- piloto e observacao.
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare barrou boolean := false; begin
  begin perform public.ulbra_atendimento_assumir('x2');
  exception when insufficient_privilege then barrou := true; end;
  perform public.afirmar(barrou, 'PILOTO: nem a gestao assume -- o portao e o grant, nao o perfil');
end $$;
reset role;

-- A regra de REGIME de `assumir` (sugerido a ele, carteira de outro,
-- conferencia, JA_ASSUMIDO, excecao da gestao) continua provada em
-- `08_regime_pos_piloto.sql`, que reconcede os grants e reexecuta as
-- afirmacoes. Nenhuma prova foi descartada ao fechar as portas do piloto.

select 'LEITURA (PILOTO): todas as afirmacoes passaram' as resultado;
