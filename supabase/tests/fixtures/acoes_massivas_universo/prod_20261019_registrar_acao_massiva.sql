-- CORPO VIVO DE PRODUCAO de public.registrar_acao_massiva, lido por
-- pg_get_functiondef em 19/10/2026. md5(prosrc) = 7de4ee7830af47a4acec47d18a824e29.
--
-- POR QUE ESTA FIXTURE EXISTE (deriva real, medida em 19/10/2026):
-- producao registrou em 15/10 tres migrations que NAO TEM ARQUIVO no
-- repositorio -- nem nesta branch nem na main:
--   20261015124500 retorno_futuro_so_bloqueia_agendamento_do_operador
--   20261015154500 data_ultimo_acionamento_do_caso_no_fuso_de_brasilia
--   20261015155000 acoes_massivas_fora_do_universo
-- Por causa delas a cadeia de migrations do repo NAO reproduz mais este corpo:
-- a cadeia da md5 703ea8928f38a1fd11e41a2c0da8afb5 (5.237 chars) e producao
-- esta em 4.846. A outra funcao que o patch de 19/10 altera
-- (acoes_massivas_exportar_emails_do_lote) continua batendo: d37ddd499e81cc5381762cd8c95f25aa.
--
-- Enquanto os arquivos nao forem reconstruidos, o teste da tabulacao parte
-- DESTE corpo, que e o que esta rodando de verdade. O md5 e conferido no
-- proprio teste: transcricao errada quebra alto, nao passa silenciosamente.
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

  v_contatos := coalesce((
    select jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
      from public.alunos a where a.id = any(v_registrados::uuid[])), '[]'::jsonb);

  return jsonb_build_object(
    'registrados', coalesce(array_length(v_registrados, 1), 0),
    'ja_registrados', v_ja,
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
$function$
