-- BANCADA · ALLOWLIST DA IMPORTAÇÃO, PROD 22/10/2026 (as DUAS sobrecargas)
-- -----------------------------------------------------------------------------
-- Serve à correção 20261022131017 (escrita como 20261022150000; producao carimbou). Os dois corpos são os de produção, byte a
-- byte -- md5(prosrc) conferido pelo teste contra o .md5.json:
--   7 args (a tela usa): a0880e5367d19e0a02ef9f71c9447860
--   4 args (legado):     ea90af29c17787046fcbb61382028f3b
-- Transcrever foi necessário: nenhuma migration do repositório contém esses
-- corpos -- as definições derivaram de produção.
--
-- `auth.email()` é a definição VIVA, com os DOIS ramos do coalesce
-- (`request.jwt.claim.email` e `request.jwt.claims ->> 'email'`), e não um stub
-- simplificado. É isso que permite exercer com fidelidade o caso da chave de
-- serviço, que chega pelo segundo ramo, com `role` e sem `email`.
--
-- FIEL AO QUE PRODUÇÃO NÃO TEM: aqui NÃO existe índice em `titulo_numero`.
-- Produção também não (conferido em 22/10/2026: zero índices com essa coluna).
-- Isso importa porque a sobrecarga de 4 argumentos faz
-- `ON CONFLICT (titulo_numero, data_pagamento)` -- sem índice único
-- correspondente, o INSERT falha em execução e a transação inteira volta. Criar
-- o índice na bancada "para o teste passar" esconderia exatamente o fato que
-- dimensiona o risco dessa sobrecarga.
--
-- SEM os gatilhos de `pagamentos` (motor de conciliação), de propósito: o alvo é
-- a guarda de entrada. Nada aqui afirma efeito sobre conciliação ou baixa.
create schema if not exists auth;
create or replace function auth.email() returns text
 language sql stable as $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$function$;

create or replace function public.unaccent(t text) returns text
  language sql immutable as $$ select t $$;

create table if not exists public.importacoes (
  id uuid primary key default gen_random_uuid(),
  tipo text, referencia text, arquivo_nome text, usuario text,
  qtd_registros integer default 0, status text, observacao text,
  created_at timestamp without time zone default now(),
  retroativo boolean default false, mes_referencia text, dia_pagamento date,
  substitui_importacao_id uuid, substituido_por text,
  substituido_em timestamptz, excluido_por text, excluido_em timestamptz,
  motivo_exclusao text, motivo_substituicao text,
  reprocessado_por text, reprocessado_em timestamptz
);

create table if not exists public.pagamentos (
  id uuid primary key default gen_random_uuid(),
  data_pagamento date, valor_pago numeric, valor_honorario numeric,
  tipo_pagamento text, operador_email text, operador_nome text,
  aluno_nome text, cpf text, titulo_numero text,
  numero_parcela_completo text, dados jsonb,
  importacao_id uuid, retroativo boolean default false,
  operador_ajustado_manualmente boolean default false,
  created_at timestamptz default now()
);

create unique index if not exists uq_pagamentos_parcela_valor_data
  on public.pagamentos (numero_parcela_completo, valor_pago, data_pagamento)
  where numero_parcela_completo is not null;

create table if not exists public.auditoria (
  id uuid primary key default gen_random_uuid(),
  usuario text, acao text, tabela_afetada text, registro_id uuid,
  detalhes jsonb, created_at timestamptz default now()
);

create table if not exists public.rh_acompanhamento_diario (
  id uuid primary key default gen_random_uuid(),
  mes_referencia text, operador_email text, operador_nome text,
  valor_recuperado_acumulado numeric default 0,
  valor_honorarios_acumulado numeric default 0,
  alunos_pagos_qtd integer default 0, fonte_arquivo text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now(),
  unique (mes_referencia, operador_email)
);

create table if not exists public.alunos (
  id uuid primary key default gen_random_uuid(), nome text, cpf text
);

create table if not exists public.solicitacoes_confirmacao_pagamento (
  id uuid primary key, aluno_id text, aluno_nome text, aluno_cpf text,
  operador_email text, operador_nome text, valor_informado numeric,
  motivo text, status text, pagamento_id uuid unique,
  data_pagamento date, tipo_pagamento text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now()
);

create or replace function public.projecao_importar_pagamentos(
  p_arquivo_nome text, p_usuario text, p_linhas jsonb, p_mes_referencia text,
  p_retroativo boolean default false, p_substituir_importacao_id uuid default null,
  p_motivo_substituicao text default null)
 returns table(importacao_id uuid, linhas_gravadas integer)
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $function$
DECLARE
  v_email text := lower(auth.email());
  v_importacao_id uuid;
  v_qtd integer := 0;
  v_dia_pagamento date;
  v_meses_afetados text[];
  v_meses_antigos text[];
  v_ja_existe uuid;
BEGIN
  IF v_email NOT IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br') THEN
    RAISE EXCEPTION 'Sem permissão para importar a planilha de pagamentos.';
  END IF;

  SELECT mode() WITHIN GROUP (ORDER BY (v->>'data_pagamento')::date)
    INTO v_dia_pagamento
  FROM jsonb_array_elements(p_linhas) v
  WHERE (v->>'data_pagamento') IS NOT NULL;

  IF p_substituir_importacao_id IS NOT NULL THEN
    PERFORM 1 FROM public.importacoes i WHERE i.id = p_substituir_importacao_id AND i.status = 'CONCLUIDO';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Importação a ser substituída não encontrada ou já não está mais válida.';
    END IF;

    SELECT array_agg(DISTINCT to_char(p.data_pagamento, 'YYYY-MM'))
      INTO v_meses_antigos
    FROM public.pagamentos p
    WHERE p.importacao_id = p_substituir_importacao_id;

    UPDATE public.importacoes i
       SET status = 'SUBSTITUIDA', substituido_por = v_email, substituido_em = now(),
           motivo_substituicao = p_motivo_substituicao
     WHERE i.id = p_substituir_importacao_id;

    INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    VALUES (v_email, 'SUBSTITUIU_IMPORTACAO', 'importacoes', p_substituir_importacao_id,
            jsonb_build_object('motivo', p_motivo_substituicao, 'meses_afetados', v_meses_antigos));
  ELSE
    SELECT i.id INTO v_ja_existe
    FROM public.importacoes i
    WHERE i.mes_referencia = p_mes_referencia AND i.arquivo_nome = p_arquivo_nome AND i.status = 'CONCLUIDO'
    LIMIT 1;
    IF v_ja_existe IS NOT NULL THEN
      RAISE EXCEPTION 'IMPORTACAO_DUPLICADA:%', v_ja_existe;
    END IF;
  END IF;

  INSERT INTO public.importacoes (
    tipo, referencia, arquivo_nome, usuario, qtd_registros, status, retroativo,
    mes_referencia, dia_pagamento, substitui_importacao_id
  )
  VALUES (
    CASE WHEN p_retroativo THEN 'PROJECAO_RETROATIVA' ELSE 'PROJECAO_DIARIA' END,
    p_arquivo_nome || '-' || now()::text, p_arquivo_nome, p_usuario, jsonb_array_length(p_linhas),
    'EM_PROCESSAMENTO', p_retroativo, p_mes_referencia, v_dia_pagamento, p_substituir_importacao_id
  )
  RETURNING id INTO v_importacao_id;

  WITH linhas AS (
    SELECT
      (v->>'data_pagamento')::date AS data_pagamento,
      COALESCE((v->>'valor_pago')::numeric, 0) AS valor_pago,
      COALESCE((v->>'valor_honorario')::numeric, 0) AS valor_honorario,
      v->>'tipo_pagamento' AS tipo_pagamento,
      lower(v->>'operador_email') AS operador_email,
      v->>'operador_nome' AS operador_nome,
      v->>'aluno_nome' AS aluno_nome,
      v->>'cpf' AS cpf,
      v->>'titulo_numero' AS titulo_numero,
      v->>'numero_parcela_completo' AS numero_parcela_completo,
      v AS dados,
      ord
    FROM jsonb_array_elements(p_linhas) WITH ORDINALITY AS t(v, ord)
  ),
  linhas_final AS (
    -- Trava "duplicata exata": mesmo numero de titulo (parcela) + mesmo valor =
    -- UMA linha, INDEPENDENTE da data (antes colapsava so com mesma data, o que
    -- deixava passar o mesmo pagamento em datas diferentes). Juros/complemento
    -- (valor diferente) seguem mantidos como linhas separadas.
    (
      SELECT DISTINCT ON (numero_parcela_completo, valor_pago)
        data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
        operador_email, operador_nome, aluno_nome, cpf, titulo_numero,
        numero_parcela_completo, dados
      FROM linhas
      WHERE numero_parcela_completo IS NOT NULL
      ORDER BY numero_parcela_completo, valor_pago, data_pagamento, ord DESC
    )
    UNION ALL
    (
      SELECT
        data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
        operador_email, operador_nome, aluno_nome, cpf, titulo_numero,
        numero_parcela_completo, dados
      FROM linhas
      WHERE numero_parcela_completo IS NULL
    )
  ),
  ins AS (
    INSERT INTO public.pagamentos (
      data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
      operador_email, operador_nome, aluno_nome, cpf, titulo_numero,
      numero_parcela_completo, dados, importacao_id, retroativo
    )
    SELECT
      lf.data_pagamento, lf.valor_pago, lf.valor_honorario, lf.tipo_pagamento,
      lf.operador_email, lf.operador_nome, lf.aluno_nome, lf.cpf, lf.titulo_numero,
      lf.numero_parcela_completo, lf.dados, v_importacao_id, p_retroativo
    FROM linhas_final lf
    -- Bloqueia a duplicata exata contra o que JA existe (mesmo titulo+valor
    -- ativo), exceto a importacao sendo substituida. Juros/complemento passa.
    WHERE lf.numero_parcela_completo IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.pagamentos e
         WHERE e.numero_parcela_completo = lf.numero_parcela_completo
           AND round(coalesce(e.valor_pago,0),2) = round(coalesce(lf.valor_pago,0),2)
           AND coalesce(e.retroativo,false) = p_retroativo
           AND NOT (coalesce(e.dados,'{}'::jsonb) ? 'estornado_em')
           AND (p_substituir_importacao_id IS NULL OR e.importacao_id <> p_substituir_importacao_id)
       )
    ON CONFLICT (numero_parcela_completo, valor_pago, data_pagamento) WHERE numero_parcela_completo IS NOT NULL
    DO UPDATE SET
      valor_honorario = excluded.valor_honorario,
      tipo_pagamento = excluded.tipo_pagamento,
      aluno_nome = excluded.aluno_nome,
      cpf = excluded.cpf,
      titulo_numero = excluded.titulo_numero,
      dados = excluded.dados,
      importacao_id = excluded.importacao_id,
      retroativo = excluded.retroativo,
      operador_email = CASE WHEN public.pagamentos.operador_ajustado_manualmente
                             THEN public.pagamentos.operador_email ELSE excluded.operador_email END,
      operador_nome = CASE WHEN public.pagamentos.operador_ajustado_manualmente
                            THEN public.pagamentos.operador_nome ELSE excluded.operador_nome END
    RETURNING 1
  )
  SELECT count(*) INTO v_qtd FROM ins;

  UPDATE public.importacoes i SET status = 'CONCLUIDO' WHERE i.id = v_importacao_id;

  IF NOT p_retroativo THEN
    SELECT array_agg(DISTINCT to_char((v->>'data_pagamento')::date, 'YYYY-MM'))
      INTO v_meses_afetados
    FROM jsonb_array_elements(p_linhas) v
    WHERE (v->>'data_pagamento') IS NOT NULL;

    SELECT array_agg(DISTINCT m) INTO v_meses_afetados
    FROM unnest(COALESCE(v_meses_afetados, ARRAY[]::text[]) || COALESCE(v_meses_antigos, ARRAY[]::text[])) m;

    INSERT INTO public.rh_acompanhamento_diario (
      mes_referencia, operador_email, operador_nome,
      valor_recuperado_acumulado, valor_honorarios_acumulado, alunos_pagos_qtd, fonte_arquivo
    )
    SELECT
      to_char(p.data_pagamento, 'YYYY-MM'), p.operador_email, max(p.operador_nome),
      sum(p.valor_pago), sum(p.valor_honorario), count(*), p_arquivo_nome
    FROM public.pagamentos p
    WHERE to_char(p.data_pagamento, 'YYYY-MM') = ANY(v_meses_afetados)
      AND p.operador_email IS NOT NULL
      AND p.retroativo = false
    GROUP BY to_char(p.data_pagamento, 'YYYY-MM'), p.operador_email
    ON CONFLICT (mes_referencia, operador_email) DO UPDATE SET
      valor_recuperado_acumulado = excluded.valor_recuperado_acumulado,
      valor_honorarios_acumulado = excluded.valor_honorarios_acumulado,
      alunos_pagos_qtd = excluded.alunos_pagos_qtd,
      fonte_arquivo = excluded.fonte_arquivo,
      atualizado_em = now();
  END IF;

  IF p_retroativo THEN
    WITH candidatos AS (
      SELECT
        p.id AS pagamento_id, p.aluno_nome, p.valor_pago, p.operador_email, p.operador_nome,
        p.data_pagamento, p.tipo_pagamento, al.id AS aluno_id, al.cpf AS aluno_cpf,
        count(*) OVER (PARTITION BY p.id) AS qtd_matches
      FROM public.pagamentos p
      JOIN public.alunos al
        ON unaccent(lower(trim(al.nome))) = unaccent(lower(trim(p.aluno_nome)))
      WHERE p.importacao_id = v_importacao_id
        AND p.retroativo = true AND p.aluno_nome IS NOT NULL AND trim(p.aluno_nome) <> ''
    )
    INSERT INTO public.solicitacoes_confirmacao_pagamento (
      id, aluno_id, aluno_nome, aluno_cpf, operador_email, operador_nome,
      valor_informado, motivo, status, pagamento_id, data_pagamento, tipo_pagamento,
      criado_em, atualizado_em
    )
    SELECT
      gen_random_uuid(), c.aluno_id::text, c.aluno_nome, c.aluno_cpf, c.operador_email, c.operador_nome,
      c.valor_pago,
      'Pagamento retroativo identificado via Projeção Hora a Hora (match por nome).',
      'AGUARDANDO_CONFIRMACAO', c.pagamento_id, c.data_pagamento, c.tipo_pagamento, now(), now()
    FROM candidatos c
    WHERE c.qtd_matches = 1
    ON CONFLICT (pagamento_id) DO NOTHING;
  END IF;

  INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  VALUES (v_email, 'IMPORTOU', 'importacoes', v_importacao_id,
          jsonb_build_object('arquivo_nome', p_arquivo_nome, 'mes_referencia', p_mes_referencia,
                              'dia_pagamento', v_dia_pagamento, 'qtd_registros', v_qtd,
                              'retroativo', p_retroativo, 'substituiu', p_substituir_importacao_id));

  RETURN QUERY SELECT v_importacao_id, v_qtd;
END;
$function$;

create or replace function public.projecao_importar_pagamentos(
  p_arquivo_nome text, p_usuario text, p_linhas jsonb, p_retroativo boolean default false)
 returns table(importacao_id uuid, linhas_gravadas integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_importacao_id uuid;
  v_linha jsonb;
  v_qtd integer := 0;
  v_meses_afetados text[];
BEGIN
  IF lower(auth.email()) NOT IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br') THEN
    RAISE EXCEPTION 'Sem permissão para importar a planilha de pagamentos.';
  END IF;

  INSERT INTO public.importacoes (tipo, referencia, arquivo_nome, usuario, qtd_registros, status, retroativo)
  VALUES (
    CASE WHEN p_retroativo THEN 'PROJECAO_RETROATIVA' ELSE 'PROJECAO_DIARIA' END,
    p_arquivo_nome || '-' || now()::text, p_arquivo_nome, p_usuario, jsonb_array_length(p_linhas), 'EM_PROCESSAMENTO', p_retroativo
  )
  RETURNING id INTO v_importacao_id;

  FOR v_linha IN SELECT * FROM jsonb_array_elements(p_linhas)
  LOOP
    INSERT INTO public.pagamentos (
      data_pagamento, valor_pago, valor_honorario, tipo_pagamento,
      operador_email, operador_nome, aluno_nome, cpf, titulo_numero, dados, importacao_id, retroativo
    ) VALUES (
      (v_linha->>'data_pagamento')::date,
      COALESCE((v_linha->>'valor_pago')::numeric, 0),
      COALESCE((v_linha->>'valor_honorario')::numeric, 0),
      v_linha->>'tipo_pagamento',
      lower(v_linha->>'operador_email'),
      v_linha->>'operador_nome',
      v_linha->>'aluno_nome',
      v_linha->>'cpf',
      v_linha->>'titulo_numero',
      v_linha,
      v_importacao_id,
      p_retroativo
    )
    ON CONFLICT (titulo_numero, data_pagamento) WHERE titulo_numero IS NOT NULL
    DO UPDATE SET
      valor_pago = excluded.valor_pago,
      valor_honorario = excluded.valor_honorario,
      tipo_pagamento = excluded.tipo_pagamento,
      aluno_nome = excluded.aluno_nome,
      cpf = excluded.cpf,
      dados = excluded.dados,
      importacao_id = excluded.importacao_id,
      retroativo = excluded.retroativo,
      operador_email = CASE WHEN public.pagamentos.operador_ajustado_manualmente THEN public.pagamentos.operador_email ELSE excluded.operador_email END,
      operador_nome = CASE WHEN public.pagamentos.operador_ajustado_manualmente THEN public.pagamentos.operador_nome ELSE excluded.operador_nome END;
    v_qtd := v_qtd + 1;
  END LOOP;

  UPDATE public.importacoes SET status = 'CONCLUIDO' WHERE id = v_importacao_id;

  IF NOT p_retroativo THEN
    -- Recalcula (não só soma) o acumulado do mês por operador a partir de
    -- TODOS os pagamentos vigentes -- assim reenviar o mês corrige os
    -- números em vez de somar duplicado ou ficar parado na 1ª importação.
    SELECT array_agg(DISTINCT to_char((v->>'data_pagamento')::date, 'YYYY-MM'))
      INTO v_meses_afetados
    FROM jsonb_array_elements(p_linhas) v
    WHERE (v->>'data_pagamento') IS NOT NULL;

    INSERT INTO public.rh_acompanhamento_diario (
      mes_referencia, operador_email, operador_nome,
      valor_recuperado_acumulado, valor_honorarios_acumulado, alunos_pagos_qtd, fonte_arquivo
    )
    SELECT
      to_char(p.data_pagamento, 'YYYY-MM'), p.operador_email, max(p.operador_nome),
      sum(p.valor_pago), sum(p.valor_honorario), count(*), p_arquivo_nome
    FROM public.pagamentos p
    WHERE to_char(p.data_pagamento, 'YYYY-MM') = ANY(v_meses_afetados)
      AND p.operador_email IS NOT NULL
      AND p.retroativo = false
    GROUP BY to_char(p.data_pagamento, 'YYYY-MM'), p.operador_email
    ON CONFLICT (mes_referencia, operador_email) DO UPDATE SET
      valor_recuperado_acumulado = excluded.valor_recuperado_acumulado,
      valor_honorarios_acumulado = excluded.valor_honorarios_acumulado,
      alunos_pagos_qtd = excluded.alunos_pagos_qtd,
      fonte_arquivo = excluded.fonte_arquivo,
      atualizado_em = now();
  END IF;

  RETURN QUERY SELECT v_importacao_id, v_qtd;
END;
$function$;
