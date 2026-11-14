CREATE OR REPLACE FUNCTION public.acoes_massivas_fidelizacao_protege(p_dua timestamp with time zone, p_agora timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT p_dua IS NOT NULL
     AND (p_dua AT TIME ZONE 'America/Sao_Paulo')::date + 10 >= (p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_acao_massiva(p_aluno_ids text[], p_canal text, p_arquivo text, p_registrado_por_nome text, p_registrado_por_email text, p_operador_email text DEFAULT NULL::text, p_lote_id uuid DEFAULT NULL::uuid, p_filtros jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_agora timestamptz := now();
  v_canal text := upper(btrim(coalesce(p_canal, '')));
  v_tipo text := case when upper(btrim(coalesce(p_canal, ''))) = 'WHATSAPP'
                      then 'ACAO_MASSIVA_EXTERNA' else 'ACAO_MASSIVA_EXTERNA_EMAIL' end;
  v_ids text[] := coalesce(p_aluno_ids, '{}'::text[]);
  v_autor_email text;
  v_autor_nome text;
  v_op text;
  v_f jsonb;
  v_mapa jsonb;
  v_id text;
  v_m jsonb;
  v_vistos text[] := '{}';
  v_registrados text[] := '{}';
  v_excluidos jsonb := '[]'::jsonb;
  v_motivos jsonb := '{}'::jsonb;
  v_mov int := 0;
  v_ja int := 0;
  v_linhas int;
  v_desc text;
  v_contatos jsonb;
  v_mot text;
  v_tab int := 0;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.' using errcode = '42501';
  end if;

  if v_sistema then
    v_autor_email := 'SISTEMA'; v_autor_nome := 'SISTEMA';
  else
    v_autor_email := lower(coalesce(auth.email(), ''));
    v_autor_nome  := coalesce(nullif(auth.jwt() ->> 'name', ''), v_autor_email);
  end if;

  v_op := coalesce(lower(nullif(btrim(p_operador_email), '')),
                   lower(nullif(btrim(p_filtros ->> 'operador'), '')),
                   'livres');

  v_f := coalesce(p_filtros, '{}'::jsonb)
         || jsonb_build_object('operador', v_op,
                               'canal', case when v_canal in ('WHATSAPP', 'EMAIL') then v_canal else null end,
                               'aluno_ids', to_jsonb(v_ids));
  if coalesce(v_f ->> 'tipo_cobranca', 'REGRA_ANTERIOR') = 'REGRA_ANTERIOR' then
    v_f := v_f || jsonb_build_object('tipo_cobranca', 'MENSALIDADES_E_ACORDOS');
  end if;

  select coalesce(jsonb_object_agg(u.aluno_id::text,
                                   jsonb_build_object('d', u.disponivel, 'm', u.motivo)), '{}'::jsonb)
    into v_mapa
    from public.acoes_massivas_universo(v_f) u;

  v_desc := 'Ação massiva registrada via '
            || case when v_canal = 'WHATSAPP' then 'WhatsApp' else 'e-mail' end
            || ' (planilha ' || coalesce(p_arquivo, '-') || ').';

  foreach v_id in array v_ids loop
    if v_id = any(v_vistos) then
      continue;
    end if;
    v_vistos := v_vistos || v_id;
    v_m := v_mapa -> v_id;

    if v_m is null then
      v_mot := 'fora_do_universo';
    elsif (v_m ->> 'd')::boolean then
      v_mot := null;
    else
      v_mot := v_m ->> 'm';
    end if;

    if v_mot is not null then
      v_excluidos := v_excluidos || jsonb_build_object(
        'aluno_id', v_id, 'motivo_codigo', v_mot,
        'motivo', case when v_mot = 'fora_do_universo'
                       then 'Sem dívida ativa nos critérios, ou inexistente'
                       else public.acoes_massivas_motivo_texto(v_mot) end);
      v_motivos := jsonb_set(v_motivos, array[v_mot], to_jsonb(coalesce((v_motivos ->> v_mot)::int, 0) + 1));
      continue;
    end if;

    if p_lote_id is null then
      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, lote_id)
      values (v_id, v_tipo, v_desc, v_autor_nome, v_autor_email, v_agora, null);
      v_linhas := 1;
    else
      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, lote_id)
      values (v_id, v_tipo, v_desc, v_autor_nome, v_autor_email, v_agora, p_lote_id)
      on conflict (lote_id, aluno_id) where lote_id is not null do nothing;
      get diagnostics v_linhas = row_count;
    end if;

    if v_linhas > 0 then
      v_mov := v_mov + 1;
      v_registrados := v_registrados || v_id;
    else
      v_ja := v_ja + 1;
    end if;
  end loop;

  -- TABULACAO DA ACAO MASSIVA (gestao, 19/10/2026): "coloque 10 dias, ja esta
  -- padronizado nessa forma". Mesma forma de sempre -- status com o prefixo
  -- 'Ação massiva' e retorno +10 dias CORRIDOS -- que e exatamente a regra que
  -- recalcular_situacao_aluno aplica (prefixo + (hoje - dua) < 10 => dua + 10).
  -- Escrito aqui, e nao reabrindo a recalculadora no gatilho (ver 20261003083400):
  -- ela tambem reescreve situacao, criticidade e proxima acao, e e compartilhada.
  -- NAO toca status_jornada/status_atual: trg_tabulacao_efeito_financeiro e
  -- trg_tabulacao_redireciona so disparam quando status_jornada muda, e acao
  -- massiva nao pode gerar efeito financeiro nem encaminhamento.
  if coalesce(array_length(v_registrados, 1), 0) > 0 then
    update public.alunos a
       set status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_retorno = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.data_retorno
             else current_date + 10 end,
           retorno_origem = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.retorno_origem
             else 'AUTOMATICO' end
     where a.id = any(v_registrados::uuid[]);
    get diagnostics v_tab = row_count;

    -- O caso acompanha o aluno: fn_sync_acionamento_alunos_para_casos
    -- sincroniza SO data_ultimo_acionamento. casos nao tem retorno_origem,
    -- entao espelha a data que ficou no aluno (igual a recalculadora faz).
    update public.casos c
       set data_retorno = a.data_retorno
      from public.alunos a
     where a.id = c.aluno_id
       and c.aluno_id = any(v_registrados::uuid[])
       and c.data_retorno is distinct from a.data_retorno;
  end if;

  v_contatos := coalesce((
    select jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
      from public.alunos a where a.id = any(v_registrados::uuid[])), '[]'::jsonb);

  return jsonb_build_object(
    'registrados', coalesce(array_length(v_registrados, 1), 0),
    'ja_registrados', v_ja,
    'tabulados', v_tab,
    'ids_registrados', to_jsonb(v_registrados),
    'excluidos_confirmacao', coalesce((v_motivos ->> 'confirmacao_pendente')::int, 0),
    'excluidos_liquidados_prime', coalesce((v_motivos ->> 'liquidado_prime')::int, 0),
    'excluidos_outro_operador', coalesce((v_motivos ->> 'outro_responsavel')::int, 0),
    'excluidos_por_motivo', v_motivos,
    'operador_email', v_op,
    'movimentacoes_criadas', v_mov,
    'autor_email', v_autor_email,
    'executado_por', case when v_sistema then 'SISTEMA' else 'USUARIO' end,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
end;
$function$;

CREATE OR REPLACE FUNCTION public.acoes_massivas_exportar_emails_do_lote(p_lote_id uuid, p_arquivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_agora timestamptz := now();
  v_autor_email text;
  v_autor_nome text;
  v_origem public.acoes_massivas_lotes%rowtype;
  v_derivado uuid;
  v_derivado_em timestamptz;
  v_ids text[];
  v_ok text[] := '{}';
  v_contatos jsonb := '[]'::jsonb;
  v_excluidos jsonb := '[]'::jsonb;
  v_sem int;
  v_confere int;
  v_arquivo text;
  v_lote uuid;
  v_desc text;
  v_reg int := 0;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: exportar acao massiva restrito a gestao.' using errcode = '42501';
  end if;
  if p_lote_id is null then
    raise exception 'Informe o lote de WhatsApp de origem.' using errcode = '22023';
  end if;

  if v_sistema then
    v_autor_email := 'SISTEMA'; v_autor_nome := 'SISTEMA';
  else
    v_autor_email := lower(coalesce(auth.email(), ''));
    v_autor_nome  := coalesce(nullif(auth.jwt() ->> 'name', ''), v_autor_email);
  end if;

  -- Serializa duas chamadas simultaneas para o mesmo lote sem escrever na linha
  -- de origem (um `for update` ali tambem serviria, mas tocaria o lote antigo).
  perform pg_advisory_xact_lock(hashtextextended(p_lote_id::text, 0));

  select * into v_origem from public.acoes_massivas_lotes where id = p_lote_id;
  if not found then
    raise exception 'Lote de exportacao nao encontrado.' using errcode = 'P0002';
  end if;
  if v_origem.canal <> 'WHATSAPP' then
    raise exception 'O lote % e do canal %: esta exportacao parte de um lote de WhatsApp.', p_lote_id, v_origem.canal
      using errcode = '22023';
  end if;
  if v_origem.descartado_em is not null then
    raise exception 'Este lote de WhatsApp foi descartado em % e nao gera acao de e-mail.',
      to_char(v_origem.descartado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
      using errcode = '55000';
  end if;

  select o.id, o.exportado_em into v_derivado, v_derivado_em
    from public.acoes_massivas_lotes o
   where o.lote_origem_id = v_origem.id
     and o.canal = 'EMAIL'
     and o.descartado_em is null
   order by o.exportado_em desc
   limit 1;
  if v_derivado is not null then
    raise exception 'Este lote de WhatsApp ja gerou a acao de e-mail % em %.',
      v_derivado, to_char(v_derivado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
      using errcode = '55000';
  end if;

  -- Os aluno_ids GRAVADOS no lote, na ordem em que foram exportados, sem
  -- repeticao. Nenhuma outra fonte entra aqui.
  select coalesce(array_agg(x.id_txt order by x.ord), '{}') into v_ids
    from (select distinct on (t.id_txt) t.id_txt, t.ord
            from unnest(v_origem.aluno_ids) with ordinality as t(id_txt, ord)
           order by t.id_txt, t.ord) x;

  -- Unico corte: e-mail valido. Quem nao tem (inclusive ficha inexistente) sai
  -- com motivo. Nome e e-mail vem daqui -- a planilha nao busca em outro lugar.
  select coalesce(array_agg(d.aluno_id order by d.ord) filter (where d.tem_email), '{}'),
         coalesce(jsonb_agg(jsonb_build_object(
                    'aluno_id', d.aluno_id, 'nome', d.nome, 'email', d.email)
                  order by d.ord) filter (where d.tem_email), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object(
                    'aluno_id', d.aluno_id, 'motivo_codigo', case when d.fid then 'fidelizacao_ativa' else 'sem_email_valido' end,
                    'motivo', case when d.fid then 'Protegido pela fidelização até o 10º dia' else 'Sem e-mail válido no cadastro' end)
                  order by d.ord) filter (where not d.tem_email), '[]'::jsonb)
    into v_ok, v_contatos, v_excluidos
    from (select x.id_txt as aluno_id, x.ord, a.nome, btrim(a.email) as email,
                 (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento)) as fid,
                 (public.email_valido_para_acao_massiva(a.email) and not (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento))) as tem_email
            from unnest(v_ids) with ordinality as x(id_txt, ord)
            left join public.alunos a on a.id = x.id_txt::uuid) d;

  v_sem := jsonb_array_length(v_excluidos);

  -- VALIDACAO ANTES DE GRAVAR. Reconta por outro caminho (join direto, sem a
  -- montagem acima) e exige: exportados = alunos do lote com e-mail valido, e
  -- exportados + sem e-mail = alunos do lote. Divergencia nao grava nada.
  select count(*)::int into v_confere
    from unnest(v_ids) as x(id_txt)
    join public.alunos a on a.id = x.id_txt::uuid
   where public.email_valido_para_acao_massiva(a.email)
     and not (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento));

  if coalesce(array_length(v_ok, 1), 0) <> v_confere then
    raise exception 'Conferencia falhou: % selecionados contra % alunos do lote com e-mail valido. Nada foi gravado.',
      coalesce(array_length(v_ok, 1), 0), v_confere using errcode = '55000';
  end if;
  if coalesce(array_length(v_ok, 1), 0) + v_sem <> coalesce(array_length(v_ids, 1), 0) then
    raise exception 'Conferencia falhou: % com e-mail + % sem e-mail nao fecham os % alunos do lote. Nada foi gravado.',
      coalesce(array_length(v_ok, 1), 0), v_sem, coalesce(array_length(v_ids, 1), 0) using errcode = '55000';
  end if;

  if coalesce(array_length(v_ok, 1), 0) = 0 then
    return jsonb_build_object(
      'lote_id', null,
      'lote_origem_id', v_origem.id,
      'arquivo_origem', v_origem.arquivo,
      'total_lote_whatsapp', coalesce(array_length(v_ids, 1), 0),
      'com_email', 0,
      'sem_email', v_sem,
      'registrados', 0,
      'contatos', '[]'::jsonb,
      'ids_excluidos', v_excluidos);
  end if;

  v_arquivo := coalesce(nullif(btrim(p_arquivo), ''),
                        'acao-massiva-email-do-lote-whatsapp-'
                        || to_char(v_agora at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') || '.xlsx');

  insert into public.acoes_massivas_lotes
    (canal, operador_email, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca,
     filtros, solicitado, encontrado, selecionado, resumo_exclusoes, recencia_dias, lote_origem_id)
  values ('EMAIL', v_origem.operador_email, v_arquivo, v_ok, array_length(v_ok, 1), v_autor_email,
          v_origem.tipo_cobranca,
          jsonb_build_object(
            'origem', 'LOTE_WHATSAPP',
            'lote_origem_id', v_origem.id,
            'arquivo_origem', v_origem.arquivo,
            'canal', 'EMAIL',
            'tipo_cobranca', v_origem.tipo_cobranca,
            'criterio', 'aluno_ids gravados no lote de WhatsApp; exclui somente quem nao tem e-mail valido'),
          coalesce(array_length(v_ids, 1), 0), v_confere, array_length(v_ok, 1),
          jsonb_build_object('sem_email_valido', v_sem),
          v_origem.recencia_dias, v_origem.id)
  returning id into v_lote;

  v_desc := 'Ação massiva registrada via e-mail (planilha ' || v_arquivo
            || '), derivada do lote de WhatsApp '
            || coalesce(v_origem.arquivo, v_origem.id::text) || '.';

  -- Unico efeito nos alunos: a movimentacao individual deste lote novo.
  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, lote_id)
  select x.id_txt, 'ACAO_MASSIVA_EXTERNA_EMAIL', v_desc, v_autor_nome, v_autor_email, v_agora, v_lote
    from unnest(v_ok) as x(id_txt)
  on conflict (lote_id, aluno_id) where lote_id is not null do nothing;
  get diagnostics v_reg = row_count;

  -- TABULACAO (gestao, 19/10/2026): identica a de registrar_acao_massiva.
  -- v_ok sao os alunos com e-mail valido deste lote novo; o lote nasce agora,
  -- entao o on conflict acima nao descarta ninguem.
  if coalesce(array_length(v_ok, 1), 0) > 0 then
    update public.alunos a
       set status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_retorno = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.data_retorno
             else current_date + 10 end,
           retorno_origem = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.retorno_origem
             else 'AUTOMATICO' end
     where a.id = any(v_ok::uuid[]);

    update public.casos c
       set data_retorno = a.data_retorno
      from public.alunos a
     where a.id = c.aluno_id
       and c.aluno_id = any(v_ok::uuid[])
       and c.data_retorno is distinct from a.data_retorno;
  end if;

  -- Fecha SO o lote novo. O lote de WhatsApp de origem nao e tocado.
  update public.acoes_massivas_lotes
     set confirmado_em        = v_agora,
         confirmado_por_email = v_autor_email,
         registrados          = v_reg,
         registro_automatico  = true,
         resultado            = jsonb_build_object(
                                  'lote_id', v_lote,
                                  'lote_origem_id', v_origem.id,
                                  'registrados', v_reg,
                                  'com_email', array_length(v_ok, 1),
                                  'sem_email_valido', v_sem)
   where id = v_lote;

  return jsonb_build_object(
    'lote_id', v_lote,
    'lote_origem_id', v_origem.id,
    'arquivo', v_arquivo,
    'arquivo_origem', v_origem.arquivo,
    'total_lote_whatsapp', coalesce(array_length(v_ids, 1), 0),
    'com_email', array_length(v_ok, 1),
    'sem_email', v_sem,
    'registrados', v_reg,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
end;
$function$;
