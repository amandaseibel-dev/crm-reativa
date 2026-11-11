-- PROVAS de ulbra_central_conversas(timestamptz, text, integer, integer) no
-- Postgres real do CI. Seed PROPRIO desta prova (alunos P/Q/R, operadores
-- opp1/opp2, gestao amanda), sobre o ambiente do recebimento + stub de vinculos.
-- Qualquer afirmacao falsa aborta com 'FALHOU: ...'.
\set ON_ERROR_STOP on

insert into public.alunos (id, nome) values
  ('00000000-0000-0000-0000-0000000000a1', 'Aluno P'),
  ('00000000-0000-0000-0000-0000000000b1', 'Aluno Q'),
  ('00000000-0000-0000-0000-0000000000c1', 'Aluno R');
insert into public.usuarios (email, ativo) values ('opp1@x', true), ('opp2@x', true), ('inativo2@x', false)
  on conflict (email) do update set ativo = excluded.ativo;
insert into public.usuarios (email, ativo) values ('amanda.seibel@aelbra.com.br', true) on conflict (email) do update set ativo = true;
insert into public.casos (aluno_id, operador_email) values
  ('00000000-0000-0000-0000-0000000000a1', 'OPP1@x'),
  ('00000000-0000-0000-0000-0000000000b1', 'opp2@x'),
  ('00000000-0000-0000-0000-0000000000c1', 'opp1@x'),
  ('00000000-0000-0000-0000-0000000000c1', 'opp2@x'); -- R: dois operadores -> A_DEFINIR
insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values
  ('00000000-0000-0000-0000-0000000000a1', 'kp', 'alta_cpf', 'cpf'),
  ('00000000-0000-0000-0000-0000000000b1', 'kq', 'alta_cpf', 'cpf'),
  ('00000000-0000-0000-0000-0000000000c1', 'kr', 'alta_cpf', 'cpf');

insert into public.ulbra_conversas
  (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, situacao, equipe, responsavel_ulbra,
   ultima_mensagem_em, ultima_mensagem_quem, ultima_mensagem_previa, ultima_mensagem_cliente_em, aluno_id, aluno_status)
values
  ('p-out', 'kp', 'Aluno P', 'active', 'Reativa', null, '2026-10-28 12:00+00', 'cliente', 'out', '2026-10-28 12:00+00', '00000000-0000-0000-0000-0000000000a1', 'vinculado'),
  ('p-nov-env', 'kp', 'Aluno P', 'active', 'Reativa', 'Olga', '2026-11-03 12:00+00', 'operador', 'enviada', null, '00000000-0000-0000-0000-0000000000a1', 'vinculado'),
  ('p-nov-rec', 'kp', 'Aluno P', 'active', 'Reativa', 'Olga', '2026-11-09 12:00+00', 'cliente', 'recebida', '2026-11-09 12:00+00', '00000000-0000-0000-0000-0000000000a1', 'vinculado'),
  ('q-nov', 'kq', 'Aluno Q', 'active', 'Reativa', null, '2026-11-08 12:00+00', 'cliente', 'q', '2026-11-08 12:00+00', '00000000-0000-0000-0000-0000000000b1', 'vinculado'),
  ('r-nov', 'kr', 'Aluno R', 'active', 'Reativa', null, '2026-11-07 12:00+00', 'bot', 'r', null, '00000000-0000-0000-0000-0000000000c1', 'vinculado'),
  ('x-nov', 'kx', 'Sem CPF', 'active', 'Reativa', null, '2026-11-06 12:00+00', 'cliente', 'segredo-x', '2026-11-06 12:00+00', null, 'nao_confirmado');

-- ------------------------------------------------------------ privilegios
do $$ begin
  perform public.afirmar(not has_function_privilege('anon', 'public.ulbra_central_conversas(timestamptz, text, integer, integer)', 'execute'), 'anon NAO executa');
  perform public.afirmar(has_function_privilege('authenticated', 'public.ulbra_central_conversas(timestamptz, text, integer, integer)', 'execute'), 'authenticated executa (o recorte e interno)');
  perform public.afirmar((select prosecdef from pg_proc where oid = 'public.ulbra_central_conversas(timestamptz, text, integer, integer)'::regprocedure), 'security definer');
  perform public.afirmar((select proconfig::text like '%search_path=public, pg_temp%' from pg_proc where oid = 'public.ulbra_central_conversas(timestamptz, text, integer, integer)'::regprocedure), 'search_path fixo');
  perform public.afirmar((select provolatile = 's' from pg_proc where oid = 'public.ulbra_central_conversas(timestamptz, text, integer, integer)'::regprocedure), 'STABLE: nao escreve');
end $$;

-- --------------------------------------------------------- portao: negados
set role authenticated; select set_config('teste.email', 'inativo2@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_conversas('2026-11-01T03:00:00Z');
  perform public.afirmar(r->>'motivo' = 'ACESSO_NEGADO' and not (r ? 'conversas'), 'inativo: ACESSO_NEGADO, sem lista');
end $$;
reset role;

-- ------------------------------------------------ operador opp1: isolamento
set role authenticated; select set_config('teste.email', 'opp1@x', false);
do $$ declare r jsonb; ids text[]; begin
  r := public.ulbra_central_conversas('2026-11-01T03:00:00Z');
  perform public.afirmar((r->>'ok')::boolean and not (r->>'eh_gestao')::boolean, 'opp1: ok, nao e gestao');
  select array_agg(x->>'conversa_id' order by ord) into ids from jsonb_array_elements(r->'conversas') with ordinality t(x, ord);
  perform public.afirmar(ids = array['p-nov-rec','r-nov','p-nov-env'], 'opp1 ve P (dois) e R (compartilhado), mais recente primeiro; nada de outubro; nada de Q: ' || coalesce(ids::text, 'null'));
  perform public.afirmar((select x->>'direcao' from jsonb_array_elements(r->'conversas') x where x->>'conversa_id' = 'p-nov-rec') = 'recebida', 'direcao recebida');
  perform public.afirmar((select x->>'direcao' from jsonb_array_elements(r->'conversas') x where x->>'conversa_id' = 'p-nov-env') = 'enviada', 'direcao enviada');
  perform public.afirmar((select x->>'responsabilidade' from jsonb_array_elements(r->'conversas') x where x->>'conversa_id' = 'r-nov') = 'A_DEFINIR', 'R: responsabilidade a definir');
  perform public.afirmar((r->'totais'->>'conversas')::int = 3 and (r->'totais'->>'aguardando')::int = 1 and (r->'totais'->>'sem_cpf') is null, 'totais do operador; sem_cpf nao vai para operador');
  perform public.afirmar(r::text not like '%segredo-x%', 'nada da conversa sem CPF vaza');
  -- p_operador de outro e IGNORADO para quem nao e gestao
  r := public.ulbra_central_conversas('2026-11-01T03:00:00Z', 'opp2@x');
  select array_agg(x->>'conversa_id' order by ord) into ids from jsonb_array_elements(r->'conversas') with ordinality t(x, ord);
  perform public.afirmar(ids = array['p-nov-rec','r-nov','p-nov-env'], 'opp1 pedindo opp2 continua vendo so o proprio recorte');
end $$;
reset role;

-- ------------------------------------------------ operador opp2: isolamento
set role authenticated; select set_config('teste.email', 'opp2@x', false);
do $$ declare r jsonb; ids text[]; begin
  r := public.ulbra_central_conversas('2026-11-01T03:00:00Z');
  select array_agg(x->>'conversa_id' order by ord) into ids from jsonb_array_elements(r->'conversas') with ordinality t(x, ord);
  perform public.afirmar(ids = array['q-nov','r-nov'], 'opp2 ve Q e R, nao ve P: ' || coalesce(ids::text, 'null'));
  perform public.afirmar(r::text not like '%p-nov%', 'nenhuma conversa de P vaza para opp2');
end $$;
reset role;

-- ------------------------------------------------------------- gestao
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; ids text[]; begin
  r := public.ulbra_central_conversas('2026-11-01T03:00:00Z');
  perform public.afirmar((r->>'eh_gestao')::boolean, 'gestao');
  select array_agg(x->>'conversa_id' order by ord) into ids from jsonb_array_elements(r->'conversas') with ordinality t(x, ord);
  perform public.afirmar(ids = array['p-nov-rec','q-nov','r-nov','p-nov-env'], 'gestao ve todas do periodo com CPF, mais recente primeiro: ' || coalesce(ids::text, 'null'));
  -- o seed do recebimento tambem tem conversas de novembro sem vinculo alta_cpf: conta-se tudo
  perform public.afirmar((r->'totais'->>'sem_cpf')::int = (
      select count(*) from public.ulbra_conversas c
       where c.equipe = 'Reativa' and c.ultima_mensagem_em >= '2026-11-01T03:00:00Z'
         and not (c.aluno_status = 'vinculado' and c.aluno_id is not null
                  and exists (select 1 from public.ulbra_vinculos vv where vv.ulbra_cliente_id = c.ulbra_cliente_id and vv.desvinculado_em is null and vv.confianca = 'alta_cpf')))
    and (r->'totais'->>'sem_cpf')::int >= 1,
    'gestao recebe a contagem do que esta sem CPF no periodo (inclui x-nov): ' || (r->'totais'->>'sem_cpf'));
  perform public.afirmar(r::text not like '%segredo-x%', 'a conversa sem CPF nao sai nem para a gestao');
  r := public.ulbra_central_conversas('2026-11-01T03:00:00Z', 'opp2@x');
  select array_agg(x->>'conversa_id' order by ord) into ids from jsonb_array_elements(r->'conversas') with ordinality t(x, ord);
  perform public.afirmar(ids = array['q-nov','r-nov'], 'gestao com filtro ve so opp2');
  -- padrao de periodo: mes corrente em Brasilia (nao e nulo)
  r := public.ulbra_central_conversas();
  perform public.afirmar((r->>'desde') is not null, 'desde padrao preenchido');
end $$;
reset role;

-- ---------------------------------------- revogacao de vinculo some na hora
update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'kq';
set role authenticated; select set_config('teste.email', 'opp2@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_conversas('2026-11-01T03:00:00Z');
  perform public.afirmar(not (r::text like '%q-nov%'), 'vinculo revogado: Q some mesmo com aluno_status vinculado');
end $$;
reset role;

select 'CONVERSAS DO PERIODO: provas ok' as resultado;
