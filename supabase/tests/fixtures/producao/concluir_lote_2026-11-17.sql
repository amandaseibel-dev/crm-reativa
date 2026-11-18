CREATE OR REPLACE FUNCTION public.acoes_massivas_concluir_lote(p_lote_id uuid, p_acao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
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
  v_res jsonb;
  v_op text;
  v_filtros jsonb;
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
  if v_lote.descartado_em is not null then
    raise exception 'Este lote foi descartado em % e nao pode ser concluido.', to_char(v_lote.descartado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
      using errcode = '55000';
  end if;

  if v_lote.confirmado_em is not null then
    if v_acao = 'DESCARTAR' then
      raise exception 'Este lote ja foi registrado em % e nao pode ser descartado.', to_char(v_lote.confirmado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
        using errcode = '55000';
    end if;
    return coalesce(v_lote.resultado, '{}'::jsonb) || jsonb_build_object(
      'lote_id', v_lote.id,
      'ja_registrado', true,
      'registrados', coalesce(v_lote.registrados,
                              (select count(*)::int from public.aluno_movimentacoes m where m.lote_id = v_lote.id)),
      'movimentacoes_criadas', 0);
  end if;

  if v_acao = 'DESCARTAR' then
    update public.acoes_massivas_lotes
       set descartado_em = now(), descartado_por_email = v_autor
     where id = v_lote.id;
    return jsonb_build_object('lote_id', v_lote.id, 'descartado', true, 'registrados', 0);
  end if;

  select coalesce(array_agg(x.id_txt order by x.ord), '{}') into v_depois
    from unnest(v_lote.aluno_ids) with ordinality as x(id_txt, ord)
    join public.alunos a on a.id = x.id_txt::uuid
   where a.data_ultimo_acionamento > v_lote.exportado_em;

  v_ids := array(
    select x.id_txt from unnest(v_lote.aluno_ids) with ordinality as x(id_txt, ord)
     where not (x.id_txt = any(v_depois))
     order by x.ord);

  v_op := coalesce(lower(nullif(btrim(v_lote.filtros ->> 'operador'), '')),
                   lower(nullif(btrim(v_lote.operador_email), '')), 'livres');
  v_filtros := coalesce(v_lote.filtros, '{}'::jsonb)
               || jsonb_build_object(
                    'tipo_cobranca',
                    case when coalesce(v_lote.tipo_cobranca, 'REGRA_ANTERIOR') = 'REGRA_ANTERIOR'
                         then 'MENSALIDADES_E_ACORDOS' else v_lote.tipo_cobranca end);

  v_reg := public.registrar_acao_massiva(v_ids, v_lote.canal, v_lote.arquivo, null, null, v_op,
                                         v_lote.id, v_filtros);

  v_res := (v_reg - 'contatos') || jsonb_build_object(
    'lote_id', v_lote.id,
    'excluidos_acionados_apos_exportacao', coalesce(array_length(v_depois, 1), 0),
    'tipo_cobranca', v_lote.tipo_cobranca,
    'excluidos_tipo_cobranca', coalesce((v_reg #>> '{excluidos_por_motivo,fora_tipo_cobranca}')::int, 0),
    'ids_acionados_apos_exportacao', to_jsonb(v_depois));

  update public.acoes_massivas_lotes
     set confirmado_em = now(), confirmado_por_email = v_autor, resultado = v_res,
         registrados = coalesce((v_reg ->> 'registrados')::int, 0)
   where id = v_lote.id;

  return v_res;
end;
$function$
