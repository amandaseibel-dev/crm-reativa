-- PROVAS da funcao ulbra_painel_gestao(), sobre o mesmo seed do recebimento
-- (3 conversas c1..c3, 4 atendimentos x1..x4, estado ainda sem ciclo).
-- Qualquer afirmacao falsa aborta com 'FALHOU: ...'.
\set ON_ERROR_STOP on

-- ------------------------------------------------------------ privilegios
do $$ begin
  perform public.afirmar(not has_function_privilege('anon', 'public.ulbra_painel_gestao()', 'execute'),
    'anon NAO executa o painel');
  perform public.afirmar(has_function_privilege('authenticated', 'public.ulbra_painel_gestao()', 'execute'),
    'authenticated executa (o portao interno e quem restringe a gestao)');
end $$;

-- -------------------------------------------- portao: operador recebe NEGADO
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_painel_gestao();
  perform public.afirmar((r->>'ok') = 'false' and r->>'motivo' = 'ACESSO_NEGADO',
    'operador comum recebe ACESSO_NEGADO e nenhum numero');
  perform public.afirmar(r ? 'conversas' = false, 'resposta negada nao carrega agregados');
end $$;
reset role;

-- usuario inativo tambem
set role authenticated; select set_config('teste.email', 'inativo@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_painel_gestao();
  perform public.afirmar(r->>'motivo' = 'ACESSO_NEGADO', 'usuario inativo recebe ACESSO_NEGADO');
end $$;
reset role;

-- --------------------------------------------- gestao: agregados do seed
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_painel_gestao();
  perform public.afirmar((r->>'ok') = 'true', 'gestao recebe ok');

  -- 5. estados: sem ciclo ainda
  perform public.afirmar(r->>'estado' = 'SEM_CICLO', 'sem ultima_execucao o estado e SEM_CICLO');
  perform public.afirmar(r->'sync'->>'atraso_min' is null, 'sem ciclo nao ha atraso (null, nao zero)');
  -- sem pg_cron no ambiente de teste: nunca inventa "automatica"
  perform public.afirmar(r->>'atualizacao' in ('manual', 'desconhecida'),
    'sem cron.job legivel, atualizacao e manual ou desconhecida -- nunca automatica');

  -- 2. conversas
  perform public.afirmar((r->'conversas'->>'total')::int = 3, 'conversas total = 3');
  perform public.afirmar((r->'conversas'->>'resposta_aguardando')::int = 3,
    'as 3 conversas tem ultima mensagem do cliente = resposta aguardando');
  perform public.afirmar((r->'conversas'->>'nao_lidas_para_mim')::int = 3,
    'gestao ainda nao leu nenhuma: 3 nao lidas PARA ELA');
  perform public.afirmar((r->'conversas'->'por_canal'->>'whatsapp')::int = 3, 'por_canal whatsapp = 3');
  perform public.afirmar(r->'conversas'->'por_canal' ? 'email' = false, 'e-mail nao aparece como coletado');
  perform public.afirmar((r->'conversas'->>'espera_resposta_max_min')::numeric > 0,
    'espera de resposta e contada desde a ultima mensagem do cliente');

  -- 2. atendimentos
  perform public.afirmar((r->'atendimentos'->>'coletados')::int = 4, 'atendimentos coletados = 4');
  perform public.afirmar((r->'atendimentos'->>'sem_responsavel_reativa')::int = 4,
    'sem responsavel NO REATIVA = 4 (ninguem assumiu aqui)');
  perform public.afirmar(r->'atendimentos' ? 'sem_responsavel' = false,
    'nao existe mais a chave ambigua sem_responsavel');
  perform public.afirmar(r->'atendimentos'->'atendente_ulbra' = 'null'::jsonb,
    'atendente NA MENSAGERIA = null (nao disponivel): responsavel_email vazio NAO prova nada sobre a ULBRA');
  -- lado ULBRA nas conversas: o seed nao tem responsavel_ulbra
  perform public.afirmar((r->'conversas'->>'sem_atendente_ulbra')::int = 3
                     and (r->'conversas'->>'com_atendente_ulbra')::int = 0
                     and r->'conversas'->'por_atendente_ulbra' = '{}'::jsonb,
    'conversas: 3 sem atendente ULBRA, 0 com, mapa vazio');
  perform public.afirmar((r->'atendimentos'->>'em_conferencia')::int = 1, 'em conferencia = 1 (x3)');
  perform public.afirmar((r->'atendimentos'->>'sem_operador')::int = 0, 'sem operador = 0');
  perform public.afirmar((r->'atendimentos'->'por_destino_sugerido'->>'RODIZIO')::int = 2
                     and (r->'atendimentos'->'por_destino_sugerido'->>'CARTEIRA')::int = 1,
    'destino SUGERIDO sai rotulado como sugestao: RODIZIO 2, CARTEIRA 1');
  perform public.afirmar(r->'atendimentos'->'por_responsavel_reativa' = '{}'::jsonb,
    'por_responsavel_reativa vazio: sugestao NAO conta como posse no ReATIVA');
  perform public.afirmar(r->'atendimentos'->'por_canal' = 'null'::jsonb,
    'canal de atendimento = null (nao disponivel), nunca inventado');
  perform public.afirmar(r->'atendimentos'->'divergencia_carteira_ulbra' = 'null'::jsonb,
    'divergencia por responsavel = null: nao se calcula por nome');

  -- 3. espera
  perform public.afirmar(r->'espera'->>'base' like 'entrou_em%', 'a base da espera e entrou_em, declarada');
  perform public.afirmar(r->'espera'->>'universo' like '%NO REATIVA%',
    'a espera declara o universo: sem responsavel NO REATIVA');
  perform public.afirmar((r->'espera'->>'n')::int = 4 and (r->'espera'->>'sem_data')::int = 0,
    'espera: 4 atendimentos com data, 0 sem data');
  perform public.afirmar((r->'espera'->>'max_min')::numeric >= (r->'espera'->>'mediana_min')::numeric,
    'max >= mediana');

  -- 4. cobertura
  perform public.afirmar(r->'cobertura'->>'equipe' = 'Reativa', 'cobertura: equipe Reativa');
  perform public.afirmar(r->'cobertura'->'canais_coletados' = '["whatsapp"]'::jsonb, 'cobertura: so whatsapp coletado');
  perform public.afirmar(r->'cobertura'->'alcance_paginas' = 'null'::jsonb, 'alcance em paginas = nao disponivel');
  perform public.afirmar(r->'cobertura'->'periodo'->>'conversas_de' is not null, 'periodo coletado informado');

  -- nenhum dado pessoal: a resposta nao carrega nome, previa nem id de cliente
  perform public.afirmar(position('Aluno A' in r::text) = 0 and position('k1' in r::text) = 0,
    'resposta sem nome de cliente e sem id de cliente');
end $$;
reset role;

-- --------------------------------- leitura por usuario muda SO o meu numero
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  perform public.ulbra_conversa_marcar_lida('c1');
  r := public.ulbra_painel_gestao();
  perform public.afirmar((r->'conversas'->>'nao_lidas_para_mim')::int = 2,
    'gestao marcou c1: nao lidas PARA ELA caem para 2');
  perform public.afirmar((r->'conversas'->>'resposta_aguardando')::int = 3,
    'mas resposta aguardando continua 3: leitura e por pessoa, nao apaga o fato');
end $$;
reset role;

-- ----------------------------------------------- 5. estados do ciclo
-- Simula o que a sincronizacao grava, como superusuario.
update public.ulbra_sync_estado set ultima_execucao = now() - interval '3 minutes',
  ultimo_ciclo = 'INCOMPLETO', ultimo_erro = 'BACKLOG_OU_ORCAMENTO', chamadas_dia = 7 where id;
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_painel_gestao();
  perform public.afirmar(r->>'estado' = 'INCOMPLETO', 'ciclo INCOMPLETO vira estado INCOMPLETO');
  perform public.afirmar((r->'sync'->>'atraso_min')::numeric between 2 and 4, 'atraso em minutos calculado');
  perform public.afirmar((r->'sync'->>'chamadas_dia')::int = 7, 'chamadas do dia repassadas');
end $$;
reset role;

update public.ulbra_sync_estado set ultimo_ciclo = 'FALHOU', ultimo_erro = 'ULBRA_HTTP_502' where id;
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_painel_gestao();
  perform public.afirmar(r->>'estado' = 'ERRO', 'ciclo FALHOU vira estado ERRO');
  perform public.afirmar(r->'sync'->>'ultimo_erro' = 'ULBRA_HTTP_502', 'erro repassado');
end $$;
reset role;

-- Sem cron, atraso grande NAO vira DESATUALIZADO (e atualizacao manual).
update public.ulbra_sync_estado set ultimo_ciclo = 'OK', ultimo_erro = null,
  ultima_execucao = now() - interval '3 hours' where id;
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_painel_gestao();
  perform public.afirmar(r->>'estado' = 'COLETA_CONCLUIDA',
    'sem cron, ciclo OK vira COLETA_CONCLUIDA (nunca EM_DIA, nunca DESATUALIZADO): a tela diz a data e hora');
  perform public.afirmar(r->'sync'->>'ultima_execucao' is not null,
    'COLETA_CONCLUIDA sempre vem com a data e hora da ultima execucao');
  perform public.afirmar((r->'sync'->>'atraso_min')::numeric >= 179, 'atraso de ~180 min informado');
end $$;
reset role;

-- PULADO_ORCAMENTO e estado proprio: nada foi lido, nao e "atualizado".
update public.ulbra_sync_estado set ultimo_ciclo = 'PULADO_ORCAMENTO', ultimo_erro = 'ORCAMENTO_DO_DIA',
  ultima_execucao = now() - interval '2 minutes' where id;
set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_painel_gestao();
  perform public.afirmar(r->>'estado' = 'PULADO_ORCAMENTO',
    'ciclo PULADO_ORCAMENTO vira estado PULADO_ORCAMENTO -- nunca EM_DIA nem COLETA_CONCLUIDA');
  perform public.afirmar(r->'sync'->>'ultimo_erro' = 'ORCAMENTO_DO_DIA', 'motivo do pulo repassado');
end $$;
reset role;

select 'PAINEL GESTAO: todas as afirmacoes passaram' as resultado;
