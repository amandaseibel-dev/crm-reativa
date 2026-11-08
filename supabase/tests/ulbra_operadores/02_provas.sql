-- PROVAS da migration 20261108150000: RLS, privilegios e conteudo.
-- Qualquer afirmacao falsa aborta com 'FALHOU: ...'.
\set ON_ERROR_STOP on

-- ------------------------------------------------------------ estrutura
do $$ begin
  perform public.afirmar(to_regclass('public.ulbra_operadores_vinculo') is not null,
    'a tabela existe');
  perform public.afirmar(
    (select relrowsecurity from pg_class where oid = 'public.ulbra_operadores_vinculo'::regclass),
    'RLS esta LIGADA');
  perform public.afirmar(
    (select count(*) from pg_policy where polrelid = 'public.ulbra_operadores_vinculo'::regclass) = 1,
    'existe exatamente 1 policy');
  -- A unica policy e de SELECT: 'r'. Se alguem acrescentar uma de escrita,
  -- esta afirmacao cai.
  perform public.afirmar(
    (select polcmd from pg_policy where polrelid = 'public.ulbra_operadores_vinculo'::regclass) = 'r',
    'a unica policy e de leitura (SELECT)');
end $$;

-- ---------------------------------------------------------- privilegios
-- O ambiente deu ALL para authenticated por default privileges (01_ambiente).
-- A migration tem de ter DERRUBADO tudo e devolvido so SELECT.
do $$ begin
  perform public.afirmar(
    has_table_privilege('authenticated','public.ulbra_operadores_vinculo','SELECT'),
    'authenticated TEM select (a RLS e que filtra)');
  perform public.afirmar(
    not has_table_privilege('authenticated','public.ulbra_operadores_vinculo','INSERT'),
    'authenticated NAO insere');
  perform public.afirmar(
    not has_table_privilege('authenticated','public.ulbra_operadores_vinculo','UPDATE'),
    'authenticated NAO atualiza');
  perform public.afirmar(
    not has_table_privilege('authenticated','public.ulbra_operadores_vinculo','DELETE'),
    'authenticated NAO apaga');
  -- TRUNCATE e o que a RLS NAO cobre: se escapar, qualquer usuario ativo
  -- esvazia o mapeamento inteiro.
  perform public.afirmar(
    not has_table_privilege('authenticated','public.ulbra_operadores_vinculo','TRUNCATE'),
    'authenticated NAO TRUNCA (grant herdado foi revogado)');

  perform public.afirmar(
    not has_table_privilege('anon','public.ulbra_operadores_vinculo','SELECT'),
    'anon NAO le');
  perform public.afirmar(
    not has_table_privilege('anon','public.ulbra_operadores_vinculo','TRUNCATE'),
    'anon NAO trunca');

  -- O servidor precisa escrever: e por ele que o mapeamento e mantido.
  perform public.afirmar(
    has_table_privilege('service_role','public.ulbra_operadores_vinculo','SELECT')
    and has_table_privilege('service_role','public.ulbra_operadores_vinculo','INSERT')
    and has_table_privilege('service_role','public.ulbra_operadores_vinculo','UPDATE'),
    'service_role le e escreve');
end $$;

-- ------------------------------------------------------- conteudo (11)
do $$ declare n int; e text; begin
  select count(*) into n from public.ulbra_operadores_vinculo;
  perform public.afirmar(n = 11, 'os 11 vinculos conferidos estao la');

  select email_reativa into e from public.ulbra_operadores_vinculo
   where id_ulbra = '691e0e1ecd033c6b374b1036';
  perform public.afirmar(e = 'cobranca10@aelbra.com.br',
    'Joao Vitor (691e0e1e...) e o cobranca10 -- e nao o Joao Silva');

  perform public.afirmar(
    not exists (select 1 from public.ulbra_operadores_vinculo
                 where id_ulbra = '6902d3ebb9fba65197979245'),
    'Joao Silva fica SEM vinculo');
  perform public.afirmar(
    not exists (select 1 from public.ulbra_operadores_vinculo
                 where id_ulbra = '6ada61d95c8b95a1e9765229'),
    'Marketing fica SEM vinculo');
  perform public.afirmar(
    not exists (select 1 from public.ulbra_operadores_vinculo where not ativo),
    'nenhum vinculo nasce inativo');
end $$;

-- ------------------------------------------------- unicidade e formato
do $$ declare barrou boolean; begin
  -- Dois operadores no mesmo atendente ULBRA: barrado.
  barrou := false;
  begin
    insert into public.ulbra_operadores_vinculo (id_ulbra, email_reativa, nome_ulbra)
    values ('691e0e1ecd033c6b374b1036', 'outro@aelbra.com.br', 'Duplicado');
  exception when unique_violation then barrou := true; end;
  perform public.afirmar(barrou, 'id_ulbra repetido e barrado');

  -- O mesmo operador em dois atendentes: barrado.
  barrou := false;
  begin
    insert into public.ulbra_operadores_vinculo (id_ulbra, email_reativa, nome_ulbra)
    values ('aaaaaaaaaaaaaaaaaaaaaaaa', 'cobranca10@aelbra.com.br', 'Outro id');
  exception when unique_violation then barrou := true; end;
  perform public.afirmar(barrou, 'email_reativa repetido e barrado');

  -- Id fora do formato de 24 hex: barrado pelo CHECK. Nome nunca e chave, e
  -- id malformado nao vira vinculo silencioso.
  barrou := false;
  begin
    insert into public.ulbra_operadores_vinculo (id_ulbra, email_reativa, nome_ulbra)
    values ('nao-e-id', 'novo@aelbra.com.br', 'Formato errado');
  exception when check_violation then barrou := true; end;
  perform public.afirmar(barrou, 'id_ulbra fora do formato e barrado pelo CHECK');
end $$;

-- ------------------------------------------------------ RLS como papel
-- gestao le os 11
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_operadores_vinculo;
  perform public.afirmar(n = 11, 'gestao le os 11 vinculos');
end $$;
reset role;

-- operador comum NAO le nada: a lista inteira e da gestao
set role authenticated; select set_config('teste.email', 'cobranca10@aelbra.com.br', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_operadores_vinculo;
  perform public.afirmar(n = 0,
    'operador comum NAO le o mapeamento -- nem a propria linha');
end $$;
reset role;

-- anon nem chega a consultar
set role anon;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.ulbra_operadores_vinculo;
  exception when insufficient_privilege then ok := true; end;
  perform public.afirmar(ok, 'anon e barrado no privilegio, antes da RLS');
end $$;
reset role;

select 'MAPEAMENTO: todas as afirmacoes passaram' as resultado;
