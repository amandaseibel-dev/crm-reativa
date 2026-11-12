-- ROLLBACK da migration 20261112120000 (combinada v2 + fidelizacao).
-- So restaura se as funcoes ainda tiverem o MD5 final validado; senao aborta sem tocar.
-- Restaura as definicoes PUBLICADAS (MD5 88ec923f... e 9c4c8486...), capturadas em 12/11/2026.
DO $r$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='acoes_massivas_universo') <> 'cefd206824186d4da8e6f1e35c14beb8' THEN
    RAISE EXCEPTION 'Rollback abortado: universo mudou desde a migration.';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='acoes_massivas_exportar') <> 'c9cc7498d16ca250e85c4727c8bb05bd' THEN
    RAISE EXCEPTION 'Rollback abortado: exportacao mudou desde a migration.';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='acoes_massivas_exportar_emails_do_lote') <> '00d3370a7800bd334292808e1573a57d' THEN
    RAISE EXCEPTION 'Rollback abortado: exportacao por e-mail mudou desde a migration.';
  END IF;
END $r$;
CREATE OR REPLACE FUNCTION public.acoes_massivas_universo(p_filtros jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(aluno_id uuid, anos integer[], responsavel_email text, valor numeric, ultimo_acionamento timestamp with time zone, ultimo_massivo timestamp with time zone, acionado_mes boolean, acionado_hoje boolean, nunca_acionado boolean, tem_mensalidade boolean, tem_acordo_vencido boolean, fidelizacao_ativa boolean, tem_telefone boolean, tem_email boolean, disponivel boolean, motivo text, motivo_sem_tipo text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
#variable_conflict use_column
declare
  f jsonb := coalesce(p_filtros, '{}'::jsonb);
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_hoje_ini timestamptz;
  v_mes_ini timestamptz;
  v_anos int[];
  v_unid text[];
  v_curso text := nullif(btrim(f->>'curso'), '');
  v_sit text[];
  v_matricula text := nullif(btrim(f->>'matricula'), '');
  v_imp uuid[];
  v_ids uuid[];
  v_ids_txt text[];
  v_op text := coalesce(lower(nullif(btrim(f->>'operador'), '')), 'livres');
  v_tipo text := coalesce(upper(nullif(btrim(f->>'tipo_cobranca'), '')), 'MENSALIDADES_E_ACORDOS');
  v_canal text := upper(nullif(btrim(f->>'canal'), ''));
  v_sem_tel boolean := coalesce((f->>'sem_telefone')::boolean, false);
  v_min numeric := coalesce(nullif(f->>'valor_min', '')::numeric, 0);
  v_max numeric := nullif(f->>'valor_max', '')::numeric;
  v_rec int := coalesce(nullif(f->>'recencia_dias', '')::int, 10);
  v_tipos_massivo text[];
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: universo das acoes massivas restrito a gestao.' using errcode = '42501';
  end if;
  if v_tipo not in ('MENSALIDADES', 'ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS') then
    raise exception 'Tipo de cobranca invalido: %', v_tipo using errcode = '22023';
  end if;
  if v_canal is not null and v_canal not in ('WHATSAPP', 'EMAIL') then
    raise exception 'Canal invalido: %', v_canal using errcode = '22023';
  end if;
  if v_rec < 0 or v_rec > 60 then
    raise exception 'Recencia da acao massiva deve estar entre 0 e 60 dias (recebido: %).', v_rec using errcode = '22023';
  end if;

  v_hoje_ini := v_hoje::timestamp at time zone 'America/Sao_Paulo';
  v_mes_ini  := date_trunc('month', v_hoje::timestamp) at time zone 'America/Sao_Paulo';
  v_anos := case when nullif(btrim(f->>'ano'), '') is null then null
                 else string_to_array(btrim(f->>'ano'), '|')::int[] end;
  v_unid := case when nullif(btrim(f->>'unidade'), '') is null then null
                 else string_to_array(btrim(f->>'unidade'), '|') end;
  v_sit  := case when nullif(btrim(f->>'situacao_academica'), '') is null then null
                 else string_to_array(btrim(f->>'situacao_academica'), '|') end;
  v_imp := case when jsonb_typeof(f->'importacao_ids') = 'array'
                then array(select jsonb_array_elements_text(f->'importacao_ids')::uuid) end;
  v_ids := case when jsonb_typeof(f->'aluno_ids') = 'array'
                then array(select jsonb_array_elements_text(f->'aluno_ids')::uuid) end;
  v_ids_txt := case when v_ids is null then null else array(select x::text from unnest(v_ids) x) end;
  v_tipos_massivo := case v_canal
    when 'WHATSAPP' then array['ACAO_MASSIVA_EXTERNA']
    when 'EMAIL'    then array['ACAO_MASSIVA_EXTERNA_EMAIL']
    else array['ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL'] end;

  return query
  with liq as materialized (
    select lp.aluno_id from public.acoes_massivas_liquidados_prime(v_ids) lp
  ),
  sol as materialized (
    select distinct s.aluno_id::text as id
      from public.solicitacoes_confirmacao_pagamento s
     where s.status in ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  tc as materialized (
    select t.aluno_id, t.tem_mensalidade, t.tem_acordo_vencido
      from public.acoes_massivas_tipo_cobranca_alunos(v_ids) t
  ),
  -- BASE: quem tem divida ativa; o ano e o do vencimento do titulo em aberto
  -- (ou da parcela vencida de acordo ativo).
  tit as materialized (
    select t.aluno_id, extract(year from t.vencimento)::int as ano
      from public.acordos_titulos t
     where t.aluno_id is not null
       and (v_ids is null or t.aluno_id = any(v_ids))
       and t.vencimento is not null
       and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
       and coalesce(lower(t.status), '') <> 'quitada'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
  ),
  parc as materialized (
    select a.aluno_id, extract(year from p.vencimento)::int as ano
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where a.status = 'ATIVO' and p.status = 'VENCIDA' and p.vencimento is not null
       and (v_ids is null or a.aluno_id = any(v_ids))
  ),
  pre_base as (
    select aluno_id, ano, true  as via_tit from tit
    union all
    select aluno_id, ano, false as via_tit from parc
  ),
  base as materialized (
    select x.aluno_id, array_agg(distinct x.ano order by x.ano) as anos
      from pre_base x
      left join public.casos c on c.aluno_id = x.aluno_id
     group by x.aluno_id
    having bool_or(x.via_tit)
        or coalesce(max(c.total_em_aberto), 0) > 0
  ),
  mov as materialized (
    select m.aluno_id,
           max(m.registrado_em) as ult,
           bool_or(m.registrado_em >= v_mes_ini) as mes,
           bool_or(m.registrado_em >= v_hoje_ini) as hoje,
           max(m.registrado_em) filter (where m.tipo = any(v_tipos_massivo)) as ult_mass
      from public.aluno_movimentacoes m
     where public.acoes_massivas_tipo_cobertura(m.tipo)
       and (v_ids_txt is null or m.aluno_id = any(v_ids_txt))
       and not exists (
         select 1 from public.acoes_desfazer ad
          where ad.movimentacao_id = m.id and ad.desfeito_em is not null)
     group by m.aluno_id
  ),
  pop as materialized (
    select a.id, b.anos, a.responsavel_atual_email as resp, a.data_retorno,
           a.data_ultimo_acionamento as dua, a.telefone, a.email,
           a.status_jornada, a.status_atual, a.status_acionamento, a.situacao_operacional, a.cpf
      from base b
      join public.alunos a on a.id = b.aluno_id
     where (v_anos is null or b.anos && v_anos)
       and (v_unid is null or a.unidade = any(v_unid))
       and (v_curso is null or a.curso = v_curso)
       and (v_sit is null or nullif(btrim(a.situacao_academica), '') = any(v_sit))
       and (v_matricula is null or (
         case when exists (
                select 1 from public.prime_contratos pc
                 where pc.cpf = lpad(regexp_replace(coalesce(a.cpf, ''), '\D', '', 'g'), 11, '0')
                   and pc.valid_from >= public.semestre_corrente_inicio()
                   and pc.status = 'Confirmado')
              then 'CONFIRMADA' else 'NAO_CONFIRMADA' end) = v_matricula)
       and (v_imp is null or exists (
         select 1 from public.acordos_titulos at3
          where at3.aluno_id = a.id and at3.importacao_id = any(v_imp)))
  ),
  cls as materialized (
    select p.*,
           c.v as valor_caso,
           mv.ult, mv.ult_mass,
           coalesce(mv.mes, false) as mes, coalesce(mv.hoje, false) as hoje,
           (tc.aluno_id is not null) as em_tc,
           coalesce(tc.tem_mensalidade, false) as tm,
           coalesce(tc.tem_acordo_vencido, false) as tav
      from pop p
      left join mov mv on mv.aluno_id = p.id::text
      left join tc on tc.aluno_id = p.id
      left join lateral (
        select c2.total_em_aberto as v
          from public.casos c2
         where c2.aluno_id = p.id
         order by (v_op not in ('todos', 'livres') and c2.operador_email is not distinct from v_op) desc,
                  c2.total_em_aberto desc nulls last
         limit 1
      ) c on true
  ),
  flags as (
    select k.*,
           (coalesce(k.status_jornada, '') in ('QUITADO', 'QUITADO_MANUAL')
            or coalesce(k.status_atual, '') in ('QUITADO', 'QUITADO_MANUAL')) as f_quit,
           (k.id in (select l.aluno_id from liq l)) as f_liq,
           (public.normalizar_status_acionamento(k.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
            or k.id::text in (select s.id from sol s)) as f_conf,
           (k.em_tc and public.acoes_massivas_tipo_cobranca_corresponde(v_tipo, k.tm, k.tav)) as f_tipo_ok,
           (k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,
           case when v_op = 'todos' then false
                when v_op = 'livres' then k.resp is not null
                else k.resp is distinct from v_op end as f_outro,
           (v_rec > 0 and k.ult_mass is not null
            and v_hoje < (k.ult_mass at time zone 'America/Sao_Paulo')::date + v_rec) as f_rec,
           (nullif(regexp_replace(coalesce(k.telefone, ''), '\D', '', 'g'), '') is not null) as f_tel,
           (btrim(coalesce(k.email, '')) <> '' and position('@' in btrim(k.email)) > 1) as f_mail,
           (coalesce(k.valor_caso, 0) < v_min
            or (v_max is not null and coalesce(k.valor_caso, 0) > v_max)) as f_val
      from cls k
  ),
  enc as (
    select z.*,
           case when z.f_quit or z.f_liq then false
                else public.caso_encerrado_operacional(z.cpf, z.status_atual, z.status_acionamento, null::text, z.status_jornada)
           end as f_enc,
           case when v_canal = 'WHATSAPP' then not z.f_tel
                when v_canal = 'EMAIL' then not z.f_mail
                else false end
           or (v_sem_tel and z.f_tel) as f_ctt
      from flags z
  ),
  cl as (
    select e.*,
           case when e.f_quit then 'quitado'
                when e.f_liq then 'liquidado_prime'
                when e.f_enc then 'encerrado_operacional'
                when e.f_conf then 'confirmacao_pendente'
                when not e.f_tipo_ok then 'fora_tipo_cobranca'
                when e.f_ret then 'retorno_futuro'
                when e.f_outro then 'outro_responsavel'
                when e.f_rec then 'acao_massiva_recente'
                when e.f_ctt then 'contato_indisponivel'
                when e.f_val then 'valor_fora_da_faixa'
           end as mot,
           case when e.f_quit then 'quitado'
                when e.f_liq then 'liquidado_prime'
                when e.f_enc then 'encerrado_operacional'
                when e.f_conf then 'confirmacao_pendente'
                when e.f_ret then 'retorno_futuro'
                when e.f_outro then 'outro_responsavel'
                when e.f_rec then 'acao_massiva_recente'
                when e.f_ctt then 'contato_indisponivel'
                when e.f_val then 'valor_fora_da_faixa'
           end as mot_st
      from enc e
  )
  select cl.id, cl.anos, cl.resp, coalesce(cl.valor_caso, 0), cl.ult, cl.ult_mass,
         cl.mes, cl.hoje, (cl.ult is null),
         cl.tm, cl.tav,
         (cl.resp is not null and cl.dua is not null and public.caso_dentro_prazo_fidelizacao(cl.dua::date)),
         cl.f_tel, cl.f_mail,
         (cl.mot is null), cl.mot, cl.mot_st
    from cl;
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
                    'aluno_id', d.aluno_id, 'motivo_codigo', 'sem_email_valido',
                    'motivo', 'Sem e-mail válido no cadastro')
                  order by d.ord) filter (where not d.tem_email), '[]'::jsonb)
    into v_ok, v_contatos, v_excluidos
    from (select x.id_txt as aluno_id, x.ord, a.nome, btrim(a.email) as email,
                 public.email_valido_para_acao_massiva(a.email) as tem_email
            from unnest(v_ids) with ordinality as x(id_txt, ord)
            left join public.alunos a on a.id = x.id_txt::uuid) d;

  v_sem := jsonb_array_length(v_excluidos);

  -- VALIDACAO ANTES DE GRAVAR. Reconta por outro caminho (join direto, sem a
  -- montagem acima) e exige: exportados = alunos do lote com e-mail valido, e
  -- exportados + sem e-mail = alunos do lote. Divergencia nao grava nada.
  select count(*)::int into v_confere
    from unnest(v_ids) as x(id_txt)
    join public.alunos a on a.id = x.id_txt::uuid
   where public.email_valido_para_acao_massiva(a.email);

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
$function$;

DROP FUNCTION IF EXISTS public.acoes_massivas_fidelizacao_protege(timestamptz, timestamptz);
