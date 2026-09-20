-- ROLLBACK de 20260920120000_acoes_massivas_registro_sem_fidelizacao.sql
-- Restaura o gatilho, registrar_acao_massiva, acoes_massivas_exportar e
-- acoes_massivas_concluir_lote exatamente como estavam em producao em
-- 20/09/2026 (pg_get_functiondef). Depois deste, aplicar o rollback de 110000.
--
-- ATENCAO: restaurar o gatilho VOLTA a renovar a fidelizacao com acao massiva.
-- Movimentacoes gravadas no periodo novo (sem data_ultimo_acionamento) NAO sao
-- reprocessadas; as colunas novas (lote_id etc.) ficam, sao nulas e inofensivas.

CREATE OR REPLACE FUNCTION public.fn_atualizar_ultimo_acionamento()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = new.registrado_em::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < new.registrado_em::date);

  -- recalcular situacao/criticidade apos o acionamento (dias_sem_acionamento zera).
  -- protegido: falha aqui nunca impede o registro do acionamento.
  begin
    perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
  exception when others then
    null;
  end;

  return new;
exception when others then
  -- nunca impedir o registro do acionamento por falha na atualizacao da ficha
  return new;
end;
$function$;

drop function if exists public.registrar_acao_massiva(text[], text, text, text, text, text, uuid, jsonb);
drop function if exists public.acoes_massivas_exportar(text[], text, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.registrar_acao_massiva(p_aluno_ids text[], p_canal text, p_arquivo text, p_registrado_por_nome text, p_registrado_por_email text, p_operador_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_id text;
  v_retorno date := (current_date + 10);
  v_agora timestamptz := now();
  v_tipo text := CASE WHEN p_canal = 'WHATSAPP' THEN 'ACAO_MASSIVA_EXTERNA' ELSE 'ACAO_MASSIVA_EXTERNA_EMAIL' END;
  v_registrados text[] := '{}';
  v_excluidos_conf int := 0; v_excluidos jsonb := '[]'::jsonb; v_mov int := 0;
  v_sistema boolean := (auth.role() = 'service_role')
                       OR (auth.jwt() IS NULL AND session_user IN ('postgres','reativa_responsavel_executor'));
  v_autor_email text; v_autor_nome text; v_contatos jsonb;
  v_conf_ids text[];
  v_liq_ids text[]; v_excluidos_liq int := 0;
  -- Operador escolhido na previa. NULL = base livre / regra atual.
  v_operador text := lower(nullif(btrim(p_operador_email), '')); v_excluidos_operador int := 0;
BEGIN
  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.' USING ERRCODE = '42501';
  END IF;

  -- Esta funcao NAO dispara nada: gera o registro de uma acao que aconteceu POR
  -- FORA (planilha). Disparar em massa pelo nosso numero segue proibido, e essa
  -- proibicao mora no gateway, que e quem dispara.

  IF v_sistema THEN
    v_autor_email := 'SISTEMA'; v_autor_nome := 'SISTEMA';
  ELSE
    v_autor_email := lower(coalesce(auth.email(), ''));
    v_autor_nome  := coalesce(nullif(auth.jwt() ->> 'name',''), v_autor_email);
  END IF;

  SELECT COALESCE(array_agg(DISTINCT cid), '{}') INTO v_conf_ids
  FROM (
    SELECT s.aluno_id::text AS cid
      FROM public.solicitacoes_confirmacao_pagamento s
     WHERE s.status IN ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
       AND s.aluno_id = ANY(COALESCE(p_aluno_ids, '{}'::text[]))
    UNION
    SELECT a.id::text
      FROM public.alunos a
     WHERE a.id = ANY(COALESCE(p_aluno_ids, '{}'::text[])::uuid[])
       AND public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
  ) u;

  -- Revalida contra o Prime na hora de gravar: quem ja consta liquidado la
  -- nao recebe cobranca em massa (Amanda, 08/09). Nada e gravado para ele.
  SELECT COALESCE(array_agg(lp.aluno_id::text), '{}') INTO v_liq_ids
    FROM public.acoes_massivas_liquidados_prime(COALESCE(p_aluno_ids, '{}'::text[])::uuid[]) lp;

  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
    IF v_id = ANY(v_liq_ids) THEN
      v_excluidos_liq := v_excluidos_liq + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Já consta liquidado no Prime');
      CONTINUE;
    END IF;
    IF v_id = ANY(v_conf_ids) THEN
      v_excluidos_conf := v_excluidos_conf + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Aguardando confirmação financeira');
      CONTINUE;
    END IF;

    UPDATE public.alunos
       SET data_retorno = v_retorno,
           retorno_origem = 'AUTOMATICO',
           status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           -- Acao massiva CONTA como acionamento: alcancar o aluno e alcancar o
           -- aluno, por operador ou por planilha.
           data_ultimo_acionamento = v_agora
     WHERE id = v_id::uuid
       -- Sem dono, OU com dono e nunca acionado. Ter dono nao quer dizer que
       -- alguem trabalhou o caso.
       -- Com operador escolhido o recorte e o da previa: o aluno tem de
       -- continuar na carteira DELE agora. Nada aqui troca o responsavel.
       AND ((v_operador IS NULL AND (responsavel_atual_email IS NULL OR data_ultimo_acionamento IS NULL))
            OR (v_operador IS NOT NULL AND responsavel_atual_email = v_operador));

    IF FOUND THEN
      INSERT INTO public.aluno_movimentacoes
        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
      VALUES (v_id, v_tipo,
        'Ação de estímulo enviada por fora do CRM via '
          || CASE WHEN p_canal = 'WHATSAPP' THEN 'WhatsApp' ELSE 'e-mail' END
          || ' (planilha ' || COALESCE(p_arquivo, '-')
          || '). Retorno agendado para ' || to_char(v_retorno, 'DD/MM/YYYY') || '.',
        v_autor_nome, v_autor_email, v_agora);
      v_mov := v_mov + 1; v_registrados := v_registrados || v_id;
    ELSIF v_operador IS NOT NULL THEN
      v_excluidos_operador := v_excluidos_operador + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Não está mais na carteira do operador selecionado, ou inexistente');
    ELSE
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso já acionado por operador, ou inexistente');
    END IF;
  END LOOP;

  v_contatos := COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
    FROM public.alunos a WHERE a.id = ANY(v_registrados::uuid[])), '[]'::jsonb);

  RETURN jsonb_build_object(
    'registrados', COALESCE(array_length(v_registrados, 1), 0),
    'ids_registrados', to_jsonb(v_registrados),
    'excluidos_confirmacao', v_excluidos_conf,
    'excluidos_liquidados_prime', v_excluidos_liq,
    'excluidos_outro_operador', v_excluidos_operador,
    'operador_email', v_operador,
    'movimentacoes_criadas', v_mov,
    'autor_email', v_autor_email,
    'executado_por', CASE WHEN v_sistema THEN 'SISTEMA' ELSE 'USUARIO' END,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
END;
$function$;

comment on function public.registrar_acao_massiva(text[],text,text,text,text,text) is
  'Registra que uma acao de estimulo foi enviada POR FORA do CRM (planilha) e agenda o retorno de 10 dias. NAO dispara nada: nao enfileira mensagem, nao chama o gateway. Disparar em massa pelo nosso numero segue proibido no gateway, que e quem dispara -- aqui o canal WHATSAPP significa apenas que o contato usado foi telefone.';

CREATE OR REPLACE FUNCTION public.acoes_massivas_exportar(p_aluno_ids text[], p_canal text, p_arquivo text DEFAULT NULL::text, p_operador_email text DEFAULT NULL::text, p_tipo_cobranca text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_canal text := upper(btrim(coalesce(p_canal, '')));
  v_operador text := lower(nullif(btrim(p_operador_email), ''));
  v_tipo text := coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), 'REGRA_ANTERIOR');
  v_tipo_ids text[] := '{}';
  v_exc_tipo int := 0;
  v_ids text[] := coalesce(p_aluno_ids, '{}'::text[]);
  v_autor text;
  v_conf_ids text[];
  v_liq_ids text[];
  v_ok text[] := '{}';
  v_excluidos jsonb := '[]'::jsonb;
  v_exc_conf int := 0; v_exc_liq int := 0; v_exc_operador int := 0; v_exc_acionado int := 0;
  v_id text;
  v_lote uuid;
  v_contatos jsonb;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: exportar acao massiva restrito a gestao.' using errcode = '42501';
  end if;
  if v_canal not in ('WHATSAPP', 'EMAIL') then
    raise exception 'Canal invalido: %', p_canal using errcode = '22023';
  end if;
  if nullif(btrim(p_tipo_cobranca), '') is not null
     and v_tipo not in ('MENSALIDADES', 'ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS') then
    raise exception 'Tipo de cobranca invalido: %', p_tipo_cobranca using errcode = '22023';
  end if;
  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;

  -- Tipo de cobranca: a mesma regra da previa, conferida agora.
  if v_tipo <> 'REGRA_ANTERIOR' then
    select coalesce(array_agg(tc.aluno_id::text), '{}') into v_tipo_ids
      from public.acoes_massivas_tipo_cobranca_alunos(v_ids::uuid[]) tc
     where public.acoes_massivas_tipo_cobranca_corresponde(v_tipo, tc.tem_mensalidade, tc.tem_acordo_vencido);
  end if;

  -- As mesmas revalidacoes de registrar_acao_massiva, na mesma ordem. A planilha
  -- sai com exatamente quem a confirmacao registraria agora.
  select coalesce(array_agg(distinct cid), '{}') into v_conf_ids
  from (
    select s.aluno_id::text as cid
      from public.solicitacoes_confirmacao_pagamento s
     where s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
       and s.aluno_id = any(v_ids)
    union
    select a.id::text
      from public.alunos a
     where a.id = any(v_ids::uuid[])
       and public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
  ) u;

  select coalesce(array_agg(lp.aluno_id::text), '{}') into v_liq_ids
    from public.acoes_massivas_liquidados_prime(v_ids::uuid[]) lp;

  foreach v_id in array v_ids loop
    if v_id = any(v_ok) then
      continue;
    end if;
    if v_id = any(v_liq_ids) then
      v_exc_liq := v_exc_liq + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Já consta liquidado no Prime');
      continue;
    end if;
    if v_id = any(v_conf_ids) then
      v_exc_conf := v_exc_conf + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Aguardando confirmação financeira');
      continue;
    end if;

    if v_tipo <> 'REGRA_ANTERIOR' and not (v_id = any(v_tipo_ids)) then
      v_exc_tipo := v_exc_tipo + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Não corresponde ao tipo de cobrança selecionado');
      continue;
    end if;

    if exists (
      select 1 from public.alunos a
       where a.id = v_id::uuid
         and ((v_operador is null and (a.responsavel_atual_email is null or a.data_ultimo_acionamento is null))
              or (v_operador is not null and a.responsavel_atual_email = v_operador))) then
      v_ok := v_ok || v_id;
    elsif v_operador is not null then
      v_exc_operador := v_exc_operador + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Não está mais na carteira do operador selecionado, ou inexistente');
    else
      v_exc_acionado := v_exc_acionado + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso já acionado por operador, ou inexistente');
    end if;
  end loop;

  -- Unica escrita: o lote de auditoria. Nada em alunos, casos ou movimentacoes.
  if coalesce(array_length(v_ok, 1), 0) > 0 then
    insert into public.acoes_massivas_lotes
      (canal, operador_email, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca)
    values (v_canal, v_operador, p_arquivo, v_ok, array_length(v_ok, 1), v_autor, v_tipo)
    returning id into v_lote;
  end if;

  v_contatos := coalesce((
    select jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
    from public.alunos a where a.id = any(v_ok::uuid[])), '[]'::jsonb);

  return jsonb_build_object(
    'lote_id', v_lote,
    'exportados', coalesce(array_length(v_ok, 1), 0),
    'ids_exportados', to_jsonb(v_ok),
    'excluidos_confirmacao', v_exc_conf,
    'excluidos_liquidados_prime', v_exc_liq,
    'excluidos_outro_operador', v_exc_operador,
    'excluidos_ja_acionados', v_exc_acionado,
    'excluidos_tipo_cobranca', v_exc_tipo,
    'tipo_cobranca', v_tipo,
    'operador_email', v_operador,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
end;
$function$;

CREATE OR REPLACE FUNCTION public.acoes_massivas_concluir_lote(p_lote_id uuid, p_acao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_acao text := upper(btrim(coalesce(p_acao, '')));
  v_autor text;
  v_lote public.acoes_massivas_lotes%rowtype;
  v_depois text[];
  v_ids text[];
  v_reg jsonb;
  v_tipo_ids text[] := '{}';
  v_fora_tipo text[] := '{}';
  v_res jsonb;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: concluir acao massiva restrito a gestao.' using errcode = '42501';
  end if;
  if v_acao not in ('CONFIRMAR', 'DESCARTAR') then
    raise exception 'Acao invalida: % (use CONFIRMAR ou DESCARTAR)', p_acao using errcode = '22023';
  end if;
  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;

  select * into v_lote from public.acoes_massivas_lotes where id = p_lote_id for update;
  if not found then
    raise exception 'Lote de exportacao nao encontrado.' using errcode = 'P0002';
  end if;
  if v_lote.confirmado_em is not null then
    raise exception 'Este lote ja foi confirmado em %.', to_char(v_lote.confirmado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
      using errcode = '55000';
  end if;
  if v_lote.descartado_em is not null then
    raise exception 'Este lote foi descartado em % e nao pode ser confirmado.', to_char(v_lote.descartado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
      using errcode = '55000';
  end if;

  if v_acao = 'DESCARTAR' then
    update public.acoes_massivas_lotes
       set descartado_em = now(), descartado_por_email = v_autor
     where id = v_lote.id;
    return jsonb_build_object('lote_id', v_lote.id, 'descartado', true, 'registrados', 0);
  end if;

  -- Acionado depois da exportacao: o contato mais novo manda, a campanha nao
  -- sobrescreve. Fica de fora e e contado.
  select coalesce(array_agg(x.id_txt order by x.ord), '{}') into v_depois
    from unnest(v_lote.aluno_ids) with ordinality as x(id_txt, ord)
    join public.alunos a on a.id = x.id_txt::uuid
   where a.data_ultimo_acionamento > v_lote.exportado_em;

  v_ids := array(
    select x.id_txt from unnest(v_lote.aluno_ids) with ordinality as x(id_txt, ord)
     where not (x.id_txt = any(v_depois))
     order by x.ord);

  -- O registro de sempre: revalida confirmacao, Prime e recorte, e so entao
  -- grava tabulacao, retorno, acionamento e movimentacao.
  -- Tipo de cobranca do lote, REVALIDADO agora no banco: quem nao corresponde
  -- mais (pagou a mensalidade, acertou a parcela, ficou com acordo em dia) sai.
  if v_lote.tipo_cobranca <> 'REGRA_ANTERIOR' then
    select coalesce(array_agg(tc.aluno_id::text), '{}') into v_tipo_ids
      from public.acoes_massivas_tipo_cobranca_alunos(v_ids::uuid[]) tc
     where public.acoes_massivas_tipo_cobranca_corresponde(v_lote.tipo_cobranca, tc.tem_mensalidade, tc.tem_acordo_vencido);
    v_fora_tipo := array(select x from unnest(v_ids) with ordinality as u(x, o)
                          where not (x = any(v_tipo_ids)) order by o);
    v_ids := array(select x from unnest(v_ids) with ordinality as u(x, o)
                    where x = any(v_tipo_ids) order by o);
  end if;

  v_reg := public.registrar_acao_massiva(v_ids, v_lote.canal, v_lote.arquivo, null, null, v_lote.operador_email);

  v_res := (v_reg - 'contatos') || jsonb_build_object(
    'lote_id', v_lote.id,
    'excluidos_acionados_apos_exportacao', coalesce(array_length(v_depois, 1), 0),
    'tipo_cobranca', v_lote.tipo_cobranca,
    'excluidos_tipo_cobranca', coalesce(array_length(v_fora_tipo, 1), 0),
    'ids_fora_do_tipo_cobranca', to_jsonb(v_fora_tipo),
    'ids_acionados_apos_exportacao', to_jsonb(v_depois));

  update public.acoes_massivas_lotes
     set confirmado_em = now(), confirmado_por_email = v_autor, resultado = v_res
   where id = v_lote.id;

  return v_res;
end;
$function$;

revoke all on function public.registrar_acao_massiva(text[],text,text,text,text,text) from public, anon;
grant execute on function public.registrar_acao_massiva(text[],text,text,text,text,text) to authenticated, service_role;
revoke all on function public.acoes_massivas_exportar(text[],text,text,text,text) from public, anon;
grant execute on function public.acoes_massivas_exportar(text[],text,text,text,text) to authenticated, service_role;
