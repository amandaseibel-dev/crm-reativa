-- ROLLBACK de 20260916200000_acoes_massivas_filtro_operador.
--
-- Desfaz a cirurgia na definicao viva: cada trecho novo volta a ser a ancora
-- original, a assinatura com `p_operador_email` e removida e a antiga volta com
-- a mesma ACL (authenticated e service_role; sem anon, sem PUBLIC) e o mesmo
-- comentario. O teste de comportamento prova que, aplicada a migration e depois
-- este rollback, o pg_get_functiondef das tres funcoes volta a ser identico ao
-- de antes.
--
-- Falha alto se algum trecho novo nao aparecer exatamente uma vez. Rodar sem a
-- migration aplicada e inocuo.
--
-- A TELA: se o front com o seletor de operador ja estiver publicado, a previa
-- SEM operador continua funcionando (o front so manda `p_operador_email` quando
-- ha operador escolhido) e a lista de operadores some do seletor.

do $rollback$
declare
  v_fn          text;
  v_marca       text;
  v_muda_assin  boolean;
  v_oid_novo    oid;
  v_oid_antigo  oid;
  v_def         text;
  v_qtd         int;
  v_comentario  text;
  r             record;
begin
  -- Os pares (ancora, nova) sao repetidos aqui de proposito: o rollback nao le
  -- arquivo. O teste confere que sao identicos aos da migration.
  create temp table _desfaz_operador (fn text, ordem int, ancora text, nova text) on commit drop;

  insert into _desfaz_operador values
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
      raise exception '%: esperava exatamente 1 sobrecarga, achei % -- revise antes de desfazer', v_fn, v_qtd;
    end if;

    select p.oid, pg_get_functiondef(p.oid) into v_oid_novo, v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;

    if position(v_marca in v_def) = 0 then
      raise notice '% nao tem o filtro de operador; nada a desfazer', v_fn;
      continue;
    end if;

    -- ordem inversa: a assinatura (ordem 1) volta por ultimo
    for r in select ancora, nova from _desfaz_operador where fn = v_fn order by ordem desc loop
      if (length(v_def) - length(replace(v_def, r.nova, ''))) / length(r.nova) <> 1 then
        raise exception '%: trecho novo nao encontrado exatamente uma vez -- a funcao mudou, revise: %',
          v_fn, left(r.nova, 120);
      end if;
      v_def := replace(v_def, r.nova, r.ancora);
    end loop;

    v_comentario := obj_description(v_oid_novo, 'pg_proc');
    execute v_def;

    if v_muda_assin then
      select p.oid into v_oid_antigo
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn and p.oid <> v_oid_novo;
      if v_oid_antigo is null then
        raise exception '%: a assinatura antiga nao foi recriada', v_fn;
      end if;

      execute format('drop function %s', v_oid_novo::regprocedure);
      execute format('revoke all on function %s from public, anon', v_oid_antigo::regprocedure);
      execute format('grant execute on function %s to authenticated, service_role', v_oid_antigo::regprocedure);
      if v_comentario is not null then
        execute format('comment on function %s is %L', v_oid_antigo::regprocedure, v_comentario);
      end if;
    end if;
  end loop;
end $rollback$;
