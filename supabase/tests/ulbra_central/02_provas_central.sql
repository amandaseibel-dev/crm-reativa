-- PROVAS de ulbra_central_operador(text). Seed: recebimento + complemento.
--   A -> op1 (12 dias), B -> op2 (2 dias), C sem caso, D -> op1 (9 dias, caso
--   gravado como 'OP1@x' para provar que a comparacao ignora caixa).
--   c1 A cliente 05:00 | c2 B cliente 04:00 | c3 C cliente 03:00
--   c4 sem CPF cliente | c5 D ultima do operador
--   x1 A->op1 RODIZIO | x2 B->op2 CARTEIRA | x3 CONFERENCIA | x4 C->op2 RODIZIO
-- Qualquer afirmacao falsa aborta com 'FALHOU: ...'.
\set ON_ERROR_STOP on

-- ------------------------------------------------------------ privilegios
do $$ begin
  perform public.afirmar(not has_function_privilege('anon', 'public.ulbra_central_operador(text, integer, integer)', 'execute'),
    'anon NAO executa a central');
  perform public.afirmar(has_function_privilege('authenticated', 'public.ulbra_central_operador(text, integer, integer)', 'execute'),
    'authenticated executa (o recorte e interno)');
  perform public.afirmar((select prosecdef from pg_proc where oid = 'public.ulbra_central_operador(text, integer, integer)'::regprocedure),
    'e security definer');
  perform public.afirmar((select proconfig::text like '%search_path=public, pg_temp%' from pg_proc
                           where oid = 'public.ulbra_central_operador(text, integer, integer)'::regprocedure),
    'search_path fixo');
  perform public.afirmar((select provolatile = 's' from pg_proc where oid = 'public.ulbra_central_operador(text, integer, integer)'::regprocedure),
    'e STABLE: nao escreve');
  -- o que NAO pode ter mudado
  perform public.afirmar(not has_function_privilege('authenticated', 'public.ulbra_atendimento_assumir(text)', 'execute'),
    'assumir continua SEM execute para authenticated');
  perform public.afirmar(not has_function_privilege('authenticated', 'public.ulbra_atendimento_dispensar(text, text)', 'execute'),
    'dispensar continua SEM execute para authenticated');
end $$;

-- ------------------------------------------------------- portao: negados
set role authenticated; select set_config('teste.email', 'inativo@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_operador();
  perform public.afirmar(r->>'motivo' = 'ACESSO_NEGADO' and not (r ? 'respostas'), 'usuario inativo: ACESSO_NEGADO, sem listas');
end $$;
reset role;

set role authenticated; select set_config('teste.email', '', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_operador();
  perform public.afirmar(r->>'motivo' = 'ACESSO_NEGADO', 'sem e-mail no JWT: ACESSO_NEGADO');
end $$;
reset role;

set role authenticated;
select set_config('teste.email', 'painel.tv@reativa.local', false);
select set_config('teste.uid', '00000000-0000-0000-0000-0000000000a5', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_operador();
  perform public.afirmar(r->>'motivo' = 'ACESSO_NEGADO', 'painel de TV: ACESSO_NEGADO');
end $$;
reset role; select set_config('teste.uid', '', false);

-- o operador continua SEM enxergar as tabelas diretamente (RLS do piloto intacta)
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ begin
  perform public.afirmar((select count(*) from public.ulbra_conversas) = 0,
    'operador segue sem ler ulbra_conversas direto: a RLS nao foi aberta');
  perform public.afirmar((select count(*) from public.ulbra_atendimentos) = 0,
    'operador segue sem ler ulbra_atendimentos direto');
end $$;
reset role;

-- ------------------------------------------------ ISOLAMENTO: op1 ve so o seu
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; t text; begin
  r := public.ulbra_central_operador();
  t := r::text;
  perform public.afirmar((r->>'ok') = 'true' and (r->>'eh_gestao') = 'false', 'op1 recebe ok, nao e gestao');
  perform public.afirmar(r->>'operador' = 'op1@x', 'recorte de op1 e o proprio e-mail');
  perform public.afirmar(r->'operadores' = 'null'::jsonb, 'operador NAO recebe a lista de operadores');

  perform public.afirmar(jsonb_array_length(r->'respostas') = 1 and r->'respostas'->0->>'conversa_id' = 'c1',
    'respostas de op1 = so c1 (aluno A)');
  perform public.afirmar((r->'totais'->>'respostas')::int = 1, 'total de respostas de op1 = 1');
  perform public.afirmar(r->'respostas'->0->>'responsavel_reativa' = 'op1@x', 'responsavel no ReATIVA = op1');
  perform public.afirmar(r->'respostas'->0->'atendente_ulbra' = 'null'::jsonb,
    'atendente na Mensageria vem separado e aqui e null: nao se copia do ReATIVA');

  perform public.afirmar(jsonb_array_length(r->'novos') = 1 and r->'novos'->0->>'atendimento_id' = 'x1',
    'novos de op1 = so x1');

  -- A (12 dias, PERDENDO) antes de D (9 dias, CRITICO): mais tempo primeiro
  perform public.afirmar(jsonb_array_length(r->'sem_interacao') = 2
                     and r->'sem_interacao'->0->>'nome' = 'Aluno A' and r->'sem_interacao'->0->>'faixa' = 'PERDENDO'
                     and (r->'sem_interacao'->0->>'dias_sem_acionamento')::int = 12
                     and r->'sem_interacao'->1->>'nome' = 'Aluno D' and r->'sem_interacao'->1->>'faixa' = 'CRITICO',
    'sem interacao de op1: A (12 d, PERDENDO) depois D (9 d, CRITICO); caixa do e-mail do caso nao importa');
  perform public.afirmar(r->'sem_interacao'->1->>'atendente_ulbra' = 'Atendente Ulbra',
    'atendente na Mensageria aparece como a ULBRA informa');

  -- nada de outro operador, nada sem CPF
  perform public.afirmar(position('Aluno B' in t) = 0 and position('Aluno C' in t) = 0,
    'op1 NAO recebe nenhum dado de aluno de outro operador');
  perform public.afirmar(position('op2@x' in t) = 0, 'op1 NAO recebe e-mail de outro operador');
  perform public.afirmar(position('Sem CPF' in t) = 0 and position('segredo-c4' in t) = 0 and position('Sem vinculo' in t) = 0,
    'nada de identidade nao confirmada chega ao operador');
  -- c5: ultima mensagem e do operador -> nao e resposta aguardando
  perform public.afirmar(position('"c5"' in t) = 0, 'conversa com ultima mensagem do operador nao entra em respostas');
end $$;

-- op1 TENTANDO ler a fila de op2 pelo parametro: e ignorado
do $$ declare r jsonb; t text; begin
  r := public.ulbra_central_operador('op2@x');
  t := r::text;
  perform public.afirmar(r->>'operador' = 'op1@x', 'p_operador de quem nao e gestao e IGNORADO');
  perform public.afirmar(position('Aluno B' in t) = 0 and position('Aluno C' in t) = 0 and position('op2@x' in t) = 0,
    'op1 pedindo op2 continua vendo so o seu');
  perform public.afirmar(r = (public.ulbra_central_operador() - 'gerado_em') || jsonb_build_object('gerado_em', r->'gerado_em')
                      or (r - 'gerado_em' - 'respostas' - 'novos') = (public.ulbra_central_operador() - 'gerado_em' - 'respostas' - 'novos'),
    'resposta com parametro alheio tem o mesmo recorte da resposta sem parametro');
end $$;
reset role;

-- ------------------------------------------------ ISOLAMENTO: op2 ve so o seu
set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare r jsonb; t text; begin
  r := public.ulbra_central_operador('op1@x');
  t := r::text;
  perform public.afirmar(r->>'operador' = 'op2@x', 'op2 pedindo op1: recorte segue op2');
  perform public.afirmar(jsonb_array_length(r->'respostas') = 1 and r->'respostas'->0->>'conversa_id' = 'c2',
    'respostas de op2 = so c2 (aluno B)');
  perform public.afirmar(jsonb_array_length(r->'novos') = 2
                     and r->'novos'->0->>'atendimento_id' = 'x2' and r->'novos'->1->>'atendimento_id' = 'x4',
    'novos de op2 = x2 e x4, o mais antigo primeiro');
  perform public.afirmar(jsonb_array_length(r->'sem_interacao') = 0,
    'B esta dentro do prazo (2 dias): nao entra em sem interacao');
  perform public.afirmar(position('Aluno A' in t) = 0 and position('Aluno D' in t) = 0 and position('op1@x' in t) = 0,
    'op2 NAO recebe nenhum dado de op1');
end $$;
reset role;

-- --------------------- "lida" e "acionamento posterior" NAO tiram a resposta
insert into public.ulbra_leitura_usuario (usuario_email, ulbra_conversa_id, lido_ate)
values ('op1@x', 'c1', now());
update public.casos set data_ultimo_acionamento = (now() at time zone 'America/Sao_Paulo')::date
 where aluno_id = '00000000-0000-0000-0000-00000000000a';

set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_operador();
  perform public.afirmar(jsonb_array_length(r->'respostas') = 1 and r->'respostas'->0->>'conversa_id' = 'c1',
    'c1 CONTINUA em respostas depois de lida e de acionamento posterior');
  perform public.afirmar((r->'respostas'->0->>'lida') = 'true', 'vai marcada como lida, so informacao');
  perform public.afirmar((r->'respostas'->0->>'acionamento_posterior') = 'true',
    'acionamento posterior vai como informacao, nao como saida da fila');
  perform public.afirmar(jsonb_array_length(r->'sem_interacao') = 1 and r->'sem_interacao'->0->>'nome' = 'Aluno D',
    'com acionamento hoje, A sai de sem interacao; D (9 dias) fica');
end $$;
reset role;

-- a leitura de op1 nao e a de mais ninguem
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_operador('op1@x');
  perform public.afirmar((r->'respostas'->0->>'lida') = 'false', 'marcador de leitura e por pessoa: para a gestao c1 nao esta lida');
end $$;
reset role;

-- ------------------------------------------------------------------ gestao
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; t text; begin
  r := public.ulbra_central_operador();
  t := r::text;
  perform public.afirmar((r->>'eh_gestao') = 'true' and r->'operador' = 'null'::jsonb, 'gestao sem filtro: todos');
  perform public.afirmar(jsonb_array_length(r->'respostas') = 3
                     and r->'respostas'->0->>'conversa_id' = 'c3'
                     and r->'respostas'->1->>'conversa_id' = 'c2'
                     and r->'respostas'->2->>'conversa_id' = 'c1',
    'gestao ve as 3 respostas, a MAIS ANTIGA primeiro (c3, c2, c1)');
  perform public.afirmar(r->'respostas'->0->'responsavel_reativa' = 'null'::jsonb,
    'aluno C sem caso: responsavel no ReATIVA = null, nao inventado');
  perform public.afirmar(jsonb_array_length(r->'novos') = 3, 'gestao ve os 3 novos com CPF confirmado');
  perform public.afirmar(position('"x3"' in t) = 0 and position('"c4"' in t) = 0 and position('segredo-c4' in t) = 0,
    'conferencia e identidade nao confirmada NAO saem nem para a gestao por esta funcao');
  perform public.afirmar(r->'operadores' @> '["op1@x","op2@x"]'::jsonb, 'gestao recebe a lista de operadores para o filtro');

  -- filtro por operador
  r := public.ulbra_central_operador('  OP1@X ');
  perform public.afirmar(r->>'operador' = 'op1@x', 'filtro da gestao e normalizado (caixa e espacos)');
  perform public.afirmar(jsonb_array_length(r->'respostas') = 1 and r->'respostas'->0->>'conversa_id' = 'c1'
                     and jsonb_array_length(r->'novos') = 1 and r->'novos'->0->>'atendimento_id' = 'x1',
    'gestao filtrando op1 ve exatamente a fila de op1');

  -- coleta: sem ciclo ainda
  perform public.afirmar(r->'coleta'->>'estado' = 'SEM_CICLO', 'sem ultima_execucao: SEM_CICLO');
end $$;
reset role;

-- ------------------------------------------------ PAGINACAO SEM PERDA
-- 4 conversas com o MESMO carimbo de mensagem (empate proposital): sem
-- desempate por id, pagina repetiria e perderia linha.
insert into public.ulbra_conversas
  (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, situacao, equipe,
   responsavel_ulbra, ultima_mensagem_em, ultima_mensagem_quem, ultima_mensagem_previa,
   ultima_mensagem_cliente_em, aluno_id, aluno_status)
select 'p' || n, 'kp' || n, 'Aluno A', 'active', 'Reativa', null, '2026-11-08 04:30+00', 'cliente', 'empate',
       '2026-11-08 04:30+00', '00000000-0000-0000-0000-00000000000a', 'vinculado'
  from generate_series(1, 4) n;

set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; inteira jsonb; juntada jsonb := '[]'::jsonb; pg int; begin
  inteira := public.ulbra_central_operador(null, 200, 0);
  perform public.afirmar(jsonb_array_length(inteira->'respostas') = 7 and (inteira->'totais'->>'respostas')::int = 7,
    'lista inteira de respostas = 7 (3 do seed + 4 empatadas)');
  for pg in 0..3 loop
    r := public.ulbra_central_operador(null, 2, pg);
    perform public.afirmar((r->'totais'->>'respostas')::int = 7, 'toda pagina carrega o total (7)');
    perform public.afirmar(jsonb_array_length(r->'respostas') = case when pg < 3 then 2 else 1 end,
      'pagina ' || pg || ' tem o tamanho certo');
    juntada := juntada || (r->'respostas');
  end loop;
  perform public.afirmar(
    (select jsonb_agg(x->>'conversa_id') from jsonb_array_elements(juntada) x)
    = (select jsonb_agg(x->>'conversa_id') from jsonb_array_elements(inteira->'respostas') x),
    'paginas de 2 juntas = lista inteira, na mesma ordem: nada repetido, nada perdido');
  perform public.afirmar(
    (select count(distinct x->>'conversa_id') from jsonb_array_elements(juntada) x) = 7,
    '7 conversas distintas nas paginas');
  r := public.ulbra_central_operador(null, 2, 4);
  perform public.afirmar(jsonb_array_length(r->'respostas') = 0 and (r->'totais'->>'respostas')::int = 7,
    'pagina alem do fim vem vazia, com o total certo');
  r := public.ulbra_central_operador(null, 100000, -5);
  perform public.afirmar((r->>'limite')::int = 200 and (r->>'pagina')::int = 0,
    'limite e pagina fora da faixa sao contidos (200 e 0)');
end $$;
reset role;

-- a paginacao respeita o recorte: op2 paginando nunca alcanca linha de op1
set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare r jsonb; pg int; t text := ''; begin
  for pg in 0..4 loop
    r := public.ulbra_central_operador('op1@x', 1, pg);
    t := t || r::text;
  end loop;
  perform public.afirmar(position('Aluno A' in t) = 0 and position('"p1"' in t) = 0 and position('op1@x' in t) = 0,
    'op2 paginando ate o fim nao recebe nenhuma linha de op1');
  perform public.afirmar((public.ulbra_central_operador(null, 1, 0)->'totais'->>'respostas')::int = 1,
    'o total de op2 conta so o universo dele');
end $$;
reset role;

-- ------------------------------------------------------- estados da coleta
update public.ulbra_sync_estado set ultima_execucao = now() - interval '11 hours', ultimo_ciclo = 'OK' where id;
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_operador();
  perform public.afirmar(r->'coleta'->>'estado' = 'MANUAL',
    'sem cron ativo, 11 h de atraso e MANUAL -- nunca ATRASADA nem FALHA');
  perform public.afirmar((r->'coleta'->>'atraso_min')::numeric >= 659, 'atraso informado em minutos');
  perform public.afirmar(not (r->'coleta' ? 'saldo_api_restam') and not (r->'coleta' ? 'cursor_mensagem'),
    'operador nao recebe saldo de API nem cursor: so o carimbo da coleta');
end $$;
reset role;

update public.ulbra_sync_estado set ultimo_ciclo = 'FALHOU', ultimo_erro = 'HTTP_500' where id;
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_central_operador();
  perform public.afirmar(r->'coleta'->>'estado' = 'FALHA' and r->'coleta'->>'ultimo_erro' = 'HTTP_500',
    'ultimo ciclo FALHOU: FALHA, diferente de MANUAL');
end $$;
reset role;

-- --------------------------------- a RPC gerencial continua so da gestao
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_painel_gestao();
  perform public.afirmar(r->>'motivo' = 'ACESSO_NEGADO', 'ulbra_painel_gestao() segue NEGADA para operador');
end $$;
reset role;

select 'CENTRAL DO OPERADOR: portao, isolamento, paginacao, regras e estados provados' as resultado;
