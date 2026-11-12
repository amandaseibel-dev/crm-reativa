-- ============================================================================
-- JURIDICO -- selecao, conferencia, aprovacao, bloqueio e encaminhamento
-- ----------------------------------------------------------------------------
-- Pedido da gestao em 12/11/2026: quando o juridico solicitar N alunos,
-- selecionar os melhores candidatos da carteira (titulos de 2025/1 em diante),
-- conferir valores e documentos, aprovar, BLOQUEAR A COBRANCA e gerar o Excel
-- do financeiro; depois registrar que o caso foi encaminhado ao juridico.
--
-- O QUE E REAPROVEITADO, e por que nao ha mecanismo de bloqueio novo:
--   * BLOQUEIO: a aprovacao grava o status 'JURIDICO' no aluno, exatamente como
--     a tabulacao JURIDICO (so-gestao) ja faz -- 65 dos 69 alunos em juridico em
--     producao carregam o codigo nas tres colunas. Quem ja le esse estado
--     continua lendo: `aluno_bloqueio_administrativo` (portao canonico, base de
--     `aluno_elegibilidade_cobranca` e das acoes massivas),
--     `alunos_propaga_encerramento_para_caso` -> `casos.encerrado_operacional`
--     (fila, giro, nivelamento, redistribuicao), `aluno_bloqueado_para_d2`
--     (alertas automaticos) e a ficha (`STATUS_BLOQUEADOS_ACIONAMENTO`).
--   * NENHUM TITULO E ESCRITO. `acordos_titulos`, `parcelas` e `acordos` nao
--     recebem UPDATE: nada e cancelado, encerrado ou devolvido. O que a
--     aprovacao guarda e uma FOTOGRAFIA dos titulos aprovados
--     (`juridico_casos_titulos`) e o estado anterior do aluno, para desfazer.
--   * PERMISSAO: `usuario_e_gestao()` em toda RPC. Tabelas com RLS ligada e
--     SEM policy: so se le e escreve pelas RPCs.
--   * TERMO: lido de `termos_acordo` (e `casos.termo_url`), sem copiar arquivo.
--
-- FAIL-CLOSED: se a tabulacao JURIDICO um dia ganhar `efeito_desfecho` ou
-- `redireciona_para_email`, gravar o status passaria a ter efeito financeiro
-- pelos gatilhos de `status_jornada`. A aprovacao recusa nesse caso.
--
-- NAO DUPLICA VALOR: mensalidade vinculada a acordo nao cancelado, ou em
-- situacao NEGOCIADO, NAO entra na soma -- o que entra e a parcela viva do
-- acordo. Titulo ja encaminhado nao volta: indice unico parcial por titulo e
-- por parcela, e um caso ativo por aluno.
--
-- ROLLBACK: supabase/rollbacks/20261112180000_juridico_encaminhamento.rollback.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. TABELAS
-- ---------------------------------------------------------------------------
create sequence public.juridico_protocolo_seq;

create table public.juridico_lotes (
  id uuid primary key default gen_random_uuid(),
  protocolo text not null unique,
  qtd_solicitada integer not null check (qtd_solicitada between 1 and 500),
  filtros jsonb not null default '{}'::jsonb,
  observacao text,
  criado_por text not null,
  criado_em timestamptz not null default now(),
  enviado_financeiro_em timestamptz,
  enviado_financeiro_por text
);

create table public.juridico_casos (
  id uuid primary key default gen_random_uuid(),
  lote_id uuid not null references public.juridico_lotes(id),
  aluno_id uuid not null references public.alunos(id),
  status text not null default 'EM_ANALISE'
    check (status in ('EM_ANALISE','APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO','REMOVIDO')),
  grupo text,
  situacao_academica text,
  semestre_divida text,
  valor_previa numeric(14,2),
  valor_aprovado numeric(14,2),
  acordo_ativo_aprovado_por text,
  acordo_ativo_aprovado_em timestamptz,
  acordo_ativo_motivo text,
  doc_manual_nome text,
  doc_manual_ref text,
  doc_manual_origem text check (doc_manual_origem is null
    or doc_manual_origem in ('CRM','DRIVE','PRESENCIAL_DIGITALIZADO','OUTRO')),
  doc_manual_por text,
  doc_manual_em timestamptz,
  doc_autorizado_por text,
  doc_autorizado_em timestamptz,
  doc_autorizado_motivo text,
  bloqueio_anterior jsonb,
  aprovado_por text,
  aprovado_em timestamptz,
  enviado_financeiro_em timestamptz,
  enviado_financeiro_por text,
  confirmado_juridico_data date,
  confirmado_juridico_em timestamptz,
  confirmado_juridico_por text,
  confirmado_juridico_obs text,
  removido_em timestamptz,
  removido_por text,
  removido_motivo text,
  criado_por text not null,
  criado_em timestamptz not null default now()
);

-- Um caso vivo por aluno: impede o mesmo aluno em dois lotes.
create unique index juridico_casos_um_ativo_por_aluno
  on public.juridico_casos (aluno_id) where status <> 'REMOVIDO';
create index juridico_casos_lote on public.juridico_casos (lote_id);

create table public.juridico_casos_titulos (
  id uuid primary key default gen_random_uuid(),
  caso_id uuid not null references public.juridico_casos(id),
  aluno_id uuid not null,
  tipo text not null check (tipo in ('MENSALIDADE','PARCELA_ACORDO')),
  titulo_id uuid,
  parcela_id uuid,
  acordo_id uuid,
  documento text,
  vencimento date,
  valor numeric(14,2) not null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  check ((tipo = 'MENSALIDADE' and titulo_id is not null and parcela_id is null)
      or (tipo = 'PARCELA_ACORDO' and parcela_id is not null and titulo_id is null))
);

-- Titulo ja encaminhado nao e encaminhado de novo.
create unique index juridico_titulo_encaminhado_uma_vez
  on public.juridico_casos_titulos (titulo_id) where ativo and titulo_id is not null;
create unique index juridico_parcela_encaminhada_uma_vez
  on public.juridico_casos_titulos (parcela_id) where ativo and parcela_id is not null;
create index juridico_casos_titulos_caso on public.juridico_casos_titulos (caso_id);

create table public.juridico_historico (
  id bigint generated always as identity primary key,
  caso_id uuid,
  lote_id uuid,
  evento text not null,
  detalhe jsonb,
  por text not null,
  em timestamptz not null default now()
);
create index juridico_historico_caso on public.juridico_historico (caso_id);

-- Tabela nova em `public` herda arwdDxtm para authenticated (inclusive
-- TRUNCATE, que a RLS nao cobre). Fecha tudo: o acesso e so pelas RPCs.
alter table public.juridico_lotes enable row level security;
alter table public.juridico_casos enable row level security;
alter table public.juridico_casos_titulos enable row level security;
alter table public.juridico_historico enable row level security;
revoke all on public.juridico_lotes, public.juridico_casos,
              public.juridico_casos_titulos, public.juridico_historico
  from public, anon, authenticated;
revoke all on sequence public.juridico_protocolo_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. AUXILIARES (internas: sem grant para authenticated)
-- ---------------------------------------------------------------------------
create function public._juridico_exigir_gestao()
returns text
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_email text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if v_email = '' or not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'A aba Jurídico é restrita à gestão.' using errcode = '42501';
  end if;
  return v_email;
end;
$function$;

create function public._juridico_grupo(p_situacao_academica text)
returns text
language sql immutable set search_path to 'public'
as $function$
  select case upper(translate(btrim(coalesce(p_situacao_academica,'')), 'íÍ', 'II'))
    when 'FORMADO' then 'FORMADO'
    when 'CONCLUIDO' then 'FORMADO'
    when 'TRANCADO' then 'TRANCADO'
    when 'TRANCAMENTO INSTITUCIONAL' then 'TRANCADO'
    when 'CANCELADO' then 'EVADIDO'
    when 'DESVINCULADO' then 'EVADIDO'
    when 'CANCELAMENTO INSTITUCIONAL' then 'EVADIDO'
    else null end;
$function$;

-- Conferencia financeira e documental de UM aluno, lida na hora.
create function public._juridico_conferencia(p_aluno_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_mens jsonb; v_acordos jsonb;
  v_incorp_qtd int; v_incorp_valor numeric; v_neg_sem_vinculo int;
  v_cancelados int; v_em_conf int; v_pag_pend boolean;
  v_tem_acordo boolean; v_termo jsonb;
  v_total_mens numeric; v_total_acordo numeric;
begin
  -- Mensalidade ELEGIVEL: aberta, vencida, de 2025/1 em diante, fora de acordo.
  select coalesce(jsonb_agg(jsonb_build_object(
           'titulo_id', t.id, 'documento', t.documento, 'vencimento', t.vencimento,
           'competencia', t.competencia,
           'valor', round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0), 2))
           order by t.vencimento, t.documento), '[]'::jsonb),
         coalesce(sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0), 2)), 0)
    into v_mens, v_total_mens
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) = 'ABERTO'
     and coalesce(lower(t.status),'') <> 'quitada'
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and t.origem_encerramento is null
     and t.vencimento >= date '2025-01-01'
     and t.vencimento < current_date
     and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0) > 0
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

  -- Mensalidade INCORPORADA a acordo: aparece, mas NAO soma.
  select count(*), coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0)), 0),
         count(*) filter (where upper(coalesce(t.situacao,'')) = 'NEGOCIADO' and not exists (
           select 1 from public.acordo_titulo_vinculo v
            where v.titulo_id = t.id and coalesce(v.ativo, true)))
    into v_incorp_qtd, v_incorp_valor, v_neg_sem_vinculo
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and (upper(coalesce(t.situacao,'')) = 'NEGOCIADO' or exists (
           select 1 from public.acordo_titulo_vinculo v
             join public.acordos a on a.id = v.acordo_id
            where v.titulo_id = t.id and coalesce(v.ativo, true)
              and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')));

  select count(*) into v_em_conf
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO';

  -- Acordos ATIVOS. "Quebrado" = ativo com parcela vencida. Parcela viva =
  -- A_VENCER ou VENCIDA (mesmo conjunto de `parcela_viva`, sem RENEGOCIADA).
  select coalesce(jsonb_agg(x.j order by x.criado_em), '[]'::jsonb),
         coalesce(sum(x.saldo), 0), count(*) > 0
    into v_acordos, v_total_acordo, v_tem_acordo
    from (
      select a.criado_em,
             coalesce(sum(p.valor) filter (where upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')), 0) as saldo,
             jsonb_build_object(
               'acordo_id', a.id, 'numero_acordo', a.numero_acordo, 'numero_ulbra', a.numero_ulbra,
               'status', a.status,
               'situacao', case when count(*) filter (where upper(coalesce(p.status,'')) = 'VENCIDA') > 0
                                then 'QUEBRADO' else 'ATIVO_EM_DIA' end,
               'parcelas_vencidas', count(*) filter (where upper(coalesce(p.status,'')) = 'VENCIDA'),
               'saldo', round(coalesce(sum(p.valor) filter (where upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')), 0), 2),
               'parcelas', coalesce(jsonb_agg(jsonb_build_object(
                    'parcela_id', p.id, 'numero', p.numero, 'vencimento', p.vencimento,
                    'valor', round(coalesce(p.valor,0), 2), 'status', p.status, 'boleto', p.boleto)
                    order by p.numero)
                  filter (where upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')), '[]'::jsonb)
             ) as j
        from public.acordos a
        left join public.parcelas p on p.acordo_id = a.id
       where a.aluno_id = p_aluno_id
         and upper(coalesce(a.status,'')) = 'ATIVO'
         and a.duplicado_de is null
       group by a.id
    ) x;

  select count(*) into v_cancelados
    from public.acordos a
   where a.aluno_id = p_aluno_id and upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA');

  v_pag_pend := v_em_conf > 0 or exists (
    select 1 from public.solicitacoes_confirmacao_pagamento s
     where s.aluno_id = p_aluno_id::text
       and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'));

  -- Termo do acordo nos anexos do CRM.
  if not v_tem_acordo then
    v_termo := jsonb_build_object('status', 'NAO_APLICAVEL');
  else
    select jsonb_build_object(
             'status', case when ta.etapa_assinatura = 'COMPLETO' and ta.arquivo_final_url is not null
                            then 'LOCALIZADO' else 'VALIDAR' end,
             'termo_id', ta.id,
             'nome', coalesce(ta.arquivo_final_nome, ta.arquivo_nome),
             'referencia', coalesce(ta.arquivo_final_url, ta.arquivo_url),
             'etapa', ta.etapa_assinatura, 'status_termo', ta.status)
      into v_termo
      from public.termos_acordo ta
     where ta.aluno_id = p_aluno_id::text
       and coalesce(ta.status,'') <> 'TERMO_REJEITADO'
       and coalesce(ta.arquivo_final_url, ta.arquivo_url) is not null
     order by (ta.etapa_assinatura = 'COMPLETO' and ta.arquivo_final_url is not null) desc,
              ta.criado_em desc
     limit 1;

    if v_termo is null then
      select jsonb_build_object('status', 'VALIDAR', 'nome', c.termo_nome_arquivo,
                                'referencia', c.termo_url, 'etapa', 'ANEXO_DO_CASO')
        into v_termo
        from public.casos c
       where c.aluno_id = p_aluno_id and c.termo_url is not null
       limit 1;
    end if;
    v_termo := coalesce(v_termo, jsonb_build_object('status', 'NAO_LOCALIZADO'));
  end if;

  return jsonb_build_object(
    'mensalidades', v_mens,
    'total_mensalidades', round(v_total_mens, 2),
    'incorporadas_qtd', v_incorp_qtd,
    'incorporadas_valor', round(v_incorp_valor, 2),
    'negociado_sem_vinculo', v_neg_sem_vinculo,
    'acordos', v_acordos,
    'total_acordos', round(v_total_acordo, 2),
    'acordo_ativo_em_dia', exists (select 1 from jsonb_array_elements(v_acordos) e
                                    where e->>'situacao' = 'ATIVO_EM_DIA'),
    'acordos_cancelados', v_cancelados,
    'titulos_em_confirmacao', v_em_conf,
    'pagamento_pendente', v_pag_pend,
    'termo', v_termo,
    'total', round(v_total_mens + v_total_acordo, 2),
    'bloqueio', public.aluno_bloqueio_administrativo(p_aluno_id));
end;
$function$;

-- Pendencias de UM caso. As que comecam por '!' nao tem como ser liberadas.
create function public._juridico_pendencias(p_caso public.juridico_casos, p_conf jsonb)
returns text[]
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v text[] := '{}'::text[]; v_termo text := p_conf->'termo'->>'status';
begin
  if (p_conf->>'pagamento_pendente')::boolean then
    v := array_append(v, '!PAGAMENTO_PENDENTE'); end if;
  if coalesce((p_conf->>'total')::numeric, 0) <= 0 then
    v := array_append(v, '!SEM_SALDO_ELEGIVEL'); end if;
  if p_caso.status = 'EM_ANALISE' and p_conf->>'bloqueio' is not null then
    v := array_append(v, '!BLOQUEIO_ADMINISTRATIVO:' || (p_conf->>'bloqueio')); end if;
  if (p_conf->>'acordo_ativo_em_dia')::boolean and p_caso.acordo_ativo_aprovado_em is null then
    v := array_append(v, 'ACORDO_ATIVO_SEM_APROVACAO'); end if;
  if v_termo in ('NAO_LOCALIZADO','VALIDAR')
     and p_caso.doc_manual_em is null and p_caso.doc_autorizado_em is null then
    v := array_append(v, case v_termo when 'VALIDAR' then 'TERMO_A_VALIDAR' else 'TERMO_NAO_LOCALIZADO' end);
  end if;
  return v;
end;
$function$;

create function public._juridico_registrar(p_caso uuid, p_lote uuid, p_evento text, p_detalhe jsonb, p_por text)
returns void
language sql security definer set search_path to 'public'
as $function$
  insert into public.juridico_historico (caso_id, lote_id, evento, detalhe, por)
  values (p_caso, p_lote, p_evento, p_detalhe, p_por);
$function$;

-- Ranking de candidatos. Interna: a porta de gestao esta em quem chama.
create function public._juridico_candidatos(
  p_limite integer, p_ano integer, p_semestre integer, p_grupos text[], p_excluir uuid[])
returns table (
  aluno_id uuid, nome text, matricula text, curso text, situacao_academica text,
  grupo text, semestre_divida text, prioridade integer,
  valor_mensalidades numeric, valor_acordos numeric, valor_total numeric,
  qtd_titulos integer, tem_acordo_ativo boolean)
language sql stable security definer set search_path to 'public'
as $function$
  with tit as materialized (
    select t.aluno_id as tid,
           sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0), 2)) as v,
           count(*)::int as n
      from public.acordos_titulos t
     where upper(coalesce(t.situacao,'')) = 'ABERTO'
       and coalesce(lower(t.status),'') <> 'quitada'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and t.origem_encerramento is null
       and t.vencimento >= date '2025-01-01'
       and t.vencimento < current_date
       and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0) > 0
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
     group by t.aluno_id
  ),
  aco as materialized (
    select q.aid, sum(q.saldo) filter (where q.vencidas > 0) as v_quebrado, true as tem
      from (
        select a.aluno_id as aid, a.id,
               coalesce(sum(p.valor) filter (where upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')), 0) as saldo,
               count(*) filter (where upper(coalesce(p.status,'')) = 'VENCIDA') as vencidas
          from public.acordos a
          left join public.parcelas p on p.acordo_id = a.id
         where upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null
         group by a.aluno_id, a.id
      ) q
     group by q.aid
  ),
  ranqueado as materialized (
    select al.id, al.nome, al.matricula, al.curso, al.situacao_academica,
           public._juridico_grupo(al.situacao_academica) as grupo,
           al.semestre_divida,
           case public._juridico_grupo(al.situacao_academica)
             when 'FORMADO' then
               case when p_ano is not null
                         and al.semestre_divida like p_ano::text || '/' || coalesce(p_semestre::text, '%')
                    then 1 else 2 end
             when 'TRANCADO' then 3
             else 4 end as prioridade,
           coalesce(tit.v, 0) as v_mens,
           coalesce(aco.v_quebrado, 0) as v_aco,
           coalesce(tit.n, 0) as n,
           coalesce(aco.tem, false) as tem
      from public.alunos al
      left join tit on tit.tid = al.id
      left join aco on aco.aid = al.id
     where public._juridico_grupo(al.situacao_academica) is not null
       and (p_grupos is null or public._juridico_grupo(al.situacao_academica) = any(p_grupos))
       and coalesce(tit.v, 0) + coalesce(aco.v_quebrado, 0) > 0
       and (p_excluir is null or al.id <> all(p_excluir))
       and not exists (select 1 from public.juridico_casos jc
                        where jc.aluno_id = al.id and jc.status <> 'REMOVIDO')
       and not exists (select 1 from public.acordos_titulos t2
                        where t2.aluno_id = al.id and upper(coalesce(t2.situacao,'')) = 'EM_CONFIRMACAO')
       and not exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                        where s.aluno_id = al.id::text
                          and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))
     order by 8, coalesce(tit.v, 0) + coalesce(aco.v_quebrado, 0) desc, al.id
     -- folga: o portao administrativo e avaliado so sobre este recorte
     limit greatest(coalesce(p_limite, 0), 0) * 3 + 30
  )
  select r.id, r.nome, r.matricula, r.curso, r.situacao_academica, r.grupo, r.semestre_divida,
         r.prioridade, r.v_mens, r.v_aco, r.v_mens + r.v_aco, r.n, r.tem
    from ranqueado r
   where public.aluno_bloqueio_administrativo(r.id) is null
   order by r.prioridade, r.v_mens + r.v_aco desc, r.id
   limit greatest(coalesce(p_limite, 0), 0);
$function$;

-- ---------------------------------------------------------------------------
-- 3. RPCs DA ABA (todas com portao de gestao)
-- ---------------------------------------------------------------------------
create function public.juridico_candidatos(
  p_limite integer default 40, p_ano integer default null, p_semestre integer default null,
  p_grupos text[] default null)
returns table (
  aluno_id uuid, nome text, matricula text, curso text, situacao_academica text,
  grupo text, semestre_divida text, prioridade integer,
  valor_mensalidades numeric, valor_acordos numeric, valor_total numeric,
  qtd_titulos integer, tem_acordo_ativo boolean)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  perform public._juridico_exigir_gestao();
  return query
    select c.aluno_id, c.nome, c.matricula, c.curso, c.situacao_academica, c.grupo,
           c.semestre_divida, c.prioridade, c.valor_mensalidades, c.valor_acordos,
           c.valor_total, c.qtd_titulos, c.tem_acordo_ativo
      from public._juridico_candidatos(least(greatest(coalesce(p_limite, 40), 1), 500),
                                       p_ano, p_semestre, p_grupos, null) c;
end;
$function$;

create function public.juridico_lote_gerar(
  p_qtd integer, p_ano integer default null, p_semestre integer default null,
  p_grupos text[] default null, p_observacao text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text := public._juridico_exigir_gestao();
  v_lote uuid; v_protocolo text; v_n int;
begin
  if p_qtd is null or p_qtd < 1 or p_qtd > 500 then
    raise exception 'Informe quantos alunos o jurídico solicitou (1 a 500).' using errcode = '22023';
  end if;

  v_protocolo := 'JUR-' || to_char(now() at time zone 'America/Sao_Paulo', 'YYYYMMDD') || '-'
                 || lpad(nextval('public.juridico_protocolo_seq')::text, 4, '0');

  insert into public.juridico_lotes (protocolo, qtd_solicitada, filtros, observacao, criado_por)
  values (v_protocolo, p_qtd,
          jsonb_build_object('ano', p_ano, 'semestre', p_semestre, 'grupos', p_grupos),
          nullif(btrim(coalesce(p_observacao,'')), ''), v_email)
  returning id into v_lote;

  insert into public.juridico_casos
    (lote_id, aluno_id, grupo, situacao_academica, semestre_divida, valor_previa, criado_por)
  select v_lote, c.aluno_id, c.grupo, c.situacao_academica, c.semestre_divida, c.valor_total, v_email
    from public._juridico_candidatos(p_qtd, p_ano, p_semestre, p_grupos, null) c;
  get diagnostics v_n = row_count;

  perform public._juridico_registrar(null, v_lote, 'LOTE_GERADO',
    jsonb_build_object('protocolo', v_protocolo, 'solicitados', p_qtd, 'gerados', v_n), v_email);

  return jsonb_build_object('lote_id', v_lote, 'protocolo', v_protocolo,
                            'solicitados', p_qtd, 'gerados', v_n);
end;
$function$;

-- Desfaz o bloqueio de um caso APROVADO. So restaura o que ESTE caso gravou.
create function public._juridico_desbloquear(p_caso public.juridico_casos)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare v_ant jsonb := p_caso.bloqueio_anterior->'aluno';
begin
  if v_ant is null then return; end if;

  -- Mesma guarda que a reativacao da suspensao usa: restaurar o codigo antigo
  -- em `status_jornada` nao pode reaplicar efeito financeiro de tabulacao.
  perform set_config('parcela_efeito_sem_pagamento.aplicando', 'on', true);

  update public.alunos al
     set status_atual       = coalesce(nullif(v_ant->>'status_atual',''), 'CONTATAR'),
         status_jornada     = coalesce(nullif(v_ant->>'status_jornada',''), 'CONTATAR'),
         status_acionamento = coalesce(nullif(v_ant->>'status_acionamento',''), 'CONTATAR')
   where al.id = p_caso.aluno_id
     and upper(coalesce(al.status_atual,'')) = 'JURIDICO';

  update public.casos c
     set status_atual = x.status_atual
    from jsonb_to_recordset(coalesce(p_caso.bloqueio_anterior->'casos', '[]'::jsonb))
           as x(id uuid, status_atual text)
   where c.id = x.id and upper(coalesce(c.status_atual,'')) = 'JURIDICO';

  perform set_config('parcela_efeito_sem_pagamento.aplicando', '', true);

  if public.aluno_bloqueio_administrativo(p_caso.aluno_id) = 'JURIDICO' then
    raise exception 'Não foi possível levantar o bloqueio jurídico do aluno %. Nada foi alterado.', p_caso.aluno_id
      using errcode = 'P0001';
  end if;
end;
$function$;

create function public.juridico_caso_remover(p_caso_id uuid, p_motivo text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_caso public.juridico_casos;
begin
  if nullif(btrim(coalesce(p_motivo,'')), '') is null then
    raise exception 'Informe o motivo da remoção.' using errcode = '22023';
  end if;
  select * into v_caso from public.juridico_casos where id = p_caso_id for update;
  if not found then raise exception 'Caso não encontrado.' using errcode = 'P0002'; end if;
  if v_caso.status not in ('EM_ANALISE','APROVADO') then
    raise exception 'Caso % não pode ser removido: já foi enviado ao financeiro.', v_caso.status
      using errcode = 'P0001';
  end if;

  if v_caso.status = 'APROVADO' then
    perform public._juridico_desbloquear(v_caso);
    update public.juridico_casos_titulos set ativo = false where caso_id = p_caso_id and ativo;
    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email)
    values (v_caso.aluno_id::text, 'JURIDICO_BLOQUEIO_LEVANTADO',
            'Caso retirado da análise jurídica antes do envio ao financeiro. Motivo: ' || btrim(p_motivo),
            'JURIDICO', v_caso.bloqueio_anterior->'aluno'->>'status_atual', v_email, v_email);
  end if;

  update public.juridico_casos
     set status = 'REMOVIDO', removido_em = now(), removido_por = v_email,
         removido_motivo = btrim(p_motivo)
   where id = p_caso_id;

  perform public._juridico_registrar(p_caso_id, v_caso.lote_id, 'CASO_REMOVIDO',
    jsonb_build_object('de', v_caso.status, 'motivo', btrim(p_motivo)), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'status', 'REMOVIDO');
end;
$function$;

-- Troca um candidato EM ANALISE pelo proximo melhor do mesmo criterio do lote.
create function public.juridico_caso_substituir(p_caso_id uuid, p_motivo text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text := public._juridico_exigir_gestao();
  v_caso public.juridico_casos; v_f jsonb; v_novo uuid; v_grupos text[];
begin
  select * into v_caso from public.juridico_casos where id = p_caso_id for update;
  if not found then raise exception 'Caso não encontrado.' using errcode = 'P0002'; end if;
  if v_caso.status <> 'EM_ANALISE' then
    raise exception 'Só é possível substituir caso em análise (este está %).', v_caso.status
      using errcode = 'P0001';
  end if;

  perform public.juridico_caso_remover(p_caso_id, coalesce(nullif(btrim(coalesce(p_motivo,'')), ''), 'Substituído'));

  select filtros into v_f from public.juridico_lotes where id = v_caso.lote_id;
  if jsonb_typeof(v_f->'grupos') = 'array' then
    select array_agg(g) into v_grupos from jsonb_array_elements_text(v_f->'grupos') g;
  end if;

  insert into public.juridico_casos
    (lote_id, aluno_id, grupo, situacao_academica, semestre_divida, valor_previa, criado_por)
  select v_caso.lote_id, c.aluno_id, c.grupo, c.situacao_academica, c.semestre_divida, c.valor_total, v_email
    from public._juridico_candidatos(1, (v_f->>'ano')::int, (v_f->>'semestre')::int, v_grupos,
           -- quem ja passou por este lote (inclusive o removido) nao volta
           (select array_agg(jc.aluno_id) from public.juridico_casos jc where jc.lote_id = v_caso.lote_id)) c
  returning id into v_novo;

  perform public._juridico_registrar(v_novo, v_caso.lote_id, 'CASO_SUBSTITUTO',
    jsonb_build_object('substitui', p_caso_id), v_email);
  return jsonb_build_object('removido', p_caso_id, 'novo_caso_id', v_novo);
end;
$function$;

create function public.juridico_caso_documento_vincular(
  p_caso_id uuid, p_nome text, p_referencia text, p_origem text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_caso public.juridico_casos;
begin
  if nullif(btrim(coalesce(p_referencia,'')), '') is null then
    raise exception 'Informe o link ou a localização do documento.' using errcode = '22023';
  end if;
  if upper(coalesce(p_origem,'')) not in ('CRM','DRIVE','PRESENCIAL_DIGITALIZADO','OUTRO') then
    raise exception 'Origem do documento inválida.' using errcode = '22023';
  end if;
  select * into v_caso from public.juridico_casos where id = p_caso_id for update;
  if not found then raise exception 'Caso não encontrado.' using errcode = 'P0002'; end if;
  if v_caso.status = 'REMOVIDO' then
    raise exception 'Caso removido não recebe documento.' using errcode = 'P0001';
  end if;

  update public.juridico_casos
     set doc_manual_nome = nullif(btrim(coalesce(p_nome,'')), ''),
         doc_manual_ref = btrim(p_referencia),
         doc_manual_origem = upper(p_origem),
         doc_manual_por = v_email, doc_manual_em = now()
   where id = p_caso_id;

  perform public._juridico_registrar(p_caso_id, v_caso.lote_id, 'DOCUMENTO_VINCULADO',
    jsonb_build_object('origem', upper(p_origem), 'nome', p_nome, 'referencia', btrim(p_referencia)), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'documento', 'VINCULADO_MANUAL');
end;
$function$;

create function public.juridico_caso_autorizar_documento(p_caso_id uuid, p_motivo text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_lote uuid;
begin
  if nullif(btrim(coalesce(p_motivo,'')), '') is null then
    raise exception 'Registre quem do jurídico autorizou e por quê.' using errcode = '22023';
  end if;
  update public.juridico_casos
     set doc_autorizado_por = v_email, doc_autorizado_em = now(),
         doc_autorizado_motivo = btrim(p_motivo)
   where id = p_caso_id and status = 'EM_ANALISE'
  returning lote_id into v_lote;
  if not found then
    raise exception 'Só caso em análise recebe autorização de pendência documental.' using errcode = 'P0001';
  end if;
  perform public._juridico_registrar(p_caso_id, v_lote, 'PENDENCIA_DOCUMENTAL_AUTORIZADA',
    jsonb_build_object('motivo', btrim(p_motivo)), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'autorizado', true);
end;
$function$;

create function public.juridico_caso_aprovar_acordo_ativo(p_caso_id uuid, p_motivo text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_lote uuid;
begin
  if nullif(btrim(coalesce(p_motivo,'')), '') is null then
    raise exception 'Informe o motivo para encaminhar um aluno com acordo ativo.' using errcode = '22023';
  end if;
  update public.juridico_casos
     set acordo_ativo_aprovado_por = v_email, acordo_ativo_aprovado_em = now(),
         acordo_ativo_motivo = btrim(p_motivo)
   where id = p_caso_id and status = 'EM_ANALISE'
  returning lote_id into v_lote;
  if not found then
    raise exception 'Só caso em análise recebe aprovação de acordo ativo.' using errcode = 'P0001';
  end if;
  perform public._juridico_registrar(p_caso_id, v_lote, 'ACORDO_ATIVO_APROVADO',
    jsonb_build_object('motivo', btrim(p_motivo)), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'acordo_ativo_aprovado', true);
end;
$function$;

-- APROVAR: fotografa os titulos e BLOQUEIA a cobranca do aluno.
create function public.juridico_caso_aprovar(p_caso_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text := public._juridico_exigir_gestao();
  v_caso public.juridico_casos; v_conf jsonb; v_pend text[]; v_ant jsonb; v_n int;
begin
  select * into v_caso from public.juridico_casos where id = p_caso_id for update;
  if not found then raise exception 'Caso não encontrado.' using errcode = 'P0002'; end if;
  if v_caso.status <> 'EM_ANALISE' then
    raise exception 'Caso já está %: não há o que aprovar.', v_caso.status using errcode = 'P0001';
  end if;

  -- trava a linha do aluno: duas aprovacoes simultaneas nao se cruzam
  perform 1 from public.alunos where id = v_caso.aluno_id for update;

  v_conf := public._juridico_conferencia(v_caso.aluno_id);
  v_pend := public._juridico_pendencias(v_caso, v_conf);
  if array_length(v_pend, 1) > 0 then
    raise exception 'Caso com pendência não pode ser aprovado: %', array_to_string(v_pend, ', ')
      using errcode = 'P0001';
  end if;

  -- FAIL-CLOSED: JURIDICO nao pode ter efeito financeiro nem redirecionamento.
  if exists (select 1 from public.tabulacoes t
              where upper(btrim(t.codigo)) = 'JURIDICO'
                and (nullif(to_jsonb(t)->>'efeito_desfecho', '') is not null
                  or nullif(to_jsonb(t)->>'redireciona_para_email', '') is not null)) then
    raise exception 'A tabulação JURIDICO passou a ter efeito financeiro ou redirecionamento. Aprovação recusada até revisão.'
      using errcode = 'P0001';
  end if;

  -- Fotografia. O indice unico recusa titulo ja encaminhado em outro caso.
  insert into public.juridico_casos_titulos (caso_id, aluno_id, tipo, titulo_id, documento, vencimento, valor)
  select p_caso_id, v_caso.aluno_id, 'MENSALIDADE', (m->>'titulo_id')::uuid, m->>'documento',
         (m->>'vencimento')::date, (m->>'valor')::numeric
    from jsonb_array_elements(v_conf->'mensalidades') m;

  insert into public.juridico_casos_titulos (caso_id, aluno_id, tipo, parcela_id, acordo_id, documento, vencimento, valor)
  select p_caso_id, v_caso.aluno_id, 'PARCELA_ACORDO', (p->>'parcela_id')::uuid, (a->>'acordo_id')::uuid,
         coalesce(nullif(p->>'boleto',''), 'Acordo ' || coalesce(a->>'numero_acordo','') || ' parc. ' || (p->>'numero')),
         (p->>'vencimento')::date, (p->>'valor')::numeric
    from jsonb_array_elements(v_conf->'acordos') a, jsonb_array_elements(a->'parcelas') p;

  select count(*) into v_n from public.juridico_casos_titulos where caso_id = p_caso_id and ativo;
  if v_n = 0 then
    raise exception 'Nenhum título elegível para aprovar.' using errcode = 'P0001';
  end if;

  select jsonb_build_object(
           'aluno', jsonb_build_object('status_atual', al.status_atual,
                                       'status_jornada', al.status_jornada,
                                       'status_acionamento', al.status_acionamento),
           'casos', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'status_atual', c.status_atual))
                                from public.casos c
                               where c.aluno_id = al.id
                                 and upper(coalesce(c.status_atual,'')) <> 'JURIDICO'), '[]'::jsonb))
    into v_ant
    from public.alunos al where al.id = v_caso.aluno_id;

  -- BLOQUEIO: o mesmo estado que a tabulacao JURIDICO grava.
  update public.alunos
     set status_atual = 'JURIDICO', status_jornada = 'JURIDICO', status_acionamento = 'JURIDICO'
   where id = v_caso.aluno_id;

  if public.aluno_bloqueio_administrativo(v_caso.aluno_id) is distinct from 'JURIDICO' then
    raise exception 'O bloqueio de cobrança não foi efetivado para o aluno %. Aprovação desfeita.', v_caso.aluno_id
      using errcode = 'P0001';
  end if;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email)
  values (v_caso.aluno_id::text, 'JURIDICO_APROVADO',
          'Aprovado para análise de ajuizamento. Cobrança bloqueada (manual, massiva e automática). Títulos não foram cancelados.',
          v_ant->'aluno'->>'status_atual', 'JURIDICO', v_email, v_email);

  update public.juridico_casos
     set status = 'APROVADO', aprovado_por = v_email, aprovado_em = now(),
         valor_aprovado = (v_conf->>'total')::numeric, bloqueio_anterior = v_ant
   where id = p_caso_id;

  perform public._juridico_registrar(p_caso_id, v_caso.lote_id, 'CASO_APROVADO',
    jsonb_build_object('valor', v_conf->'total', 'titulos', v_n,
                       'termo', v_conf->'termo'->>'status'), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'status', 'APROVADO',
                            'valor', v_conf->'total', 'titulos', v_n);
end;
$function$;

-- Payload do Excel: so casos aprovados em diante. Nunca caso em analise.
create function public._juridico_lote_payload(p_lote_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object(
    'lote_id', l.id, 'protocolo', l.protocolo, 'qtd_solicitada', l.qtd_solicitada,
    'criado_em', l.criado_em, 'enviado_financeiro_em', l.enviado_financeiro_em,
    'casos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'caso_id', jc.id, 'status', jc.status,
               'aluno', al.nome, 'cpf', al.cpf, 'matricula', al.matricula,
               'curso', al.curso, 'unidade', al.unidade,
               'situacao_academica', coalesce(al.situacao_academica, jc.situacao_academica),
               'valor_aprovado', jc.valor_aprovado,
               'aprovado_em', jc.aprovado_em, 'aprovado_por', jc.aprovado_por,
               'acordo_ativo_motivo', jc.acordo_ativo_motivo,
               'documento', case when jc.doc_manual_em is not null then 'Vinculado manualmente (' || jc.doc_manual_origem || ')'
                                 when jc.doc_autorizado_em is not null then 'Pendência autorizada pelo jurídico'
                                 else 'Conferido no CRM / não se aplica' end,
               'documento_ref', jc.doc_manual_ref,
               'documento_autorizacao', jc.doc_autorizado_motivo,
               'titulos', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'tipo', jt.tipo, 'documento', jt.documento, 'vencimento', jt.vencimento,
                          'valor', jt.valor, 'acordo_numero', ac.numero_acordo,
                          'acordo_ulbra', ac.numero_ulbra, 'acordo_status', ac.status)
                        order by jt.tipo, jt.vencimento)
                   from public.juridico_casos_titulos jt
                   left join public.acordos ac on ac.id = jt.acordo_id
                  where jt.caso_id = jc.id and jt.ativo), '[]'::jsonb))
             order by al.nome)
        from public.juridico_casos jc
        join public.alunos al on al.id = jc.aluno_id
       where jc.lote_id = l.id
         and jc.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')), '[]'::jsonb))
    from public.juridico_lotes l
   where l.id = p_lote_id;
$function$;

create function public.juridico_lote_exportar(p_lote_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v jsonb;
begin
  v := public._juridico_lote_payload(p_lote_id);
  if v is null then raise exception 'Lote não encontrado.' using errcode = 'P0002'; end if;
  -- o Excel leva CPF completo: a geracao fica registrada
  perform public._juridico_registrar(null, p_lote_id, 'EXCEL_GERADO',
    jsonb_build_object('casos', jsonb_array_length(v->'casos')), v_email);
  return v;
end;
$function$;

create function public.juridico_lote_enviar_financeiro(p_lote_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_n int;
begin
  perform 1 from public.juridico_lotes where id = p_lote_id for update;
  if not found then raise exception 'Lote não encontrado.' using errcode = 'P0002'; end if;

  with alterados as (
    update public.juridico_casos
       set status = 'ENVIADO_FINANCEIRO', enviado_financeiro_em = now(), enviado_financeiro_por = v_email
     where lote_id = p_lote_id and status = 'APROVADO'
    returning id
  )
  select count(*) into v_n from alterados;

  if v_n = 0 and not exists (select 1 from public.juridico_casos
                              where lote_id = p_lote_id
                                and status in ('ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')) then
    raise exception 'Nenhum caso aprovado neste lote para enviar ao financeiro.' using errcode = 'P0001';
  end if;

  if v_n > 0 then
    update public.juridico_lotes
       set enviado_financeiro_em = coalesce(enviado_financeiro_em, now()),
           enviado_financeiro_por = coalesce(enviado_financeiro_por, v_email)
     where id = p_lote_id;
    perform public._juridico_registrar(null, p_lote_id, 'LOTE_ENVIADO_FINANCEIRO',
      jsonb_build_object('casos', v_n), v_email);
  end if;

  return public._juridico_lote_payload(p_lote_id) || jsonb_build_object('enviados_agora', v_n);
end;
$function$;

-- CONFIRMAR: registra que o caso foi ENCAMINHADO ao juridico. Nao e ajuizamento.
create function public.juridico_casos_confirmar_juridico(
  p_caso_ids uuid[], p_data date default null, p_observacao text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text := public._juridico_exigir_gestao(); v_n int;
  v_data date := coalesce(p_data, (now() at time zone 'America/Sao_Paulo')::date);
begin
  if p_caso_ids is null or array_length(p_caso_ids, 1) is null then
    raise exception 'Selecione ao menos um caso.' using errcode = '22023';
  end if;
  if exists (select 1 from public.juridico_casos
              where id = any(p_caso_ids) and status <> 'ENVIADO_FINANCEIRO') then
    raise exception 'Só casos já enviados ao financeiro podem ser confirmados como encaminhados ao jurídico.'
      using errcode = 'P0001';
  end if;

  with alterados as (
    update public.juridico_casos
       set status = 'CONFIRMADO_JURIDICO', confirmado_juridico_data = v_data,
           confirmado_juridico_em = now(), confirmado_juridico_por = v_email,
           confirmado_juridico_obs = nullif(btrim(coalesce(p_observacao,'')), '')
     where id = any(p_caso_ids) and status = 'ENVIADO_FINANCEIRO'
    returning id, lote_id
  ), hist as (
    insert into public.juridico_historico (caso_id, lote_id, evento, detalhe, por)
    select a.id, a.lote_id, 'ENCAMINHADO_AO_JURIDICO',
           jsonb_build_object('data', v_data, 'observacao', p_observacao,
                              'nota', 'Encaminhamento ao jurídico. Não indica ajuizamento.'), v_email
      from alterados a
    returning 1
  )
  select count(*) into v_n from hist;

  return jsonb_build_object('confirmados', v_n, 'data', v_data);
end;
$function$;

-- Painel da aba: indicadores, lotes e casos com a conferencia.
create function public.juridico_painel()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v jsonb;
begin
  perform public._juridico_exigir_gestao();

  select jsonb_build_object(
    'indicadores', (
      select jsonb_build_object(
        'em_analise', count(*) filter (where status = 'EM_ANALISE'),
        'aprovados', count(*) filter (where status = 'APROVADO'),
        'enviados_financeiro', count(*) filter (where status = 'ENVIADO_FINANCEIRO'),
        'confirmados_juridico', count(*) filter (where status = 'CONFIRMADO_JURIDICO'),
        'valor_em_analise', coalesce(sum(valor_previa) filter (where status = 'EM_ANALISE'), 0),
        'valor_bloqueado', coalesce(sum(valor_aprovado)
            filter (where status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')), 0))
        from public.juridico_casos),
    'lotes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'lote_id', l.id, 'protocolo', l.protocolo, 'qtd_solicitada', l.qtd_solicitada,
               'filtros', l.filtros, 'observacao', l.observacao,
               'criado_em', l.criado_em, 'criado_por', l.criado_por,
               'enviado_financeiro_em', l.enviado_financeiro_em,
               'casos_ativos', (select count(*) from public.juridico_casos jc
                                 where jc.lote_id = l.id and jc.status <> 'REMOVIDO'))
             order by l.criado_em desc)
        from public.juridico_lotes l), '[]'::jsonb),
    'casos', coalesce((
      select jsonb_agg(z.j order by z.criado_em desc, z.nome)
        from (
          select jc.criado_em, al.nome,
                 jsonb_build_object(
                   'caso_id', jc.id, 'lote_id', jc.lote_id, 'protocolo', l.protocolo,
                   'status', jc.status, 'aluno_id', jc.aluno_id,
                   'aluno', al.nome, 'matricula', al.matricula, 'curso', al.curso,
                   'situacao_academica', coalesce(al.situacao_academica, jc.situacao_academica),
                   'grupo', jc.grupo, 'semestre_divida', jc.semestre_divida,
                   'valor_previa', jc.valor_previa, 'valor_aprovado', jc.valor_aprovado,
                   'acordo_ativo_aprovado_em', jc.acordo_ativo_aprovado_em,
                   'acordo_ativo_motivo', jc.acordo_ativo_motivo,
                   'doc_manual', case when jc.doc_manual_em is null then null else
                       jsonb_build_object('nome', jc.doc_manual_nome, 'referencia', jc.doc_manual_ref,
                                          'origem', jc.doc_manual_origem, 'em', jc.doc_manual_em) end,
                   'doc_autorizado_em', jc.doc_autorizado_em,
                   'doc_autorizado_motivo', jc.doc_autorizado_motivo,
                   'aprovado_em', jc.aprovado_em,
                   'enviado_financeiro_em', jc.enviado_financeiro_em,
                   'confirmado_juridico_data', jc.confirmado_juridico_data,
                   'confirmado_juridico_obs', jc.confirmado_juridico_obs,
                   'removido_motivo', jc.removido_motivo,
                   'conferencia', cf.c,
                   'pendencias', case when jc.status = 'EM_ANALISE'
                                      then to_jsonb(public._juridico_pendencias(jc, cf.c))
                                      else '[]'::jsonb end,
                   'titulos_aprovados', (select count(*) from public.juridico_casos_titulos jt
                                          where jt.caso_id = jc.id and jt.ativo)
                 ) as j
            from public.juridico_casos jc
            join public.juridico_lotes l on l.id = jc.lote_id
            join public.alunos al on al.id = jc.aluno_id
            left join lateral (
              select case when jc.status = 'EM_ANALISE'
                          then public._juridico_conferencia(jc.aluno_id) end as c) cf on true
           where jc.status <> 'REMOVIDO'
        ) z), '[]'::jsonb)
  ) into v;
  return v;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. GRANTS -- funcao nova nasce com EXECUTE para PUBLIC: fecha e reabre so
--    o necessario. Internas (`_juridico_*`) nao sao chamaveis pela API.
-- ---------------------------------------------------------------------------
do $grants$
declare r record;
begin
  for r in
    select p.oid::regprocedure as assinatura, p.proname
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'juridico\_%' or p.proname like '\_juridico\_%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.assinatura);
    if r.proname not like '\_%' then
      execute format('grant execute on function %s to authenticated', r.assinatura);
    end if;
  end loop;
end
$grants$;

-- ---------------------------------------------------------------------------
-- 5. ASSEGURACAO
-- ---------------------------------------------------------------------------
do $prova$
declare v_n int;
begin
  select count(*) into v_n
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname like 'juridico\_%' or p.proname like '\_juridico\_%')
     and (has_function_privilege('anon', p.oid, 'execute')
       or (p.proname like '\_%' and has_function_privilege('authenticated', p.oid, 'execute'))
       or not coalesce(p.proconfig @> array['search_path=public'], false));
  if v_n > 0 then
    raise exception 'juridico: % funcao(oes) com grant indevido ou sem search_path fixo.', v_n;
  end if;

  select count(*) into v_n
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('juridico_lotes','juridico_casos','juridico_casos_titulos','juridico_historico')
     and (not c.relrowsecurity
       or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate')
       or has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate'));
  if v_n > 0 then
    raise exception 'juridico: % tabela(s) sem RLS ou com grant direto.', v_n;
  end if;
end
$prova$;

commit;
