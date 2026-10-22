-- BANCADA · AS DUAS PRIORITÁRIAS DA IDENTIDADE NULA, PROD 22/10/2026
-- -----------------------------------------------------------------------------
-- Serve à migration 20261022170000. Os dois corpos são os de produção, byte a
-- byte -- md5(prosrc) conferido pelo teste:
--   projecao_excluir_importacao(uuid,text)         7306b6dbe648e80a3e2dca17a531236d
--   projecao_alterar_operador(uuid,text,text,text) 373ac04072677eca1e39520872f86fe2
-- Transcrever foi necessário: nenhuma migration do repositório contém esses
-- corpos; as definições derivaram de produção.
--
-- `auth.email()` é a definição VIVA, com os DOIS ramos do coalesce, para que o
-- caso da chave de serviço (claims com `role` e sem `email`) seja exercido pelo
-- caminho real, e não por um stub conveniente.
--
-- `projecao_snapshot_atualizar` é dublê que REGISTRA a chamada, em vez de não
-- fazer nada: assim o teste pode provar que a recusa não chega nem a disparar o
-- recálculo do snapshot.
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

create table if not exists public.importacoes (
  id uuid primary key default gen_random_uuid(),
  tipo text, referencia text, arquivo_nome text, usuario text,
  qtd_registros integer default 0, status text,
  created_at timestamp without time zone default now(),
  retroativo boolean default false, mes_referencia text, dia_pagamento date,
  substitui_importacao_id uuid, substituido_por text, substituido_em timestamptz,
  excluido_por text, excluido_em timestamptz, motivo_exclusao text,
  motivo_substituicao text
);

create table if not exists public.pagamentos (
  id uuid primary key default gen_random_uuid(),
  data_pagamento date, valor_pago numeric, valor_honorario numeric,
  tipo_pagamento text, operador_email text, operador_nome text,
  aluno_nome text, cpf text, titulo_numero text, numero_parcela_completo text,
  dados jsonb, importacao_id uuid, retroativo boolean default false,
  operador_ajustado_manualmente boolean default false,
  created_at timestamptz default now()
);

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

create table if not exists public.historico_operador_projecao (
  id uuid primary key default gen_random_uuid(),
  pagamento_id uuid, operador_anterior text, operador_novo text,
  alterado_por text, motivo text, created_at timestamptz default now()
);

-- Dublê que deixa rastro: a recusa não pode nem chegar a chamá-lo.
create table if not exists public._dub_snapshot (mes text, em timestamptz default now());
create or replace function public.projecao_snapshot_atualizar(p_mes text)
 returns void language plpgsql as $$
begin insert into public._dub_snapshot(mes) values (p_mes); end $$;

create or replace function public.projecao_excluir_importacao(
  p_importacao_id uuid, p_motivo text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_email text := lower(auth.email());
  v_meses_afetados text[];
  v_operadores_afetados text[];
BEGIN
  IF v_email NOT IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br') THEN
    RAISE EXCEPTION 'Sem permissão para excluir importações.';
  END IF;

  PERFORM 1 FROM public.importacoes WHERE id = p_importacao_id AND status = 'CONCLUIDO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Importação não encontrada ou já não está mais válida.';
  END IF;

  SELECT array_agg(DISTINCT to_char(data_pagamento, 'YYYY-MM')),
         array_agg(DISTINCT operador_email)
    INTO v_meses_afetados, v_operadores_afetados
  FROM public.pagamentos WHERE importacao_id = p_importacao_id;

  DELETE FROM public.pagamentos WHERE importacao_id = p_importacao_id;

  UPDATE public.importacoes
     SET status = 'EXCLUIDA', excluido_por = v_email, excluido_em = now(), motivo_exclusao = p_motivo
   WHERE id = p_importacao_id;

  -- Recalcula do zero o acumulado dos operadores afetados nos meses
  -- afetados, a partir do que sobrou em public.pagamentos.
  IF v_meses_afetados IS NOT NULL THEN
    INSERT INTO public.rh_acompanhamento_diario (
      mes_referencia, operador_email, operador_nome,
      valor_recuperado_acumulado, valor_honorarios_acumulado, alunos_pagos_qtd, fonte_arquivo
    )
    SELECT to_char(p.data_pagamento, 'YYYY-MM'), p.operador_email, max(p.operador_nome),
           sum(p.valor_pago), sum(p.valor_honorario), count(*), 'RECALCULO_EXCLUSAO'
    FROM public.pagamentos p
    WHERE to_char(p.data_pagamento, 'YYYY-MM') = ANY(v_meses_afetados)
      AND p.operador_email = ANY(v_operadores_afetados)
      AND p.retroativo = false
    GROUP BY to_char(p.data_pagamento, 'YYYY-MM'), p.operador_email
    ON CONFLICT (mes_referencia, operador_email) DO UPDATE SET
      valor_recuperado_acumulado = excluded.valor_recuperado_acumulado,
      valor_honorarios_acumulado = excluded.valor_honorarios_acumulado,
      alunos_pagos_qtd = excluded.alunos_pagos_qtd,
      fonte_arquivo = excluded.fonte_arquivo,
      atualizado_em = now();

    -- Zera quem ficou sem nenhum pagamento no mês depois da exclusão.
    UPDATE public.rh_acompanhamento_diario r
       SET valor_recuperado_acumulado = 0, valor_honorarios_acumulado = 0, alunos_pagos_qtd = 0,
           fonte_arquivo = 'RECALCULO_EXCLUSAO', atualizado_em = now()
     WHERE r.mes_referencia = ANY(v_meses_afetados)
       AND r.operador_email = ANY(v_operadores_afetados)
       AND NOT EXISTS (
         SELECT 1 FROM public.pagamentos p
         WHERE to_char(p.data_pagamento, 'YYYY-MM') = r.mes_referencia
           AND p.operador_email = r.operador_email
           AND p.retroativo = false
       );
  END IF;

  INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  VALUES (v_email, 'EXCLUIU_IMPORTACAO', 'importacoes', p_importacao_id,
          jsonb_build_object('motivo', p_motivo, 'meses_afetados', v_meses_afetados));
END;
$function$;

create or replace function public.projecao_alterar_operador(
  p_pagamento_id uuid, p_novo_operador_email text, p_novo_operador_nome text, p_motivo text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_email text := lower(auth.email());
  v_operador_anterior text;
  v_mes_referencia text;
  v_retroativo boolean;
BEGIN
  IF v_email NOT IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br') THEN
    RAISE EXCEPTION 'Sem permissão para alterar o operador responsável.';
  END IF;

  SELECT operador_email, to_char(data_pagamento, 'YYYY-MM'), retroativo
    INTO v_operador_anterior, v_mes_referencia, v_retroativo
  FROM public.pagamentos WHERE id = p_pagamento_id;

  UPDATE public.pagamentos
     SET operador_email = lower(p_novo_operador_email),
         operador_nome = p_novo_operador_nome,
         operador_ajustado_manualmente = true
   WHERE id = p_pagamento_id;

  INSERT INTO public.historico_operador_projecao (pagamento_id, operador_anterior, operador_novo, alterado_por, motivo)
  VALUES (p_pagamento_id, v_operador_anterior, lower(p_novo_operador_email), v_email, p_motivo);

  INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  VALUES (v_email, 'ALTEROU_OPERADOR', 'pagamentos', p_pagamento_id,
          jsonb_build_object('operador_anterior', v_operador_anterior, 'operador_novo', lower(p_novo_operador_email),
                              'motivo', p_motivo, 'mes_referencia', v_mes_referencia));

  IF v_mes_referencia IS NOT NULL AND COALESCE(v_retroativo, false) = false THEN
    PERFORM public.projecao_snapshot_atualizar(v_mes_referencia);
  END IF;
END;
$function$;
