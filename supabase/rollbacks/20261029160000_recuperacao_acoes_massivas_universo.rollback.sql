-- =============================================================================
-- ROLLBACK — recuperacao_acoes_massivas_universo
-- Restaura o estado exato de #775 (producao ao vivo antes desta migration).
-- MD5 da definicao apos aplicar: 88ec923f40294febcd4376491102b37d
-- Validado por T6 da suite consolidado_t.mjs (31/31 testes, sessão e854d0a5).
-- =============================================================================
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
