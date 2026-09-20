-- ACOES MASSIVAS: FONTE UNICA DO UNIVERSO (cobertura + disponibilidade).
--
-- PROBLEMA: painel de penetracao e previa usavam populacoes diferentes; o LIMIT
-- e cortes no cliente escondiam o universo real; ninguem conseguia explicar
-- "pedi 1.000 e vieram 59".
--
-- ORDEM UNICA: FILTROS DE POPULACAO -> BASE (1 linha por aluno) -> COBERTURA ->
-- DISPONIBILIDADE (um motivo por aluno) -> filtro de acionamento -> PRIORIDADE
-- -> LIMIT. O LIMIT so decide QUANTOS entram; nunca qual parte da base e vista.
--
-- COBERTURA e DISPONIBILIDADE sao conceitos separados:
--   acionado_mes / acionado_hoje / nunca_acionado  -> "ja recebeu acionamento valido?"
--   disponivel / motivo                            -> "pode entrar numa acao agora?"
--
-- ACIONAMENTO VALIDO (cobertura), lista propria; eh_tipo_acionamento NAO e
-- alterada (ela alimenta fidelizacao, nivelamento, TV e ranking):
--   FINALIZACAO_ATENDIMENTO, FINALIZACAO, CONTATO, LINK_ENVIADO_AO_ALUNO,
--   SOLICITACAO_LINK_PAGAMENTO, ACAO_MASSIVA_EXTERNA, ACAO_MASSIVA_EXTERNA_EMAIL.
-- Administrativos (QUITADO_MANUAL, TERMO_ENVIADO_ADM, RETORNO_ADM_*,
-- COMPROVANTE_ENVIADO_BAIXA) NAO contam. Acao massiva so existe em
-- aluno_movimentacoes depois da CONFIRMACAO; previa e exportacao nao contam.
-- Finalizacao DESFEITA (par movimentacao <-> acoes_desfazer.desfeito_em) nao conta.
--
-- FUSO: "hoje" e "mes" em America/Sao_Paulo.
--
-- MOTIVO DE INDISPONIBILIDADE, um por aluno, na ordem de precedencia:
--   quitado > liquidado_prime > encerrado_operacional > confirmacao_pendente >
--   fora_tipo_cobranca > retorno_futuro > outro_responsavel >
--   acao_massiva_recente > contato_indisponivel > valor_fora_da_faixa
--
-- Nada aqui grava em alunos/casos: e leitura. A unica escrita e a linha de
-- auditoria da previa (acoes_massivas_previas).

-- ---------------------------------------------------------------- helpers
create or replace function public.acoes_massivas_tipo_cobertura(p_tipo text)
returns boolean
language sql immutable
set search_path to 'public'
as $$
  select coalesce(p_tipo, '') in (
    'FINALIZACAO_ATENDIMENTO', 'FINALIZACAO', 'CONTATO',
    'LINK_ENVIADO_AO_ALUNO', 'SOLICITACAO_LINK_PAGAMENTO',
    'ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL');
$$;

create or replace function public.acoes_massivas_motivo_texto(p_motivo text)
returns text
language sql immutable
set search_path to 'public'
as $$
  select case p_motivo
    when 'quitado'               then 'Quitado'
    when 'liquidado_prime'       then 'Já consta liquidado no Prime'
    when 'encerrado_operacional' then 'Caso encerrado operacionalmente'
    when 'confirmacao_pendente'  then 'Aguardando confirmação financeira'
    when 'fora_tipo_cobranca'    then 'Não corresponde ao tipo de cobrança selecionado'
    when 'retorno_futuro'        then 'Retorno agendado para data futura'
    when 'outro_responsavel'     then 'Fora do responsável selecionado'
    when 'acao_massiva_recente'  then 'Recebeu ação massiva neste canal dentro da recência'
    when 'contato_indisponivel'  then 'Sem contato válido para o canal / filtro de contato'
    when 'valor_fora_da_faixa'   then 'Valor em aberto fora da faixa selecionada'
    else p_motivo end;
$$;

-- --------------------------------------------------------------- universo
create or replace function public.acoes_massivas_universo(p_filtros jsonb default '{}'::jsonb)
returns table (
  aluno_id            uuid,
  anos                integer[],
  responsavel_email   text,
  valor               numeric,
  ultimo_acionamento  timestamptz,
  ultimo_massivo      timestamptz,
  acionado_mes        boolean,
  acionado_hoje       boolean,
  nunca_acionado      boolean,
  tem_mensalidade     boolean,
  tem_acordo_vencido  boolean,
  fidelizacao_ativa   boolean,
  tem_telefone        boolean,
  tem_email           boolean,
  disponivel          boolean,
  motivo              text,
  motivo_sem_tipo     text
)
language plpgsql stable security definer
set search_path to 'public'
set statement_timeout to '60s'
as $fn$
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
  base as materialized (
    select x.aluno_id, array_agg(distinct x.ano order by x.ano) as anos
      from (select * from tit union select * from parc) x
     group by x.aluno_id
  ),
  -- COBERTURA: so eventos de acionamento valido.
  mov as materialized (
    select m.aluno_id,
           max(m.registrado_em) as ult,
           bool_or(m.registrado_em >= v_mes_ini) as mes,
           bool_or(m.registrado_em >= v_hoje_ini) as hoje,
           max(m.registrado_em) filter (where m.tipo = any(v_tipos_massivo)) as ult_mass
      from public.aluno_movimentacoes m
     where public.acoes_massivas_tipo_cobertura(m.tipo)
       and (v_ids_txt is null or m.aluno_id = any(v_ids_txt))
       -- FINALIZACAO DESFEITA nao conta. Regra restrita ao par deterministico:
       -- acoes_desfazer.movimentacao_id aponta para ESTA movimentacao e a acao
       -- foi desfeita (desfeito_em preenchido). Hoje desfazer_acao ja retipa a
       -- movimentacao para FINALIZACAO_ATENDIMENTO_DESFEITA (que nao esta na
       -- lista); este filtro garante o mesmo resultado se algum desfazer futuro
       -- nao retipar. Uma ACAO_DESFEITA generica, sem vinculo, NAO invalida nada.
       and not exists (
         select 1 from public.acoes_desfazer ad
          where ad.movimentacao_id = m.id and ad.desfeito_em is not null)
     group by m.aluno_id
  ),
  -- POPULACAO: filtros que definem a base.
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
    -- funcao pesada: so roda para quem ainda nao caiu em quitado/liquidado
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
$fn$;

comment on function public.acoes_massivas_universo(jsonb) is
  'Fonte unica das Acoes Massivas: 1 linha por aluno com divida ativa, com cobertura (acionado no mes/hoje, nunca) e disponibilidade (um motivo de indisponibilidade). Leitura pura; alimenta previa, painel por ano e drill-down.';

-- ------------------------------------------------------- cobertura por ano
create or replace function public.acoes_massivas_cobertura_por_ano(p_filtros jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path to 'public'
set statement_timeout to '60s'
as $fn$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  -- o painel mostra todos os anos; o filtro de ano da tela de acao nao se aplica
  v_f jsonb := coalesce(p_filtros, '{}'::jsonb) - 'ano' - 'aluno_ids';
  v_res jsonb;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: cobertura das acoes massivas restrita a gestao.' using errcode = '42501';
  end if;

  with u as materialized (select * from public.acoes_massivas_universo(v_f)),
  anos as (select distinct unnest(u.anos) as ano from u),
  linhas as (
    select a.ano,
           count(*) as base,
           count(*) filter (where u.acionado_mes) as acionados,
           count(*) filter (where not u.acionado_mes) as sem_acionamento,
           count(*) filter (where u.disponivel) as disponiveis,
           count(*) filter (where u.disponivel and not u.acionado_mes) as disp_sem
      from anos a join u on u.anos @> array[a.ano]
     group by a.ano
  ),
  mot as (
    select a.ano, u.motivo, count(*) as n
      from anos a join u on u.anos @> array[a.ano]
     where not u.acionado_mes and u.motivo is not null
     group by a.ano, u.motivo
  ),
  tot as (
    select count(*) as base,
           count(*) filter (where u.acionado_mes) as acionados,
           count(*) filter (where not u.acionado_mes) as sem_acionamento,
           count(*) filter (where u.disponivel) as disponiveis,
           count(*) filter (where u.disponivel and not u.acionado_mes) as disp_sem
      from u
  ),
  mot_tot as (
    select u.motivo, count(*) as n from u where not u.acionado_mes and u.motivo is not null group by u.motivo
  ),
  linhas_json as (
    select l.ano,
           jsonb_build_object(
             'ano', l.ano, 'base', l.base, 'acionados', l.acionados,
             'sem_acionamento', l.sem_acionamento,
             'pct_acionado', round(100.0 * l.acionados / nullif(l.base, 0), 2),
             'disponiveis', l.disp_sem,
             'disponiveis_total', l.disponiveis,
             'indisponiveis', l.sem_acionamento - l.disp_sem,
             'motivos', coalesce((select jsonb_object_agg(m.motivo, m.n) from mot m where m.ano = l.ano), '{}'::jsonb),
             'reconcilia',
               (l.acionados + l.sem_acionamento = l.base)
               and (l.disp_sem + coalesce((select sum(m.n) from mot m where m.ano = l.ano), 0) = l.sem_acionamento)
           ) as j
      from linhas l
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'mes_referencia', to_char((now() at time zone 'America/Sao_Paulo'), 'YYYY-MM'),
    'linhas', coalesce((select jsonb_agg(lj.j order by lj.ano) from linhas_json lj), '[]'::jsonb),
    'total', (select jsonb_build_object(
               'ano', null, 'base', t.base, 'acionados', t.acionados,
               'sem_acionamento', t.sem_acionamento,
               'pct_acionado', round(100.0 * t.acionados / nullif(t.base, 0), 2),
               'disponiveis', t.disp_sem,
               'disponiveis_total', t.disponiveis,
               'indisponiveis', t.sem_acionamento - t.disp_sem,
               'motivos', coalesce((select jsonb_object_agg(mt.motivo, mt.n) from mot_tot mt), '{}'::jsonb),
               'reconcilia',
                 (t.acionados + t.sem_acionamento = t.base)
                 and (t.disp_sem + coalesce((select sum(mt.n) from mot_tot mt), 0) = t.sem_acionamento))
              from tot t)
  ) into v_res;
  return v_res;
end;
$fn$;

comment on function public.acoes_massivas_cobertura_por_ano(jsonb) is
  'Painel por ano: base, acionados no mes, sem acionamento, % e disponiveis. A linha total conta ALUNO UNICO (nao soma os anos). Mesma fonte da previa: acoes_massivas_universo.';

-- --------------------------------------------------------------- drill-down
create or replace function public.acoes_massivas_drilldown(
  p_filtros jsonb default '{}'::jsonb,
  p_ano integer default null,
  p_indicador text default 'base',
  p_motivo text default null,
  p_limit integer default 200,
  p_offset integer default 0
) returns jsonb
language plpgsql stable security definer
set search_path to 'public'
set statement_timeout to '60s'
as $fn$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_f jsonb := coalesce(p_filtros, '{}'::jsonb) - 'ano' - 'aluno_ids';
  v_ind text := lower(coalesce(nullif(btrim(p_indicador), ''), 'base'));
  v_lim int := least(greatest(coalesce(p_limit, 200), 1), 2000);
  v_off int := greatest(coalesce(p_offset, 0), 0);
  v_res jsonb;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: drill-down das acoes massivas restrito a gestao.' using errcode = '42501';
  end if;
  if v_ind not in ('base', 'acionados', 'sem_acionamento', 'disponiveis', 'disponiveis_sem_acionamento',
                   'indisponiveis', 'indisponiveis_total') then
    raise exception 'Indicador invalido: %', p_indicador using errcode = '22023';
  end if;

  with u as materialized (select * from public.acoes_massivas_universo(v_f)),
  sel as materialized (
    select u.*
      from u
     where (p_ano is null or u.anos @> array[p_ano])
       and (case v_ind
              when 'base' then true
              when 'acionados' then u.acionado_mes
              when 'sem_acionamento' then not u.acionado_mes
              when 'disponiveis' then u.disponivel
              when 'disponiveis_sem_acionamento' then u.disponivel and not u.acionado_mes
              when 'indisponiveis' then (not u.disponivel) and not u.acionado_mes
              when 'indisponiveis_total' then not u.disponivel
            end)
       and (p_motivo is null or u.motivo = p_motivo)
  ),
  pagina as (
    select s.*, a.nome, a.cpf, a.unidade, a.curso, a.situacao_academica
      from sel s join public.alunos a on a.id = s.aluno_id
     order by s.ultimo_acionamento asc nulls first, s.valor desc nulls last, s.aluno_id
     limit v_lim offset v_off
  )
  select jsonb_build_object(
    'indicador', v_ind, 'ano', p_ano, 'motivo', p_motivo,
    'total', (select count(*) from sel),
    'limit', v_lim, 'offset', v_off,
    'itens', coalesce((select jsonb_agg(jsonb_build_object(
        'aluno_id', pg.aluno_id,
        'nome', split_part(coalesce(pg.nome, '-'), ' ', 1) || ' ***',
        'cpf_final', right(regexp_replace(coalesce(pg.cpf, ''), '\D', '', 'g'), 4),
        'anos', pg.anos,
        'unidade', pg.unidade, 'curso', pg.curso, 'situacao_academica', pg.situacao_academica,
        'responsavel_email', pg.responsavel_email,
        'valor', pg.valor,
        'ultimo_acionamento', pg.ultimo_acionamento,
        'acionado_mes', pg.acionado_mes,
        'disponivel', pg.disponivel,
        'motivo', pg.motivo,
        'motivo_texto', public.acoes_massivas_motivo_texto(pg.motivo))
        order by pg.ultimo_acionamento asc nulls first, pg.valor desc nulls last, pg.aluno_id)
      from pagina pg), '[]'::jsonb)
  ) into v_res;
  return v_res;
end;
$fn$;

comment on function public.acoes_massivas_drilldown(jsonb, integer, text, text, integer, integer) is
  'Lista os alunos que formam exatamente cada indicador do painel (mesmo WHERE da cobertura). total = indicador.';

-- ------------------------------------------------------------------- previa
drop function if exists public.acoes_massivas_previa(
  text, integer, integer, boolean, text, text, boolean, text, uuid[], text, text, numeric, numeric, text, text);

create or replace function public.acoes_massivas_previa(
  p_ano_vencimento text default null,
  p_limite integer default 1000,
  p_dias_minimo_sem_contato integer default null,
  p_apenas_nunca_acionado boolean default false,
  p_unidade text default null,
  p_curso text default null,
  p_apenas_ja_acionado boolean default false,
  p_situacao_academica text default null,
  p_importacao_ids uuid[] default null,
  p_matricula text default null,
  p_canal text default null,
  p_valor_min numeric default 0,
  p_valor_max numeric default null,
  p_operador_email text default null,
  p_tipo_cobranca text default null,
  p_acionamento text default 'TODOS',
  p_recencia_dias integer default 10,
  p_sem_telefone boolean default false
) returns jsonb
language plpgsql volatile security definer
set search_path to 'public'
set statement_timeout to '60s'
as $fn$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_autor text;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 5000);
  v_acion text := upper(coalesce(nullif(btrim(p_acionamento), ''), 'TODOS'));
  v_op text := coalesce(lower(nullif(btrim(p_operador_email), '')), 'livres');
  v_filtros jsonb;
  v_res jsonb;
  v_previa uuid;
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: previa de acao massiva restrita a gestao.' using errcode = '42501';
  end if;
  if v_acion not in ('TODOS', 'NAO_MES', 'MES', 'NAO_HOJE', 'HOJE', 'NUNCA', 'JA') then
    raise exception 'Filtro de acionamento invalido: %', p_acionamento using errcode = '22023';
  end if;
  if v_acion = 'TODOS' and p_apenas_nunca_acionado then v_acion := 'NUNCA'; end if;
  if v_acion = 'TODOS' and p_apenas_ja_acionado then v_acion := 'JA'; end if;
  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;

  v_filtros := jsonb_strip_nulls(jsonb_build_object(
    'ano', nullif(btrim(p_ano_vencimento), ''),
    'unidade', nullif(btrim(p_unidade), ''),
    'curso', nullif(btrim(p_curso), ''),
    'situacao_academica', nullif(btrim(p_situacao_academica), ''),
    'matricula', nullif(btrim(p_matricula), ''),
    'importacao_ids', to_jsonb(p_importacao_ids),
    'operador', v_op,
    'tipo_cobranca', coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), 'MENSALIDADES_E_ACORDOS'),
    'canal', upper(nullif(btrim(p_canal), '')),
    'sem_telefone', coalesce(p_sem_telefone, false),
    'valor_min', coalesce(p_valor_min, 0),
    'valor_max', p_valor_max,
    'recencia_dias', coalesce(p_recencia_dias, 10),
    'acionamento', v_acion,
    'dias_minimo_sem_contato', p_dias_minimo_sem_contato,
    'limite', v_limite));

  with u as materialized (select * from public.acoes_massivas_universo(v_filtros)),
  el as materialized (
    select u.*
      from u
     where u.disponivel
       and (case v_acion
              when 'TODOS' then true
              when 'NAO_MES' then not u.acionado_mes
              when 'MES' then u.acionado_mes
              when 'NAO_HOJE' then not u.acionado_hoje
              when 'HOJE' then u.acionado_hoje
              when 'NUNCA' then u.nunca_acionado
              when 'JA' then not u.nunca_acionado
            end)
       and (p_dias_minimo_sem_contato is null or u.ultimo_acionamento is null
            or (u.ultimo_acionamento at time zone 'America/Sao_Paulo')::date <= v_hoje - p_dias_minimo_sem_contato)
  ),
  -- PRIORIDADE: nao acionados no mes; nunca acionados; maior tempo sem acionamento;
  -- maior saldo apenas como desempate; aluno_id como ultimo desempate.
  sel as materialized (
    select el.*
      from el
     order by el.acionado_mes asc, el.nunca_acionado desc, el.ultimo_acionamento asc nulls first,
              el.valor desc nulls last, el.aluno_id
     limit v_limite
  ),
  itens as (
    select s.*, a.nome, a.telefone, a.email, a.situacao_academica, a.curso, a.unidade,
           nullif(regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g'), '') as tel_dig,
           btrim(coalesce(a.email, '')) as email_t
      from sel s join public.alunos a on a.id = s.aluno_id
  )
  select jsonb_build_object(
    'resumo', jsonb_build_object(
      'solicitado', v_limite,
      'universo_base', (select count(*) from u),
      'disponiveis', (select count(*) from u where u.disponivel),
      'elegiveis', (select count(*) from el),
      'fora_do_filtro_acionamento', (select count(*) from u where u.disponivel) - (select count(*) from el),
      'selecionado', (select count(*) from sel),
      'indisponiveis', (select count(*) from u where not u.disponivel),
      'motivos', coalesce((select jsonb_object_agg(m.motivo, m.n)
                             from (select u.motivo, count(*) as n from u where u.motivo is not null group by u.motivo) m), '{}'::jsonb),
      'com_responsavel', (select count(*) from sel where sel.responsavel_email is not null),
      'com_fidelizacao_ativa', (select count(*) from sel where sel.fidelizacao_ativa),
      'menos_que_solicitado', (select count(*) from sel) < v_limite,
      'filtros', v_filtros),
    'elegiveis', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.aluno_id,
        'nome', split_part(coalesce(i.nome, '-'), ' ', 1) || ' ***',
        'situacao_academica', nullif(btrim(i.situacao_academica), ''),
        'curso', nullif(btrim(i.curso), ''),
        'unidade', i.unidade,
        'tem_telefone', i.tel_dig is not null,
        'tem_email', (i.email_t <> '' and position('@' in i.email_t) > 1),
        'telefone_mascarado', case when i.tel_dig is null then null
                                   when length(i.tel_dig) >= 4 then '••••' || right(i.tel_dig, 4) else '••••' end,
        'email_mascarado', case when i.email_t <> '' and position('@' in i.email_t) > 1
                                then left(i.email_t, 1) || '•••@' || split_part(i.email_t, '@', 2) else null end,
        'data_ultimo_acionamento', i.ultimo_acionamento,
        'valor', i.valor,
        'tem_responsavel', i.responsavel_email is not null,
        'responsavel_email', i.responsavel_email,
        'fidelizacao_ativa', i.fidelizacao_ativa,
        'acionado_mes', i.acionado_mes)
        order by i.acionado_mes asc, i.nunca_acionado desc, i.ultimo_acionamento asc nulls first,
                 i.valor desc nulls last, i.aluno_id) from itens i), '[]'::jsonb),
    'excluidos_confirmacao', '[]'::jsonb,
    'total_excluidos_confirmacao', (select count(*) from u where u.motivo = 'confirmacao_pendente'),
    'total_elegivel_filtros', (select count(*) from el),
    'prime_extrato_em', (select max(e.coletado_em)::date from public.prime_extrato e),
    'operador_email', v_op,
    'tipo_cobranca', coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), 'MENSALIDADES_E_ACORDOS'),
    -- quantidade por opcao de tipo, com todos os demais filtros aplicados e sem o limite
    'contagem_tipo', (select jsonb_build_object(
        'mensalidades', count(*) filter (where u.motivo_sem_tipo is null
                          and public.acoes_massivas_tipo_cobranca_corresponde('MENSALIDADES', u.tem_mensalidade, u.tem_acordo_vencido)),
        'acordos_vencidos', count(*) filter (where u.motivo_sem_tipo is null
                          and public.acoes_massivas_tipo_cobranca_corresponde('ACORDOS_VENCIDOS', u.tem_mensalidade, u.tem_acordo_vencido)),
        'mensalidades_e_acordos_vencidos', count(*) filter (where u.motivo_sem_tipo is null
                          and u.tem_mensalidade and u.tem_acordo_vencido),
        'total_unico', count(*) filter (where u.motivo_sem_tipo is null
                          and public.acoes_massivas_tipo_cobranca_corresponde('MENSALIDADES_E_ACORDOS', u.tem_mensalidade, u.tem_acordo_vencido)))
        from u)
  ) into v_res;

  insert into public.acoes_massivas_previas
    (criado_por_email, filtros, solicitado, universo_base, disponiveis, elegiveis, selecionado,
     indisponiveis, motivos, com_responsavel, com_fidelizacao)
  values (v_autor, v_filtros, v_limite,
          (v_res->'resumo'->>'universo_base')::int, (v_res->'resumo'->>'disponiveis')::int,
          (v_res->'resumo'->>'elegiveis')::int, (v_res->'resumo'->>'selecionado')::int,
          (v_res->'resumo'->>'indisponiveis')::int, v_res->'resumo'->'motivos',
          (v_res->'resumo'->>'com_responsavel')::int, (v_res->'resumo'->>'com_fidelizacao_ativa')::int)
  returning id into v_previa;

  return v_res || jsonb_build_object('previa_id', v_previa);
end;
$fn$;

comment on function public.acoes_massivas_previa is
  'Previa das Acoes Massivas sobre acoes_massivas_universo. Explica o resultado (resumo.motivos), aplica o LIMIT so depois de filtros, disponibilidade e prioridade, e registra a previa (contadores, sem dado pessoal). Nao altera responsavel nem aluno.';

-- --------------------------------------------------------------------- ACL
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('acoes_massivas_universo', 'acoes_massivas_cobertura_por_ano',
                         'acoes_massivas_drilldown', 'acoes_massivas_previa',
                         'acoes_massivas_tipo_cobertura', 'acoes_massivas_motivo_texto')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;
