-- Acoes Massivas: filtro "Operador responsavel".
--
-- Amanda, 16/09/2026: "preciso usar hoje Acoes Massivas sobre a base de um
-- operador especifico".
--
-- REGRA
--   * Sem operador escolhido (NULL ou vazio): a regra de sempre, sem ampliar
--     nem reduzir nada. A base e "livre" (sem dono), "nunca acionado com dono"
--     ou "fora do prazo com dono".
--   * Com operador escolhido: SO os alunos cuja responsabilidade ATUAL
--     (`alunos.responsavel_atual_email`) e daquele operador. Livres e alunos de
--     outros nao entram. Todas as travas continuam: confirmacao de pagamento,
--     liquidado no Prime, quitado, encerramento operacional, acordo ativo,
--     retorno futuro e os filtros da tela (valor, ano, unidade, curso,
--     matricula, status academico, bordero, acionamento, canal).
--   * A chave e o e-mail, nunca o nome.
--   * Nada aqui troca responsavel, redistribui carteira ou mexe em fidelizacao
--     por conta propria. A previa e STABLE (so le).
--
-- TRES FUNCOES
--   1. `acoes_massivas_previa` ganha `p_operador_email text default null` no
--      FIM da assinatura. O valor em aberto passa a preferir o caso do proprio
--      operador quando ha operador escolhido; sem operador a ordem e a de
--      sempre. Devolve `operador_email` (o recorte aplicado) para a tela
--      conferir.
--   2. `registrar_acao_massiva` ganha o mesmo parametro. SEM ELE a geracao
--      final descartaria em silencio quem o operador ja acionou: hoje ela so
--      grava aluno "sem dono OU nunca acionado". Medido em 16/09 (leitura): dos
--      ~1.587 alunos elegiveis nas carteiras dos 8 operadores, so 338 sao
--      nunca acionados -- a planilha sairia com ~21% da previa. Com operador
--      escolhido, a revalidacao passa a ser "continua na carteira DELE"; quem
--      mudou de dono entre a previa e o registro e pulado e contado.
--   3. `acoes_massivas_filtros` devolve `operadores` (e-mail + nome) a partir do
--      cadastro: `usuarios.perfil = 'operador' and ativo` -- a mesma fonte do
--      giro de carteira e do nivelamento. So a gestao recebe a lista.
--
-- NAO HA AGENDAMENTO A PROPAGAR: o subsistema de agendamento foi removido em
-- 07/08 (migration 20260807320000). Conferido em producao em 16/09: nenhuma
-- funcao, tabela ou cron de agendamento de acao massiva existe.
--
-- POR QUE CIRURGIA E NAO RECOPIAR O CORPO: a previa viva em producao tem 13
-- parametros (branch calibragem, 02/09, fora da main) mais as cirurgias de
-- 08/09. Esta migration le a definicao VIVA, troca so as ancoras e recria. As
-- definicoes de 16/09 estao congeladas em
-- supabase/tests/fixtures/acoes_massivas_prod_20260916/ (md5 conferido contra
-- pg_get_functiondef em producao) e o teste de comportamento roda esta
-- migration por cima delas num PostgreSQL real (PGlite).
--
-- FALHA ALTO: se houver mais de uma sobrecarga, ou se qualquer ancora nao
-- aparecer exatamente uma vez, nada e instalado. Rodar de novo e inocuo.
--
-- ACL: previa e registro mudam de assinatura -- a funcao nova nasce com o
-- privilegio padrao, entao o revoke/grant e refeito aqui (sem anon, sem
-- PUBLIC; authenticated e service_role como antes) e a antiga e removida para
-- o PostgREST nao ficar entre duas candidatas. O comentario do registro e
-- copiado para a funcao nova. `acoes_massivas_filtros` mantem a assinatura:
-- create or replace preserva ACL.

do $migration$
declare
  v_fn          text;
  v_marca       text;
  v_muda_assin  boolean;
  v_oid_antigo  oid;
  v_oid_novo    oid;
  v_def         text;
  v_qtd         int;
  v_comentario  text;
  r             record;
begin
  create temp table _trocas_operador (fn text, ordem int, ancora text, nova text) on commit drop;

  insert into _trocas_operador values
  -- ---------------------------------------------------------------- previa
  ('acoes_massivas_previa', 1,
$a$p_valor_max numeric DEFAULT NULL::numeric)$a$,
$a$p_valor_max numeric DEFAULT NULL::numeric, p_operador_email text DEFAULT NULL::text)$a$),
  ('acoes_massivas_previa', 2,
$a$  v_result jsonb;$a$,
$a$  v_result jsonb;
  -- Operador responsavel escolhido na tela. NULL ou vazio = base livre / regra atual.
  v_operador text := lower(nullif(btrim(p_operador_email), ''));$a$),
  ('acoes_massivas_previa', 3,
$a$      WHERE c2.aluno_id = a.id
      ORDER BY c2.total_em_aberto DESC NULLS LAST$a$,
$a$      WHERE c2.aluno_id = a.id
      -- Com operador escolhido, o valor vem do caso DELE. Sem operador a
      -- primeira chave e falsa em todas as linhas e a ordem e a de sempre.
      ORDER BY (v_operador IS NOT NULL AND c2.operador_email IS NOT DISTINCT FROM v_operador) DESC,
               c2.total_em_aberto DESC NULLS LAST$a$),
  ('acoes_massivas_previa', 4,
$a$    WHERE (
            a.responsavel_atual_email IS NULL
            -- Ter dono nao quer dizer estar sendo trabalhado.
            OR (p_apenas_nunca_acionado AND a.data_ultimo_acionamento IS NULL)
            -- Passou do prazo sem acionamento: entra na acao, tendo dono ou nao.
            OR (p_dias_minimo_sem_contato IS NOT NULL
                AND a.data_ultimo_acionamento IS NOT NULL
                AND a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval))
          )$a$,
$a$    WHERE (
            -- Sem operador escolhido: a regra de sempre, sem tirar nem por.
            (v_operador IS NULL AND (
            a.responsavel_atual_email IS NULL
            -- Ter dono nao quer dizer estar sendo trabalhado.
            OR (p_apenas_nunca_acionado AND a.data_ultimo_acionamento IS NULL)
            -- Passou do prazo sem acionamento: entra na acao, tendo dono ou nao.
            OR (p_dias_minimo_sem_contato IS NOT NULL
                AND a.data_ultimo_acionamento IS NOT NULL
                AND a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval))
            ))
            -- Com operador escolhido: SO a carteira atual dele. Livre e aluno de
            -- outro operador nao entram. As travas abaixo valem igual.
            OR (v_operador IS NOT NULL AND a.responsavel_atual_email = v_operador)
          )$a$),
  ('acoes_massivas_previa', 5,
$a$    'total_elegivel_filtros', (SELECT count(*) FROM filtrado WHERE motivo_conf IS NULL)$a$,
$a$    'total_elegivel_filtros', (SELECT count(*) FROM filtrado WHERE motivo_conf IS NULL),
    -- Qual carteira a previa recortou (NULL = base livre / regra atual).
    'operador_email', v_operador$a$),
  -- -------------------------------------------------------------- registro
  ('registrar_acao_massiva', 1,
$a$p_registrado_por_email text)$a$,
$a$p_registrado_por_email text, p_operador_email text DEFAULT NULL::text)$a$),
  ('registrar_acao_massiva', 2,
$a$  v_liq_ids text[]; v_excluidos_liq int := 0;$a$,
$a$  v_liq_ids text[]; v_excluidos_liq int := 0;
  -- Operador escolhido na previa. NULL = base livre / regra atual.
  v_operador text := lower(nullif(btrim(p_operador_email), '')); v_excluidos_operador int := 0;$a$),
  ('registrar_acao_massiva', 3,
$a$       -- Sem dono, OU com dono e nunca acionado. Ter dono nao quer dizer que
       -- alguem trabalhou o caso.
       AND (responsavel_atual_email IS NULL OR data_ultimo_acionamento IS NULL);$a$,
$a$       -- Sem dono, OU com dono e nunca acionado. Ter dono nao quer dizer que
       -- alguem trabalhou o caso.
       -- Com operador escolhido o recorte e o da previa: o aluno tem de
       -- continuar na carteira DELE agora. Nada aqui troca o responsavel.
       AND ((v_operador IS NULL AND (responsavel_atual_email IS NULL OR data_ultimo_acionamento IS NULL))
            OR (v_operador IS NOT NULL AND responsavel_atual_email = v_operador));$a$),
  ('registrar_acao_massiva', 4,
$a$    ELSE
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso já acionado por operador, ou inexistente');$a$,
$a$    ELSIF v_operador IS NOT NULL THEN
      v_excluidos_operador := v_excluidos_operador + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Não está mais na carteira do operador selecionado, ou inexistente');
    ELSE
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso já acionado por operador, ou inexistente');$a$),
  ('registrar_acao_massiva', 5,
$a$    'excluidos_liquidados_prime', v_excluidos_liq,$a$,
$a$    'excluidos_liquidados_prime', v_excluidos_liq,
    'excluidos_outro_operador', v_excluidos_operador,
    'operador_email', v_operador,$a$),
  -- --------------------------------------------------------------- filtros
  ('acoes_massivas_filtros', 1,
$a$            GROUP BY btrim(situacao_academica)) s), '[]'::jsonb)
  );$a$,
$a$            GROUP BY btrim(situacao_academica)) s), '[]'::jsonb),
    -- Operadores ativos para o filtro "Operador responsavel". Fonte canonica: o
    -- cadastro (perfil operador e ativo), a mesma do giro e do nivelamento.
    -- Chave = e-mail. So a gestao recebe a lista.
    'operadores', CASE WHEN public.usuario_e_gestao() THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'email', lower(btrim(u.email)),
               'nome',  coalesce(nullif(btrim(u.nome),''), lower(btrim(u.email))))
             ORDER BY coalesce(nullif(btrim(u.nome),''), lower(btrim(u.email))), lower(btrim(u.email)))
      FROM public.usuarios u
      WHERE u.ativo AND u.perfil = 'operador' AND nullif(btrim(u.email),'') IS NOT NULL), '[]'::jsonb)
      ELSE '[]'::jsonb END
  );$a$);

  for v_fn, v_marca, v_muda_assin in
    select * from (values
      ('acoes_massivas_previa',  'p_operador_email', true),
      ('registrar_acao_massiva', 'p_operador_email', true),
      ('acoes_massivas_filtros', '''operadores''',   false)) t(fn, marca, muda)
  loop
    select count(*) into v_qtd
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;
    if v_qtd <> 1 then
      raise exception '%: esperava exatamente 1 sobrecarga, achei % -- revise antes de aplicar', v_fn, v_qtd;
    end if;

    select p.oid, pg_get_functiondef(p.oid) into v_oid_antigo, v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;

    if position(v_marca in v_def) > 0 then
      raise notice '% ja tem o filtro de operador; nada a fazer', v_fn;
      continue;
    end if;

    for r in select ancora, nova from _trocas_operador where fn = v_fn order by ordem loop
      if (length(v_def) - length(replace(v_def, r.ancora, ''))) / length(r.ancora) <> 1 then
        raise exception '%: ancora nao encontrada exatamente uma vez -- a funcao mudou, revise: %',
          v_fn, left(r.ancora, 120);
      end if;
      v_def := replace(v_def, r.ancora, r.nova);
    end loop;

    v_comentario := obj_description(v_oid_antigo, 'pg_proc');
    execute v_def;

    if v_muda_assin then
      select p.oid into v_oid_novo
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn and p.oid <> v_oid_antigo;
      if v_oid_novo is null then
        raise exception '%: a assinatura nova nao foi criada', v_fn;
      end if;

      execute format('drop function %s', v_oid_antigo::regprocedure);
      execute format('revoke all on function %s from public, anon', v_oid_novo::regprocedure);
      execute format('grant execute on function %s to authenticated, service_role', v_oid_novo::regprocedure);
      if v_comentario is not null then
        execute format('comment on function %s is %L', v_oid_novo::regprocedure, v_comentario);
      end if;
    end if;
  end loop;
end $migration$;
