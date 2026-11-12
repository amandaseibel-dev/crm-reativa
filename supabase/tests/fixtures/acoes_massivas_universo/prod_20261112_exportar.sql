CREATE OR REPLACE FUNCTION public.acoes_massivas_exportar(p_aluno_ids text[], p_canal text, p_arquivo text DEFAULT NULL::text, p_operador_email text DEFAULT NULL::text, p_tipo_cobranca text DEFAULT NULL::text, p_previa_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_canal text := upper(btrim(coalesce(p_canal, '')));
  v_ids text[] := coalesce(p_aluno_ids, '{}'::text[]);
  v_autor text;
  v_pf jsonb := '{}'::jsonb;
  v_solic int; v_enc int;
  v_f jsonb;
  v_op text;
  v_tipo text;
  v_mapa jsonb;
  v_id text;
  v_m jsonb;
  v_mot text;
  v_vistos text[] := '{}';
  v_ok text[] := '{}';
  v_excluidos jsonb := '[]'::jsonb;
  v_motivos jsonb := '{}'::jsonb;
  v_lote uuid;
  v_reg jsonb := '{}'::jsonb;
  v_contatos jsonb;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: exportar acao massiva restrito a gestao.' using errcode = '42501';
  end if;
  if v_canal not in ('WHATSAPP', 'EMAIL') then
    raise exception 'Canal invalido: %', p_canal using errcode = '22023';
  end if;
  if nullif(btrim(p_tipo_cobranca), '') is not null
     and upper(btrim(p_tipo_cobranca)) not in ('MENSALIDADES', 'ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS') then
    raise exception 'Tipo de cobranca invalido: %', p_tipo_cobranca using errcode = '22023';
  end if;
  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;

  if p_previa_id is not null then
    select p.filtros, p.solicitado, p.elegiveis into v_pf, v_solic, v_enc
      from public.acoes_massivas_previas p where p.id = p_previa_id;
    if not found then
      raise exception 'Previa % nao encontrada.', p_previa_id using errcode = 'P0002';
    end if;
  end if;

  v_op := coalesce(lower(nullif(btrim(p_operador_email), '')),
                   lower(nullif(btrim(v_pf ->> 'operador'), '')), 'livres');
  v_tipo := coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), v_pf ->> 'tipo_cobranca', 'MENSALIDADES_E_ACORDOS');

  v_f := v_pf || jsonb_build_object('operador', v_op, 'tipo_cobranca', v_tipo,
                                    'canal', v_canal, 'aluno_ids', to_jsonb(v_ids));
  select coalesce(jsonb_object_agg(u.aluno_id::text,
                                   jsonb_build_object('d', u.disponivel, 'm', u.motivo)), '{}'::jsonb)
    into v_mapa
    from public.acoes_massivas_universo(v_f) u;

  foreach v_id in array v_ids loop
    if v_id = any(v_vistos) then
      continue;
    end if;
    v_vistos := v_vistos || v_id;
    v_m := v_mapa -> v_id;
    if v_m is null then
      v_mot := 'fora_do_universo';
    elsif (v_m ->> 'd')::boolean then
      v_ok := v_ok || v_id;
      continue;
    else
      v_mot := v_m ->> 'm';
    end if;
    v_excluidos := v_excluidos || jsonb_build_object(
      'aluno_id', v_id, 'motivo_codigo', v_mot,
      'motivo', case when v_mot = 'fora_do_universo'
                     then 'Sem dívida ativa nos critérios, ou inexistente'
                     else public.acoes_massivas_motivo_texto(v_mot) end);
    v_motivos := jsonb_set(v_motivos, array[v_mot], to_jsonb(coalesce((v_motivos ->> v_mot)::int, 0) + 1));
  end loop;

  if coalesce(array_length(v_ok, 1), 0) > 0 then
    insert into public.acoes_massivas_lotes
      (canal, operador_email, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca,
       filtros, solicitado, encontrado, selecionado, previa_id, resumo_exclusoes, recencia_dias)
    values (v_canal,
            case when v_op in ('todos', 'livres') then null else v_op end,
            p_arquivo, v_ok, array_length(v_ok, 1), v_autor, v_tipo,
            v_f - 'aluno_ids', v_solic, v_enc, array_length(v_ok, 1), p_previa_id, v_motivos,
            coalesce(nullif(v_f ->> 'recencia_dias', '')::int, 10))
    returning id into v_lote;

    v_reg := public.registrar_acao_massiva(v_ok, v_canal, p_arquivo, null, null, v_op, v_lote, v_f);

    update public.acoes_massivas_lotes
       set confirmado_em       = now(),
           confirmado_por_email = v_autor,
           registrados         = coalesce((v_reg ->> 'registrados')::int, 0),
           registro_automatico = true,
           resultado           = (v_reg - 'contatos') || jsonb_build_object('lote_id', v_lote)
     where id = v_lote;
  end if;

  v_contatos := coalesce((
    select jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
    from public.alunos a where a.id = any(v_ok::uuid[])), '[]'::jsonb);

  return jsonb_build_object(
    'lote_id', v_lote,
    'exportados', coalesce(array_length(v_ok, 1), 0),
    'selecionados', coalesce(array_length(v_ok, 1), 0),
    'registrados', coalesce((v_reg ->> 'registrados')::int, 0),
    'ja_registrados', coalesce((v_reg ->> 'ja_registrados')::int, 0),
    'registro_automatico', v_lote is not null,
    'enviados', null,
    'falhas_envio', null,
    'ids_exportados', to_jsonb(v_ok),
    'ids_registrados', coalesce(v_reg -> 'ids_registrados', '[]'::jsonb),
    'excluidos_confirmacao', coalesce((v_motivos ->> 'confirmacao_pendente')::int, 0),
    'excluidos_liquidados_prime', coalesce((v_motivos ->> 'liquidado_prime')::int, 0),
    'excluidos_outro_operador', coalesce((v_motivos ->> 'outro_responsavel')::int, 0),
    'excluidos_ja_acionados', 0,
    'excluidos_tipo_cobranca', coalesce((v_motivos ->> 'fora_tipo_cobranca')::int, 0),
    'excluidos_por_motivo', v_motivos,
    'excluidos_revalidacao_registro', coalesce(v_reg -> 'excluidos_por_motivo', '{}'::jsonb),
    'tipo_cobranca', v_tipo,
    'operador_email', v_op,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
end;
$function$
