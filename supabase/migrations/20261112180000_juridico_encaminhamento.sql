-- ============================================================================
-- JURIDICO -- selecao, conferencia, aprovacao, bloqueio e encaminhamento
-- ----------------------------------------------------------------------------
-- Pedido da gestao em 12/11/2026: quando o juridico solicitar N alunos,
-- selecionar os melhores candidatos da carteira (titulos de 2025/1 em diante),
-- conferir valores e documentos, aprovar, BLOQUEAR A COBRANCA e gerar o Excel
-- do financeiro; depois registrar que o caso foi encaminhado ao juridico.
--
-- O QUE E REAPROVEITADO, e por que nao ha mecanismo de bloqueio novo:
--   * BLOQUEIO (decisao da gestao): a aprovacao NAO grava status JURIDICO. Ela liga
--     `casos.nao_acionar` nos casos do aluno: a cobranca fica bloqueada (portao
--     `aluno_bloqueio_administrativo` devolve NAO_ACIONAR_EXPLICITO) e o aluno
--     PERMANECE na carteira, com responsavel e historico. Gravar JURIDICO em
--     `alunos.status_*` acionaria `alunos_propaga_encerramento_para_caso` ->
--     `casos.encerrado_operacional` (sai da carteira) e foi evitado de proposito.
--     A guarda `_juridico_guarda_nao_acionar` impede liberar esse bloqueio fora da
--     remocao do caso; `_juridico_divergencias` recusa envio se o bloqueio cair.
--     Os 69 alunos com status JURIDICO historico (tabulacao) NAO sao alterados.
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
  -- IDs de TODOS os acordos ATIVOS do aluno no momento da aprovacao.
  -- Base do sinal ACORDO_NOVO (novo ou reativado depois da aprovacao).
  acordos_aprovados uuid[] not null default '{}',
  -- assinatura das condicoes materiais dos acordos ATIVOS na aprovacao (nulo ate aprovar)
  acordos_assinatura text,
  -- termo que sustentou a aprovacao (termos_acordo.id); a validade e checada por ele
  termo_aprovado_id uuid,
  -- IDs dos acordos ATIVOS que a gestao revisou (na geracao ou na ultima aprovacao
  -- de acordo ativo). Acordo fora dessa base bloqueia a aprovacao.
  acordos_na_geracao uuid[] not null default '{}',
  -- revisao financeira de acordo QUEBRADO (decisao da gestao): quais acordos, saldo
  -- confirmado, quem, quando e por que. Pendencia se o conjunto ou o saldo mudar.
  quebrado_revisado_ids uuid[] not null default '{}',
  quebrado_revisado_saldo numeric(14,2),
  -- conjunto de DIVIDAS ELEGIVEIS revisado: parcelas VENCIDAS dos acordos ativos do aluno.
  -- Parcela nova vencida que muda este conjunto exige nova revisao, mesmo com o saldo igual.
  quebrado_revisado_parcelas uuid[] not null default '{}',
  quebrado_revisado_por text,
  quebrado_revisado_em timestamptz,
  quebrado_revisado_motivo text,
  bloqueio_anterior jsonb,
  -- true quando OUTRO fluxo gravou nao_acionar=true durante o encaminhamento: a remocao nao libera essa flag
  bloqueio_compartilhado boolean not null default false,
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
create index juridico_casos_aluno on public.juridico_casos (aluno_id);

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
revoke all on sequence public.juridico_protocolo_seq, public.juridico_historico_id_seq
  from public, anon, authenticated;

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
           'valor', round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2))
           order by t.vencimento, t.documento), '[]'::jsonb),
         coalesce(sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2)), 0)
    into v_mens, v_total_mens
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) = 'ABERTO'
     and coalesce(lower(t.status),'') <> 'quitada'
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and t.origem_encerramento is null
     and t.vencimento >= date '2025-01-01'
     and t.vencimento < (now() at time zone 'America/Sao_Paulo')::date
     and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

  -- Mensalidade INCORPORADA a acordo: aparece, mas NAO soma.
  select count(*), coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 0),
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
    'quebrados', jsonb_build_object(
      'ids', (select coalesce(jsonb_agg(e->>'acordo_id' order by e->>'acordo_id'), '[]'::jsonb)
                from jsonb_array_elements(v_acordos) e where e->>'situacao' = 'QUEBRADO'),
      'saldo', (select round(coalesce(sum((e->>'saldo')::numeric), 0), 2)
                  from jsonb_array_elements(v_acordos) e where e->>'situacao' = 'QUEBRADO')),
    'acordos_cancelados', v_cancelados,
    'titulos_em_confirmacao', v_em_conf,
    'pagamento_pendente', v_pag_pend,
    'termo', v_termo,
    'total', round(v_total_mens + v_total_acordo, 2),
    'bloqueio', public.aluno_bloqueio_administrativo(p_aluno_id),
    'pagamento_nao_baixado', public._juridico_pagamento_nao_baixado(p_aluno_id));
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
  if (p_conf->>'pagamento_nao_baixado')::boolean then
    v := array_append(v, '!PAGAMENTO_NAO_BAIXADO'); end if;
  if coalesce((p_conf->>'total')::numeric, 0) <= 0 then
    v := array_append(v, '!SEM_SALDO_ELEGIVEL'); end if;
  if p_caso.status = 'EM_ANALISE' and p_conf->>'bloqueio' is not null then
    v := array_append(v, '!BLOQUEIO_ADMINISTRATIVO:' || (p_conf->>'bloqueio')); end if;
  if (p_conf->>'acordo_ativo_em_dia')::boolean and p_caso.acordo_ativo_aprovado_em is null then
    v := array_append(v, 'ACORDO_ATIVO_SEM_APROVACAO'); end if;
  -- acordo ATIVO criado ou reativado depois da revisao: so sai com aprovacao especifica
  if exists (select 1 from public.acordos a
              where a.aluno_id = p_caso.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO'
                and a.duplicado_de is null and not (a.id = any(p_caso.acordos_na_geracao))) then
    v := array_append(v, 'ACORDO_NOVO_APOS_GERACAO'); end if;
  -- acordo QUEBRADO: exige revisao financeira; conjunto e saldo precisam bater com a revisao
  if exists (select 1 from jsonb_array_elements(p_conf->'acordos') a where a->>'situacao' = 'QUEBRADO')
     and (
       (select coalesce(array_agg((a->>'acordo_id')::uuid order by (a->>'acordo_id')::uuid), '{}'::uuid[])
          from jsonb_array_elements(p_conf->'acordos') a where a->>'situacao' = 'QUEBRADO')
       is distinct from (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(p_caso.quebrado_revisado_ids) x)
       or (select coalesce(sum((a->>'saldo')::numeric), 0) from jsonb_array_elements(p_conf->'acordos') a
            where a->>'situacao' = 'QUEBRADO') is distinct from p_caso.quebrado_revisado_saldo
       -- conjunto de dividas elegiveis (parcelas vencidas): parcela nova vencida muda o conjunto
       or (select coalesce(array_agg(y.x order by y.x), '{}'::uuid[])
             from (select (p->>'parcela_id')::uuid x from jsonb_array_elements(p_conf->'acordos') a,
                                                          jsonb_array_elements(a->'parcelas') p
                    where a->>'situacao' = 'QUEBRADO' and upper(p->>'status') = 'VENCIDA') y)
          is distinct from (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(p_caso.quebrado_revisado_parcelas) x)
       -- regularizou e quebrou de novo depois da revisao, com as mesmas condicoes e o mesmo saldo
       or exists (select 1 from public.juridico_historico h
                   where h.caso_id = p_caso.id and h.evento = 'PARCELA_QUEBROU'
                     and h.em > coalesce(p_caso.quebrado_revisado_em, '-infinity'::timestamptz))
     ) then
    v := array_append(v, 'ACORDO_QUEBRADO_SEM_REVISAO'); end if;

  -- acordo que estava na base, foi cancelado e voltou a ATIVO desde a ultima revisao
  if exists (select 1 from public.juridico_historico h
              where h.caso_id = p_caso.id and h.evento = 'ACORDO_STATUS'
                and h.detalhe->>'depois' = 'ATIVO' and h.detalhe->>'antes' is distinct from 'ATIVO'
                and h.em > coalesce(p_caso.acordo_ativo_aprovado_em, p_caso.criado_em)) then
    v := array_append(v, 'ACORDO_REATIVADO_APOS_GERACAO'); end if;
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

-- Pagamento recebido e ainda nao baixado, por conjunto de alunos (null = todos).
-- MEDIDO em producao em 12/11/2026 (leitura; consultas em
-- docs/juridico/consultas-n1-n4-2026-11-12.sql): a regra antiga barrava 2.382
-- alunos; a atual barra 24. O prazo de 30 dias LIBERA 2.346 deles (o pagamento
-- no extrato e de mais de 30 dias apos o vencimento). NEGOCIADO no sinal (c)
-- libera 12 e no sinal (a) nenhum. Liquidacao de titulo negociado e o ACORDO,
-- nao pagamento. Criterio de 30 dias: so muda por decisao expressa da gestao.
-- Sinais:
--   (a) pagamento registrado contra titulo ABERTO do aluno;
--   (b) pagamento registrado contra o boleto de parcela viva de acordo ATIVO;
--   (c) extrato Prime: ULTIMO registro do boleto+CPF de titulo ABERTO, com
--       valor pago, liquidado mais de 30 dias apos o vencimento e depois da
--       importacao do titulo.
-- Diferenca para a massiva, de proposito: la o aluno so sai se TODOS os
-- titulos estiverem liquidados e >= 50% pago; aqui basta UM titulo -- na
-- duvida, nao se encaminha ao juridico.
-- NOTA DE CUSTO (D1 corrigido 12/11): funcoes plpgsql com dois ramos evitam
-- plano generico com Seq Scan em acordos_titulos no PostgreSQL 17.
-- SQL SECURITY DEFINER nao e inlinada pelo planner; o OR IS NULL resultava em
-- varredura completa da tabela a cada caso. Com plpgsql o ramo nao-nulo usa
-- = ANY(p_aluno_ids) e recebe plano especifico com index scan.
create function public._juridico_pagamento_nao_baixado_ids(p_aluno_ids uuid[])
returns setof uuid
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if p_aluno_ids is null then
    return query
      select t.aluno_id
        from public.acordos_titulos t
        join public.pagamentos pg on pg.aluno_id = t.aluno_id and pg.titulo_numero = t.documento
       where upper(coalesce(t.situacao,'')) = 'ABERTO'
         and coalesce(lower(t.status),'') <> 'quitada'
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
      union
      select a.aluno_id
        from public.acordos a
        join public.parcelas p on p.acordo_id = a.id
        join public.pagamentos pg on pg.aluno_id = a.aluno_id
             and (pg.numero_parcela_completo = p.boleto or pg.titulo_numero = p.boleto)
       where upper(coalesce(a.status,'')) = 'ATIVO'
         and upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')
         and coalesce(btrim(p.boleto),'') <> ''
      union
      select t.aluno_id
        from public.acordos_titulos t
        join lateral (
          select e.liquidado_em, e.valor_pago
            from public.prime_extrato e
           where e.boleto = regexp_replace(coalesce(t.documento,''), '\D', '', 'g') and e.cpf = t.cpf
           order by e.coletado_em desc limit 1) e on true
       where upper(coalesce(t.situacao,'')) = 'ABERTO'
         and coalesce(lower(t.status),'') <> 'quitada'
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
         and e.liquidado_em is not null
         and coalesce(e.valor_pago, 0) > 0
         and e.liquidado_em > t.vencimento + 30
         and e.liquidado_em >= t.created_at::date;
  else
    return query
      select t.aluno_id
        from public.acordos_titulos t
        join public.pagamentos pg on pg.aluno_id = t.aluno_id and pg.titulo_numero = t.documento
       where t.aluno_id = any(p_aluno_ids)
         and upper(coalesce(t.situacao,'')) = 'ABERTO'
         and coalesce(lower(t.status),'') <> 'quitada'
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
      union
      select a.aluno_id
        from public.acordos a
        join public.parcelas p on p.acordo_id = a.id
        join public.pagamentos pg on pg.aluno_id = a.aluno_id
             and (pg.numero_parcela_completo = p.boleto or pg.titulo_numero = p.boleto)
       where a.aluno_id = any(p_aluno_ids)
         and upper(coalesce(a.status,'')) = 'ATIVO'
         and upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')
         and coalesce(btrim(p.boleto),'') <> ''
      union
      select t.aluno_id
        from public.acordos_titulos t
        join lateral (
          select e.liquidado_em, e.valor_pago
            from public.prime_extrato e
           where e.boleto = regexp_replace(coalesce(t.documento,''), '\D', '', 'g') and e.cpf = t.cpf
           order by e.coletado_em desc limit 1) e on true
       where t.aluno_id = any(p_aluno_ids)
         and upper(coalesce(t.situacao,'')) = 'ABERTO'
         and coalesce(lower(t.status),'') <> 'quitada'
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
         and e.liquidado_em is not null
         and coalesce(e.valor_pago, 0) > 0
         and e.liquidado_em > t.vencimento + 30
         and e.liquidado_em >= t.created_at::date;
  end if;
end;
$function$;

-- Escalar por aluno: filtra estritamente por = p_aluno_id para garantir
-- plano com index scan no PostgreSQL 17. Nao delega para _ids: plpgsql
-- dentro de SECURITY DEFINER ainda planeja cada SQL internamente, e um
-- array de um elemento nao garante index scan. Tres EXISTS independentes
-- curto-circuitam no primeiro positivo.
create function public._juridico_pagamento_nao_baixado(p_aluno_id uuid)
returns boolean
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  return
    exists (
      select 1
        from public.acordos_titulos t
        join public.pagamentos pg on pg.aluno_id = t.aluno_id and pg.titulo_numero = t.documento
       where t.aluno_id = p_aluno_id
         and upper(coalesce(t.situacao,'')) = 'ABERTO'
         and coalesce(lower(t.status),'') <> 'quitada'
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
    ) or exists (
      select 1
        from public.acordos a
        join public.parcelas p on p.acordo_id = a.id
        join public.pagamentos pg on pg.aluno_id = a.aluno_id
             and (pg.numero_parcela_completo = p.boleto or pg.titulo_numero = p.boleto)
       where a.aluno_id = p_aluno_id
         and upper(coalesce(a.status,'')) = 'ATIVO'
         and upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')
         and coalesce(btrim(p.boleto),'') <> ''
    ) or exists (
      select 1
        from public.acordos_titulos t
        join lateral (
          select e.liquidado_em, e.valor_pago
            from public.prime_extrato e
           where e.boleto = regexp_replace(coalesce(t.documento,''), '\D', '', 'g') and e.cpf = t.cpf
           order by e.coletado_em desc limit 1) e on true
       where t.aluno_id = p_aluno_id
         and upper(coalesce(t.situacao,'')) = 'ABERTO'
         and coalesce(lower(t.status),'') <> 'quitada'
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
         and e.liquidado_em is not null
         and coalesce(e.valor_pago, 0) > 0
         and e.liquidado_em > t.vencimento + 30
         and e.liquidado_em >= t.created_at::date
    );
end;
$function$;

-- Assinatura das condicoes MATERIAIS dos acordos ATIVOS do aluno: valor total, numero de
-- parcelas, forma e entrada, e de cada parcela numero, valor e vencimento. Fica de fora o que e
-- so cadastral (observacao, responsavel, datas), o BOLETO (rotinas de amarracao o reescrevem sem
-- mudar o acordo) e o STATUS da parcela (pagamento e quebra tem divergencia propria).
create function public._juridico_acordos_assinatura(p_aluno_id uuid)
returns text
language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(md5(string_agg(x.linha, '|' order by x.linha)), '')
    from (
      select a.id::text || ':' || coalesce(round(a.valor_total, 2)::text, '') || ':' || coalesce(a.qtd_parcelas::text, '')
             || ':' || coalesce(to_jsonb(a)->>'forma_pagamento', '') || ':' || coalesce(round((to_jsonb(a)->>'valor_entrada')::numeric, 2)::text, '')
             || ':' || coalesce(to_jsonb(a)->>'data_entrada', '') || ':'
             || coalesce((select string_agg(p.id::text || ',' || coalesce(p.numero::text, '') || ',' || coalesce(round(p.valor, 2)::text, '')
                                             || ',' || coalesce(p.vencimento::text, ''),
                                             ';' order by p.numero, p.id)
                            from public.parcelas p where p.acordo_id = a.id), '') as linha
        from public.acordos a
       where a.aluno_id = p_aluno_id and upper(coalesce(a.status, '')) = 'ATIVO' and a.duplicado_de is null) x;
$function$;

-- Divergencias de um caso depois da aprovacao. Usada pelo envio (recusa),
-- pela tela (mostra) e pelo alerta (registra no historico, sem apagar nada).
create function public._juridico_divergencias(p_caso public.juridico_casos)
returns text[]
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v text[] := '{}'::text[];
begin
  -- O bloqueio de cobranca tem que continuar valendo enquanto o caso estiver encaminhado.
  if p_caso.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')
     and public.aluno_bloqueio_administrativo(p_caso.aluno_id) is null then
    v := array_append(v, 'BLOQUEIO_PERDIDO');
  end if;

  if exists (
    select 1
      from public.juridico_casos_titulos jt
      left join public.acordos_titulos t on t.id = jt.titulo_id
     where jt.caso_id = p_caso.id and jt.ativo and jt.tipo = 'MENSALIDADE'
       and (t.id is null or upper(coalesce(t.situacao,'')) <> 'ABERTO'
            or coalesce(lower(t.status),'') = 'quitada' or t.origem_encerramento is not null
            or round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2) is distinct from jt.valor)
  ) then v := array_append(v, 'MENSALIDADE_ALTERADA'); end if;

  if exists (
    select 1
      from public.juridico_casos_titulos jt
      left join public.parcelas p on p.id = jt.parcela_id
      left join public.acordos a on a.id = p.acordo_id
     where jt.caso_id = p_caso.id and jt.ativo and jt.tipo = 'PARCELA_ACORDO'
       and (p.id is null or upper(coalesce(p.status,'')) not in ('A_VENCER','VENCIDA')
            or upper(coalesce(a.status,'')) <> 'ATIVO' or a.duplicado_de is not null
            or round(coalesce(p.valor,0), 2) is distinct from jt.valor)
  ) then v := array_append(v, 'PARCELA_ALTERADA'); end if;

  -- Acordo ATIVO que NAO estava no conjunto registrado na aprovacao: novo, ou
  -- cancelado na aprovacao e reativado depois. Compara IDs, nunca datas
  -- (criado_em e atualizado_em nao distinguem reativacao de edicao comum).
  if exists (
    select 1 from public.acordos a
     where a.aluno_id = p_caso.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO'
       and a.duplicado_de is null
       and not (a.id = any(p_caso.acordos_aprovados))
  ) then v := array_append(v, 'ACORDO_NOVO'); end if;

  -- acordo ATIVO EM DIA (sem parcela vencida) sem a aprovacao especifica de acordo ativo:
  -- ex.: acordo quebrado na aprovacao e regularizado depois. Mesma regra da pendencia.
  if p_caso.acordo_ativo_aprovado_em is null and exists (
    select 1 from public.acordos a
     where a.aluno_id = p_caso.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null
       and not exists (select 1 from public.parcelas p
                        where p.acordo_id = a.id and upper(coalesce(p.status,'')) = 'VENCIDA')
  ) then v := array_append(v, 'ACORDO_ATIVO_SEM_APROVACAO'); end if;

  -- acordo QUEBRADO depois da aprovacao sem revisao financeira que bata (conjunto e saldo)
  if exists (
    select 1 from (
      select coalesce(array_agg(q.id order by q.id), '{}'::uuid[]) as ids, coalesce(sum(q.saldo), 0) as saldo
        from (select a.id,
                     round(coalesce(sum(p.valor) filter (where upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA')), 0), 2) as saldo
                from public.acordos a join public.parcelas p on p.acordo_id = a.id
               where a.aluno_id = p_caso.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null
               group by a.id
              having count(*) filter (where upper(coalesce(p.status,'')) = 'VENCIDA') > 0) q) v
     where array_length(v.ids, 1) > 0
       and (v.ids is distinct from (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(p_caso.quebrado_revisado_ids) x)
            or v.saldo is distinct from p_caso.quebrado_revisado_saldo
            or (select coalesce(array_agg(pv.id order by pv.id), '{}'::uuid[])
                  from public.parcelas pv join public.acordos av on av.id = pv.acordo_id
                 where av.aluno_id = p_caso.aluno_id and upper(coalesce(av.status,'')) = 'ATIVO'
                   and av.duplicado_de is null and upper(coalesce(pv.status,'')) = 'VENCIDA')
               is distinct from (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(p_caso.quebrado_revisado_parcelas) x)
            -- regularizado e quebrou de novo com as mesmas condicoes: o historico das parcelas sabe
            or exists (select 1 from public.juridico_historico h
                        where h.caso_id = p_caso.id and h.evento = 'PARCELA_QUEBROU'
                          and h.em > greatest(coalesce(p_caso.quebrado_revisado_em, p_caso.aprovado_em), p_caso.aprovado_em)))
  ) then v := array_append(v, 'ACORDO_QUEBRADO_SEM_REVISAO'); end if;

  -- acordo que estava ATIVO na aprovacao, foi cancelado e voltou a ATIVO: so o historico sabe
  if exists (
    select 1 from public.juridico_historico h
     where h.caso_id = p_caso.id and h.evento = 'ACORDO_STATUS'
       and h.detalhe->>'depois' = 'ATIVO' and h.detalhe->>'antes' is distinct from 'ATIVO'
       and h.em > p_caso.aprovado_em
  ) then v := array_append(v, 'ACORDO_REATIVADO'); end if;

  -- condicoes materiais do acordo mudaram com os mesmos IDs (vencimento, valor, parcelas...)
  -- (inclui valor ou vencimento de parcela alterado e depois revertido: o historico guarda a marca)
  if p_caso.acordos_assinatura is not null
     and (public._juridico_acordos_assinatura(p_caso.aluno_id) is distinct from p_caso.acordos_assinatura
          or exists (select 1 from public.juridico_historico h
                      where h.caso_id = p_caso.id and h.evento = 'PARCELA_MATERIAL' and h.em > p_caso.aprovado_em)) then
    v := array_append(v, 'ACORDO_CONDICOES_ALTERADAS'); end if;

  -- termo: aprovado com acordo, sem documento vinculado nem autorizacao, o termo deixou de
  -- atender (rejeitado, removido ou fora da etapa COMPLETO com arquivo final)
  -- O termo avaliado e o que sustentou a aprovacao (termo_aprovado_id), nao qualquer termo do aluno.
  if p_caso.termo_aprovado_id is not null
     and p_caso.doc_manual_em is null and p_caso.doc_autorizado_em is null
     and not exists (select 1 from public.termos_acordo ta
                      where ta.id = p_caso.termo_aprovado_id and coalesce(ta.status, '') <> 'TERMO_REJEITADO'
                        and ta.etapa_assinatura = 'COMPLETO' and ta.arquivo_final_url is not null) then
    v := array_append(v, 'TERMO_INVALIDADO'); end if;

  -- qualquer titulo do aluno em confirmacao, mesmo fora da fotografia (indice parcial por aluno)
  if exists (select 1 from public.acordos_titulos t
              where t.aluno_id = p_caso.aluno_id and upper(coalesce(t.situacao, '')) = 'EM_CONFIRMACAO') then
    v := array_append(v, 'TITULO_EM_CONFIRMACAO'); end if;

  if public._juridico_pagamento_nao_baixado(p_caso.aluno_id) then
    v := array_append(v, 'PAGAMENTO_NAO_BAIXADO');
  end if;

  if exists (select 1 from public.solicitacoes_confirmacao_pagamento s
              where s.aluno_id = p_caso.aluno_id::text
                and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) then
    v := array_append(v, 'PAGAMENTO_AGUARDANDO_CONFIRMACAO');
  end if;
  return v;
end;
$function$;

-- Ranking de candidatos. Interna: a porta de gestao esta em quem chama.
create function public._juridico_candidatos(
  p_limite integer, p_ano integer, p_semestre integer, p_grupos text[], p_excluir uuid[])
returns table (
  aluno_id uuid, nome text, matricula text, curso text, situacao_academica text,
  grupo text, semestre_divida text, prioridade integer,
  valor_mensalidades numeric, valor_acordos numeric, valor_total numeric,
  qtd_titulos integer, tem_acordo_ativo boolean)
language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  r record;
  v_n int := 0;
  v_lim int := greatest(coalesce(p_limite, 0), 0);
begin
  -- Os filtros de bloqueio e de pagamento nao baixado sao avaliados ANTES de
  -- contar o limite: o lote sai com o pedido, quando houver elegiveis.
  for r in

  with tit as materialized (
    select t.aluno_id as tid,
           sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2)) as v,
           count(*)::int as n
      from public.acordos_titulos t
     where upper(coalesce(t.situacao,'')) = 'ABERTO'
       and coalesce(lower(t.status),'') <> 'quitada'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and t.origem_encerramento is null
       and t.vencimento >= date '2025-01-01'
       and t.vencimento < (now() at time zone 'America/Sao_Paulo')::date
       and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
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
  pago as materialized (
    select x as pid from public._juridico_pagamento_nao_baixado_ids(null) x
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
       and not exists (select 1 from pago where pago.pid = al.id)
       -- pre-filtro barato; o portao canonico continua sendo conferido no laco
       and upper(replace(coalesce(al.status_atual,''), ' ', '_')) not in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA')
       and upper(replace(coalesce(al.status_jornada,''), ' ', '_')) not in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA')
       and not exists (select 1 from public.juridico_casos jc
                        where jc.aluno_id = al.id and jc.status <> 'REMOVIDO')
       and not exists (select 1 from public.acordos_titulos t2
                        where t2.aluno_id = al.id and upper(coalesce(t2.situacao,'')) = 'EM_CONFIRMACAO')
       and not exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                        where s.aluno_id = al.id::text
                          and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))
     order by 8, coalesce(tit.v, 0) + coalesce(aco.v_quebrado, 0) desc, al.id
  )
  select r.id, r.nome, r.matricula, r.curso, r.situacao_academica, r.grupo, r.semestre_divida,
         r.prioridade, r.v_mens, r.v_aco, r.n, r.tem
    from ranqueado r
   order by r.prioridade, r.v_mens + r.v_aco desc, r.id
  loop
    exit when v_n >= v_lim;
    continue when public.aluno_bloqueio_administrativo(r.id) is not null;
    v_n := v_n + 1;
    aluno_id := r.id; nome := r.nome; matricula := r.matricula; curso := r.curso;
    situacao_academica := r.situacao_academica; grupo := r.grupo; semestre_divida := r.semestre_divida;
    prioridade := r.prioridade; valor_mensalidades := r.v_mens; valor_acordos := r.v_aco;
    valor_total := r.v_mens + r.v_aco; qtd_titulos := r.n; tem_acordo_ativo := r.tem;
    return next;
  end loop;
end;
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
    (lote_id, aluno_id, grupo, situacao_academica, semestre_divida, valor_previa, criado_por, acordos_na_geracao)
  select v_lote, c.aluno_id, c.grupo, c.situacao_academica, c.semestre_divida, c.valor_total, v_email,
         coalesce((select array_agg(a.id) from public.acordos a where a.aluno_id = c.aluno_id
                    and upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null), '{}'::uuid[])
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
returns text
language plpgsql security definer set search_path to 'public'
as $function$
declare v_comp boolean;
begin
  if p_caso.bloqueio_anterior is null or jsonb_typeof(p_caso.bloqueio_anterior) <> 'array' then return 'LIBERADO'; end if;

  -- Se outro fluxo tambem ligou nao_acionar durante o encaminhamento, a flag NAO e deste fluxo:
  -- fica ligada (o bloqueio dele continua). Ver _juridico_marca_bloqueio_compartilhado.
  select bloqueio_compartilhado into v_comp from public.juridico_casos where id = p_caso.id;
  if coalesce(v_comp, false) then return 'MANTIDO_OUTRO_BLOQUEIO'; end if;

  -- Unica porta que libera nao_acionar: a guarda de casos so deixa passar com esta GUC.
  perform set_config('juridico.desbloqueio', 'on', true);

  -- Restaura SO os casos que estavam livres antes da aprovacao. Quem ja estava bloqueado
  -- por outro motivo (nao_acionar anterior = true) continua bloqueado.
  update public.casos c
     set nao_acionar = false
    from jsonb_to_recordset(p_caso.bloqueio_anterior) as x(id uuid, nao_acionar boolean)
   where c.id = x.id and c.aluno_id = p_caso.aluno_id
     and coalesce(x.nao_acionar, false) = false and c.nao_acionar = true;

  perform set_config('juridico.desbloqueio', '', true);

  -- Validacao e retorno pelo ESTADO REAL: nenhum caso que estava livre continua barrado.
  if exists (select 1 from public.casos c
               join jsonb_to_recordset(p_caso.bloqueio_anterior) as x(id uuid, nao_acionar boolean) on x.id = c.id
              where coalesce(x.nao_acionar, false) = false and c.nao_acionar = true) then
    raise exception 'Não foi possível levantar o bloqueio jurídico do aluno %. Nada foi alterado.', p_caso.aluno_id
      using errcode = 'P0001';
  end if;
  -- Se ainda sobra alguma flag ligada (ja estava ligada antes, ou outro fluxo a mantem), nao se diz "levantado".
  if exists (select 1 from public.casos c where c.aluno_id = p_caso.aluno_id and c.nao_acionar = true) then
    return 'MANTIDO_OUTRO_BLOQUEIO';
  end if;
  return 'LIBERADO';
end;
$function$;

create function public.juridico_caso_remover(p_caso_id uuid, p_motivo text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_caso public.juridico_casos; v_bloq text := null;
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
    v_bloq := public._juridico_desbloquear(v_caso);
    update public.juridico_casos_titulos set ativo = false where caso_id = p_caso_id and ativo;
    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email)
    values (v_caso.aluno_id::text, 'JURIDICO_BLOQUEIO_LEVANTADO',
            'Caso retirado da análise jurídica antes do envio ao financeiro. ' ||
            case when v_bloq = 'MANTIDO_OUTRO_BLOQUEIO' then 'Bloqueio de cobrança MANTIDO: ainda há bloqueio de cobrança ligado no caso (outro fluxo ou bloqueio anterior). '
                 else 'Bloqueio de cobrança levantado. ' end || 'Motivo: ' || btrim(p_motivo),
            null, null, v_email, v_email);
  end if;

  update public.juridico_casos
     set status = 'REMOVIDO', removido_em = now(), removido_por = v_email,
         removido_motivo = btrim(p_motivo)
   where id = p_caso_id;

  perform public._juridico_registrar(p_caso_id, v_caso.lote_id, 'CASO_REMOVIDO',
    jsonb_build_object('de', v_caso.status, 'motivo', btrim(p_motivo)), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'status', 'REMOVIDO',
                            'bloqueio', coalesce(v_bloq, 'NAO_HAVIA_BLOQUEIO'));
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
    (lote_id, aluno_id, grupo, situacao_academica, semestre_divida, valor_previa, criado_por, acordos_na_geracao)
  select v_caso.lote_id, c.aluno_id, c.grupo, c.situacao_academica, c.semestre_divida, c.valor_total, v_email,
         coalesce((select array_agg(a.id) from public.acordos a where a.aluno_id = c.aluno_id
                    and upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null), '{}'::uuid[])
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
  if v_caso.status not in ('EM_ANALISE','APROVADO') then
    raise exception 'Documento só é vinculado com o caso em análise ou aprovado (este está %).', v_caso.status using errcode = 'P0001';
  end if;

  update public.juridico_casos
     set doc_manual_nome = nullif(btrim(coalesce(p_nome,'')), ''),
         doc_manual_ref = btrim(p_referencia),
         doc_manual_origem = upper(p_origem),
         doc_manual_por = v_email, doc_manual_em = now()
   where id = p_caso_id;

  insert into public.juridico_documentos (caso_id, origem, nome, referencia, vinculado_por)
  values (p_caso_id, upper(p_origem), nullif(btrim(coalesce(p_nome,'')),''), btrim(p_referencia), v_email);

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

-- Revisao financeira de acordo QUEBRADO. A gestao confirma os acordos e o saldo que
-- viu. Nao cobra, nao baixa, nao cancela nem move carteira: so registra a revisao.
create function public.juridico_caso_revisar_acordo_quebrado(p_caso_id uuid, p_motivo text, p_acordos uuid[], p_saldo numeric, p_parcelas uuid[])
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_caso public.juridico_casos;
  v_conf jsonb; v_set uuid[]; v_saldo numeric; v_pset uuid[];
begin
  -- espera LIMITADA: nenhum conflito de trava fica pendurado; o erro reverte a transacao inteira
  set local lock_timeout = '3s';
  begin
  if nullif(btrim(coalesce(p_motivo,'')), '') is null then
    raise exception 'Informe a justificativa da revisão do acordo quebrado.' using errcode = '22023';
  end if;
  if p_acordos is null or p_saldo is null then
    raise exception 'Informe os acordos e o saldo confirmados.' using errcode = '22023';
  end if;
  select * into v_caso from public.juridico_casos where id = p_caso_id for update;
  if not found or v_caso.status <> 'EM_ANALISE' then
    raise exception 'Só caso em análise recebe revisão de acordo quebrado.' using errcode = 'P0001';
  end if;
  perform 1 from public.alunos where id = v_caso.aluno_id for update;
  v_conf := public._juridico_conferencia(v_caso.aluno_id);
  if coalesce((v_conf->>'pagamento_pendente')::boolean, false)
     or coalesce((v_conf->>'pagamento_nao_baixado')::boolean, false) then
    raise exception 'Há pagamento pendente ou não baixado: resolva antes de revisar o acordo.' using errcode = 'P0001';
  end if;
  select coalesce(array_agg((a->>'acordo_id')::uuid order by (a->>'acordo_id')::uuid), '{}'::uuid[]),
         coalesce(sum((a->>'saldo')::numeric), 0)
    into v_set, v_saldo
    from jsonb_array_elements(v_conf->'acordos') a where a->>'situacao' = 'QUEBRADO';
  if coalesce(array_length(v_set, 1), 0) = 0 then
    raise exception 'Não há acordo quebrado para revisar.' using errcode = 'P0001';
  end if;
  if (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(p_acordos) x) is distinct from v_set then
    raise exception 'A lista de acordos quebrados mudou. Recarregue a tela.' using errcode = 'P0001';
  end if;
  if round(p_saldo, 2) is distinct from round(v_saldo, 2) then
    raise exception 'O saldo exigível mudou (atual %). Recarregue a tela antes de revisar.', v_saldo using errcode = 'P0001';
  end if;
  select coalesce(array_agg(y.x order by y.x), '{}'::uuid[]) into v_pset
    from (select (p->>'parcela_id')::uuid x from jsonb_array_elements(v_conf->'acordos') a,
                                                 jsonb_array_elements(a->'parcelas') p
           where a->>'situacao' = 'QUEBRADO' and upper(p->>'status') = 'VENCIDA') y;
  if (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(coalesce(p_parcelas, '{}'::uuid[])) x) is distinct from v_pset then
    raise exception 'As parcelas vencidas mudaram. Recarregue a tela antes de revisar.' using errcode = 'P0001';
  end if;
  update public.juridico_casos
     set quebrado_revisado_ids = v_set, quebrado_revisado_saldo = v_saldo, quebrado_revisado_parcelas = v_pset,
         quebrado_revisado_por = v_email, quebrado_revisado_em = now(),
         quebrado_revisado_motivo = btrim(p_motivo)
   where id = p_caso_id;
  perform public._juridico_registrar(p_caso_id, v_caso.lote_id, 'ACORDO_QUEBRADO_REVISADO',
    jsonb_build_object('acordos', to_jsonb(v_set), 'saldo', v_saldo, 'motivo', btrim(p_motivo)), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'acordos', to_jsonb(v_set), 'saldo', v_saldo);
  exception when lock_not_available then
    raise exception 'Caso em uso por outra rotina (aluno, caso, acordo ou parcela). Nada foi gravado. Tente novamente em instantes.' using errcode = '40001';
  end;
end;

$function$;

create function public.juridico_caso_aprovar_acordo_ativo(p_caso_id uuid, p_motivo text, p_acordos uuid[])
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_lote uuid;
begin
  -- espera LIMITADA: nenhum conflito de trava fica pendurado; o erro reverte a transacao inteira
  set local lock_timeout = '3s';
  begin
  if nullif(btrim(coalesce(p_motivo,'')), '') is null then
    raise exception 'Informe o motivo para encaminhar um aluno com acordo ativo.' using errcode = '22023';
  end if;
  -- a gestao confirma a LISTA que viu. Se o conjunto vivo mudou, nada e gravado.
  if p_acordos is null then
    raise exception 'Informe a lista de acordos revisada.' using errcode = '22023';
  end if;
  -- trava o aluno e os acordos ATIVO antes de comparar (a reativacao concorrente ainda
  -- nao confirmada NAO e coberta; ver docs, risco residual)
  perform 1 from public.alunos al join public.juridico_casos jc on jc.aluno_id = al.id
   where jc.id = p_caso_id for update of al;
  perform 1 from public.acordos a join public.juridico_casos jc on jc.aluno_id = a.aluno_id
   where jc.id = p_caso_id and upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null
   for update of a;
  if (select coalesce(array_agg(a.id order by a.id), '{}'::uuid[])
        from public.acordos a join public.juridico_casos jc on jc.aluno_id = a.aluno_id
       where jc.id = p_caso_id and upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null)
     is distinct from (select coalesce(array_agg(x order by x), '{}'::uuid[]) from unnest(p_acordos) x) then
    raise exception 'Os acordos do aluno mudaram desde a revisão. Recarregue a tela antes de aprovar.' using errcode = 'P0001';
  end if;
  update public.juridico_casos
     set acordo_ativo_aprovado_por = v_email, acordo_ativo_aprovado_em = now(),
         acordo_ativo_motivo = btrim(p_motivo),
         acordos_na_geracao = p_acordos
   where id = p_caso_id and status = 'EM_ANALISE'
  returning lote_id into v_lote;
  if not found then
    raise exception 'Só caso em análise recebe aprovação de acordo ativo.' using errcode = 'P0001';
  end if;
  perform public._juridico_registrar(p_caso_id, v_lote, 'ACORDO_ATIVO_APROVADO',
    jsonb_build_object('motivo', btrim(p_motivo)), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'acordo_ativo_aprovado', true);
  exception when lock_not_available then
    raise exception 'Caso em uso por outra rotina (aluno, caso, acordo ou parcela). Nada foi gravado. Tente novamente em instantes.' using errcode = '40001';
  end;
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
  v_acordos uuid[]; v_sig text;
begin
  -- espera LIMITADA: nenhum conflito de trava fica pendurado; o erro reverte a transacao inteira
  set local lock_timeout = '3s';
  begin
  select * into v_caso from public.juridico_casos where id = p_caso_id for update;
  if not found then raise exception 'Caso não encontrado.' using errcode = 'P0002'; end if;
  if v_caso.status <> 'EM_ANALISE' then
    raise exception 'Caso já está %: não há o que aprovar.', v_caso.status using errcode = 'P0001';
  end if;

  -- Aluno, acordos ATIVO e parcelas travados SEM ESPERA, antes de qualquer escrita. Esperar aqui
  -- criava deadlock: o gatilho de recalculo (parcela -> aluno) e o FK parcela->acordo andam na
  -- ordem oposta. Conflito falha rapido, nada e gravado, e a tela pede nova tentativa.
  begin
    perform 1 from public.alunos where id = v_caso.aluno_id for update nowait;
    select array_agg(x.id) into v_acordos from (
      select a.id from public.acordos a
       where a.aluno_id = v_caso.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO'
         and a.duplicado_de is null
       for update nowait) x;
    v_acordos := coalesce(v_acordos, '{}'::uuid[]);
    perform 1 from public.parcelas p where p.acordo_id = any(v_acordos) for update nowait;
  exception when lock_not_available then
    raise exception 'Caso em uso por outra rotina (aluno, acordo ou parcela). Tente novamente em instantes.'
      using errcode = '40001';
  end;
  v_sig := public._juridico_acordos_assinatura(v_caso.aluno_id);

  v_conf := public._juridico_conferencia(v_caso.aluno_id);
  -- nada pode ter mudado entre a leitura e a conferencia (outra transacao concorrente)
  if public._juridico_acordos_assinatura(v_caso.aluno_id) is distinct from v_sig then
    raise exception 'Parcela ou acordo mudou durante a aprovação. Tente novamente.' using errcode = '40001';
  end if;
  -- a conferencia nao pode trazer acordo que o conjunto travado nao tem (corrida)
  if exists (select 1 from jsonb_array_elements(v_conf->'acordos') a
              where not ((a->>'acordo_id')::uuid = any(v_acordos))) then
    raise exception 'Acordo mudou durante a aprovação. Tente novamente.' using errcode = '40001';
  end if;
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

  -- Estado ANTERIOR de cada caso do aluno (nao_acionar), para desfazer SO o que este fluxo gravar.
  -- Trava os casos antes de ler: sem isso, outro fluxo poderia gravar a flag entre a leitura e o update.
  perform 1 from public.casos c where c.aluno_id = v_caso.aluno_id for update;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'nao_acionar', coalesce(c.nao_acionar, false))
                            order by c.id), '[]'::jsonb)
    into v_ant
    from public.casos c where c.aluno_id = v_caso.aluno_id;
  if jsonb_array_length(v_ant) = 0 then
    raise exception 'Aluno sem caso de cobrança: não há como bloquear a cobrança. Nada foi alterado.' using errcode = 'P0001';
  end if;

  -- BLOQUEIO SEM ENCERRAMENTO: nao_acionar barra a cobrança (manual, massiva, automática) e
  -- NAO mexe em responsavel, carteira, status do aluno nem do caso. Nao se grava JURIDICO em status.
  update public.casos set nao_acionar = true where aluno_id = v_caso.aluno_id;

  -- VALIDACAO CENTRAL: o portao canonico tem que acusar bloqueio depois da gravacao.
  if public.aluno_bloqueio_administrativo(v_caso.aluno_id) is null then
    raise exception 'O bloqueio de cobrança não foi efetivado para o aluno %. Aprovação desfeita.', v_caso.aluno_id
      using errcode = 'P0001';
  end if;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email)
  values (v_caso.aluno_id::text, 'JURIDICO_APROVADO',
          'Aprovado para análise de ajuizamento. Cobrança bloqueada no portão (massivas e elegibilidade). Envio por WhatsApp NÃO é bloqueado por esta aba (decisão pendente). Aluno permanece na carteira e com o responsável; títulos não foram cancelados.',
          null, null, v_email, v_email);

  update public.juridico_casos
     set status = 'APROVADO', aprovado_por = v_email, aprovado_em = now(),
         valor_aprovado = (v_conf->>'total')::numeric, bloqueio_anterior = v_ant,
         acordos_aprovados = v_acordos,
         acordos_assinatura = v_sig,
         termo_aprovado_id = nullif(v_conf->'termo'->>'termo_id', '')::uuid
   where id = p_caso_id;

  perform public._juridico_registrar(p_caso_id, v_caso.lote_id, 'CASO_APROVADO',
    jsonb_build_object('valor', v_conf->'total', 'titulos', v_n,
                       'termo', v_conf->'termo'->>'status'), v_email);
  return jsonb_build_object('caso_id', p_caso_id, 'status', 'APROVADO',
                            'valor', v_conf->'total', 'titulos', v_n);
  exception when lock_not_available then
    raise exception 'Caso em uso por outra rotina (aluno, caso, acordo ou parcela). Nada foi gravado. Tente novamente em instantes.' using errcode = '40001';
  end;
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
               'divergencias', to_jsonb(dv.d),
               'conferencia_status', public._juridico_conferencia_status(dv.d),
               'acordo_ativo_motivo', jc.acordo_ativo_motivo,
               'documento', case when coalesce(array_length(dv.d, 1), 0) > 0 then 'Revisão necessária: ver divergências'
                                 when jc.doc_manual_em is not null then 'Vinculado manualmente (' || jc.doc_manual_origem || ')'
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
        cross join lateral (select public._juridico_divergencias(jc) as d offset 0) dv
       where jc.lote_id = l.id
         and jc.status in ('ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')), '[]'::jsonb))
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
declare v_email text := public._juridico_exigir_gestao(); v_n int; v_div text; v_d text[]; v_pl jsonb; r public.juridico_casos;
begin
  perform 1 from public.juridico_lotes where id = p_lote_id for update;
  if not found then raise exception 'Lote não encontrado.' using errcode = 'P0002'; end if;

  -- A fotografia e da APROVACAO. Titulo ou parcela que deixou de estar em
  -- aberto depois dela (pago, cancelado, renegociado) nao pode ir ao financeiro
  -- como divida: recusa o envio e nomeia os alunos. A gestao remove o caso (o
  -- bloqueio cai) e, se ainda couber, aprova de novo com o valor atual.
  for r in select * from public.juridico_casos where lote_id = p_lote_id and status = 'APROVADO' loop
    v_d := public._juridico_divergencias(r);
    if array_length(v_d, 1) is not null then
      v_div := coalesce(v_div || ', ', '') || coalesce((select al.nome from public.alunos al where al.id = r.aluno_id), '?')
               || ' (' || array_to_string(v_d, ', ') || ')';
    end if;
  end loop;
  if v_div is not null then
    raise exception 'Envio recusado: houve mudança depois da aprovação em: %. Remova o caso (o bloqueio cai) e aprove de novo com o valor atual.', v_div
      using errcode = 'P0001';
  end if;

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

  v_pl := public._juridico_lote_payload(p_lote_id);
  -- O Excel deste envio leva CPF completo: fica registrado, como a reexportacao.
  perform public._juridico_registrar(null, p_lote_id, 'EXCEL_GERADO',
    jsonb_build_object('casos', jsonb_array_length(v_pl->'casos'), 'origem', 'ENVIO_FINANCEIRO'), v_email);
  return v_pl || jsonb_build_object('enviados_agora', v_n);
end;
$function$;

-- CONFIRMAR: registra que o caso foi ENCAMINHADO ao juridico. Nao e ajuizamento.
create function public.juridico_casos_confirmar_juridico(
  p_caso_ids uuid[], p_data date default null, p_observacao text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text := public._juridico_exigir_gestao(); v_n int := 0;
  v_c public.juridico_casos; v_d text[]; v_rec jsonb := '[]'::jsonb;
  v_data date := coalesce(p_data, (now() at time zone 'America/Sao_Paulo')::date);
begin
  if p_caso_ids is null or array_length(p_caso_ids, 1) is null then
    raise exception 'Selecione ao menos um caso.' using errcode = '22023';
  end if;
  if v_data > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'A data do encaminhamento não pode ser futura.' using errcode = '22023';
  end if;
  if exists (select 1 from public.juridico_casos
              where id = any(p_caso_ids) and status <> 'ENVIADO_FINANCEIRO') then
    raise exception 'Só casos já enviados ao financeiro podem ser confirmados como encaminhados ao jurídico.'
      using errcode = 'P0001';
  end if;

  -- Caso classificado como "Nao encaminhavel" NAO e confirmado: o motivo e registrado no
  -- historico e devolvido a tela. Os demais seguem. Revisao necessaria segue, com a divergencia
  -- gravada no registro do encaminhamento.
  for v_c in select * from public.juridico_casos
              where id = any(p_caso_ids) and status = 'ENVIADO_FINANCEIRO' order by id for update loop
    v_d := public._juridico_divergencias(v_c);
    if public._juridico_conferencia_status(v_d) = 'NAO_ENCAMINHAVEL' then
      perform public._juridico_registrar(v_c.id, v_c.lote_id, 'CONFIRMACAO_RECUSADA',
        jsonb_build_object('divergencias', to_jsonb(v_d), 'motivo', 'Caso classificado como Não encaminhável.'), v_email);
      v_rec := v_rec || jsonb_build_object('caso_id', v_c.id,
        'aluno', (select al.nome from public.alunos al where al.id = v_c.aluno_id), 'divergencias', to_jsonb(v_d));
    else
      update public.juridico_casos
         set status = 'CONFIRMADO_JURIDICO', confirmado_juridico_data = v_data,
             confirmado_juridico_em = now(), confirmado_juridico_por = v_email,
             confirmado_juridico_obs = nullif(btrim(coalesce(p_observacao,'')), '')
       where id = v_c.id;
      perform public._juridico_registrar(v_c.id, v_c.lote_id, 'ENCAMINHADO_AO_JURIDICO',
        jsonb_build_object('data', v_data, 'observacao', p_observacao, 'divergencias', to_jsonb(v_d),
                           'nota', 'Encaminhamento ao jurídico. Não indica ajuizamento.'), v_email);
      v_n := v_n + 1;
    end if;
  end loop;

  return jsonb_build_object('confirmados', v_n, 'data', v_data, 'recusados', v_rec);
end;
$function$;

-- Painel da aba: indicadores, lotes e casos com a conferencia.
-- CARTEIRA: ids dos alunos com bloqueio jurídico EFETIVO. Gestao ve todos; operador so os da propria
-- carteira (responsavel_atual_email). Devolve so o id, sem nome, CPF ou valor.
-- AUTORIZACAO EXCEPCIONAL DE ENVIO a aluno com bloqueio juridico efetivo.
-- Regras: so a GESTAO ATIVA cria; vinculada ao aluno, a conversa, ao TIPO (MENSAGEM ou DOCUMENTO) e ao
-- HASH do conteudo aprovado; uso UNICO; valida 30 minutos. Alterar o conteudo exige nova autorizacao.
-- Nao remove o bloqueio, nao altera carteira, responsavel nem status do caso. Cobranca permanece bloqueada.
create table public.juridico_envio_autorizacoes (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid not null,
  conversa_id uuid not null,
  tipo text not null check (tipo in ('MENSAGEM','DOCUMENTO')),
  conteudo_hash text not null check (length(conteudo_hash) >= 16),
  motivo text not null check (length(btrim(motivo)) >= 10),
  autorizado_por text not null,
  autorizado_em timestamptz not null default now(),
  valido_ate timestamptz not null,
  usado_em timestamptz,
  usado_por text
);
create index juridico_envio_aut_aluno on public.juridico_envio_autorizacoes (aluno_id, conversa_id);
alter table public.juridico_envio_autorizacoes enable row level security;
revoke all on public.juridico_envio_autorizacoes from public, anon, authenticated;

-- Bloqueio juridico EFETIVO de um aluno (caso encaminhado com nao_acionar ligado).
create function public._juridico_bloqueio_efetivo(p_aluno uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select exists (select 1 from public.juridico_casos jc
                  where jc.aluno_id = p_aluno
                    and jc.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')
                    and exists (select 1 from public.casos c where c.aluno_id = jc.aluno_id and c.nao_acionar is true));
$function$;

-- Checagem do envio (mensagem ou documento). FAIL-CLOSED: qualquer erro aqui impede o envio.
--  * sem aluno identificado: recusa (nao cria vinculo automatico)
--  * sem bloqueio efetivo: passa
--  * com bloqueio: so com autorizacao vigente para aluno + conversa + tipo + hash, ainda nao usada; gasta-a
create function public.juridico_checar_envio(p_aluno uuid, p_conversa uuid, p_operador text, p_tipo text, p_conteudo_hash text)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if p_aluno is null or not exists (select 1 from public.alunos al where al.id = p_aluno) then
    raise exception 'Envio recusado: aluno não identificado. Vincule o contato a um aluno antes de enviar.' using errcode = '42501';
  end if;
  if p_tipo is null or p_tipo not in ('MENSAGEM','DOCUMENTO') or nullif(btrim(coalesce(p_conteudo_hash,'')), '') is null then
    raise exception 'Envio recusado: tipo ou conteúdo não informado para a checagem.' using errcode = '22023';
  end if;
  if not public._juridico_bloqueio_efetivo(p_aluno) then return; end if;
  select a.id into v_id from public.juridico_envio_autorizacoes a
   where a.aluno_id = p_aluno and a.conversa_id = p_conversa
     and a.tipo = p_tipo and a.conteudo_hash = btrim(p_conteudo_hash)
     and a.usado_em is null and a.valido_ate > now()
   order by a.autorizado_em desc limit 1
   for update;
  if v_id is null then
    raise exception 'Envio bloqueado: aluno com bloqueio jurídico. Só com autorização específica da gestão para este conteúdo.'
      using errcode = '42501';
  end if;
  update public.juridico_envio_autorizacoes set usado_em = now(), usado_por = p_operador where id = v_id;
end;
$function$;

-- Gestao ativa autoriza UM envio (mensagem ou documento) deste conteudo para este aluno e conversa.
create function public.juridico_autorizar_envio(p_aluno uuid, p_conversa uuid, p_tipo text, p_conteudo_hash text, p_motivo text)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text := public._juridico_exigir_gestao(); v_id uuid;
begin
  if not exists (select 1 from public.usuarios u where lower(u.email) = v_email and u.ativo is true) then
    raise exception 'Gestão inativa: autorização não concedida.' using errcode = '42501';
  end if;
  if p_tipo not in ('MENSAGEM','DOCUMENTO') or nullif(btrim(coalesce(p_conteudo_hash,'')), '') is null then
    raise exception 'Tipo ou conteúdo não informado.' using errcode = '22023';
  end if;
  if not public._juridico_bloqueio_efetivo(p_aluno) then
    raise exception 'O aluno não tem bloqueio jurídico efetivo: não há o que autorizar.' using errcode = 'P0001';
  end if;
  insert into public.juridico_envio_autorizacoes
    (aluno_id, conversa_id, tipo, conteudo_hash, motivo, autorizado_por, valido_ate)
  values (p_aluno, p_conversa, p_tipo, btrim(p_conteudo_hash), btrim(p_motivo), v_email, now() + interval '30 minutes')
  returning id into v_id;
  return v_id;
end;
$function$;

create function public.juridico_bloqueio_ids(p_ids uuid[])
returns setof uuid
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_gestao boolean := coalesce(public.usuario_e_gestao(), false);
begin
  -- sem e-mail ou usuario inativo (usuarios.ativo): nada. Gestao (usuario_e_gestao) ve todos;
  -- operador so os alunos da PROPRIA carteira (responsavel_atual_email).
  if v_email = '' then return; end if;
  -- Regra vigente (app_usuario_ativo): usuarios.ativo para todos, inclusive gestao.
  if not exists (select 1 from public.usuarios u where lower(u.email) = v_email and u.ativo is true) then return; end if;
  if coalesce(array_length(p_ids, 1), 0) > 2000 then
    raise exception 'Lista grande demais (máximo 2000 alunos por consulta).' using errcode = '22023';
  end if;
  return query
    select distinct jc.aluno_id
      from public.juridico_casos jc
      join public.alunos al on al.id = jc.aluno_id
     where jc.aluno_id = any(coalesce(p_ids, '{}'::uuid[]))
       and jc.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')
       and exists (select 1 from public.casos c where c.aluno_id = jc.aluno_id and c.nao_acionar is true)
       and (v_gestao or lower(coalesce(al.responsavel_atual_email, '')) = v_email);
end;
$function$;

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
                   'divergencias', case when jc.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')
                                        then to_jsonb(public._juridico_divergencias(jc)) else '[]'::jsonb end,
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
-- 4. DOCUMENTOS VINCULADOS: historico de inclusao, nunca reescrito
-- ---------------------------------------------------------------------------
create table public.juridico_documentos (
  id bigint generated always as identity primary key,
  caso_id uuid not null references public.juridico_casos(id),
  origem text not null check (origem in ('CRM','DRIVE','PRESENCIAL_DIGITALIZADO','OUTRO')),
  nome text,
  referencia text not null,
  vinculado_por text not null,
  vinculado_em timestamptz not null default now()
);
create index juridico_documentos_caso on public.juridico_documentos (caso_id);
alter table public.juridico_documentos enable row level security;
revoke all on public.juridico_documentos from public, anon, authenticated;
revoke all on sequence public.juridico_documentos_id_seq, public.juridico_historico_id_seq
  from public, anon, authenticated;

create function public._juridico_so_anexa()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  raise exception 'Histórico jurídico é somente de inclusão: não se altera nem se apaga (%).', tg_table_name
    using errcode = '42501';
end;
$function$;

create trigger trg_juridico_so_anexa_historico before update or delete on public.juridico_historico
  for each row execute function public._juridico_so_anexa();
create trigger trg_juridico_so_anexa_documentos before update or delete on public.juridico_documentos
  for each row execute function public._juridico_so_anexa();
create trigger trg_juridico_so_anexa_truncate_historico before truncate on public.juridico_historico
  for each statement execute function public._juridico_so_anexa();
create trigger trg_juridico_so_anexa_truncate_documentos before truncate on public.juridico_documentos
  for each statement execute function public._juridico_so_anexa();

-- Mudanca de status de acordo de aluno com caso ja aprovado (ou enviado/confirmado)
-- vira linha no historico. E assim que se enxerga cancelado depois da aprovacao e
-- reativado depois: o ID do acordo e o mesmo, so o status muda. So grava; nao
-- altera acordo, parcela, titulo nem carteira.
create function public._juridico_registra_acordo_status()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.status is distinct from old.status then
    insert into public.juridico_historico (caso_id, lote_id, evento, detalhe, por)
    select jc.id, jc.lote_id, 'ACORDO_STATUS',
           jsonb_build_object('acordo_id', new.id, 'antes', old.status, 'depois', new.status),
           'sistema:acordos'
      from public.juridico_casos jc
     where jc.aluno_id = new.aluno_id
       and jc.status <> 'REMOVIDO';
  end if;
  return new;
end;
$function$;

create trigger trg_juridico_acordo_status after update of status on public.acordos
  for each row execute function public._juridico_registra_acordo_status();

-- Parcela que QUEBROU (virou VENCIDA) ou mudou de valor/vencimento, em acordo ATIVO de aluno com
-- caso vivo, vira linha no historico. E o que permite enxergar "regularizou e quebrou de novo" e
-- "prorrogou e reverteu". Statement-level com tabelas de transicao e saida imediata quando nao ha
-- caso vivo: nao pesa nas rotinas em lote que atualizam parcelas. So grava; nao altera parcela.
create function public._juridico_registra_parcela()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.juridico_casos
                  where status in ('EM_ANALISE','APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO') limit 1) then
    return null;
  end if;
  insert into public.juridico_historico (caso_id, lote_id, evento, detalhe, por)
  select jc.id, jc.lote_id, 'PARCELA_QUEBROU',
         jsonb_build_object('parcela_id', n.id, 'acordo_id', n.acordo_id, 'antes', o.status, 'depois', n.status),
         'sistema:parcelas'
    from new_t n join old_t o on o.id = n.id
    join public.acordos a on a.id = n.acordo_id and upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null
    join public.juridico_casos jc on jc.aluno_id = a.aluno_id and jc.status <> 'REMOVIDO'
   where upper(coalesce(n.status,'')) = 'VENCIDA' and upper(coalesce(o.status,'')) <> 'VENCIDA'
     -- so a passagem de EM DIA para QUEBRADO: se o acordo ja tinha outra parcela vencida antes
     -- deste comando, a quebra natural de mais uma parcela nao e uma nova quebra
     and not exists (select 1 from public.parcelas p
                      where p.acordo_id = n.acordo_id and upper(coalesce(p.status,'')) = 'VENCIDA'
                        and p.id not in (select id from new_t))
     and not exists (select 1 from old_t o2
                      where o2.acordo_id = n.acordo_id and upper(coalesce(o2.status,'')) = 'VENCIDA');
  insert into public.juridico_historico (caso_id, lote_id, evento, detalhe, por)
  select jc.id, jc.lote_id, 'PARCELA_MATERIAL',
         jsonb_build_object('parcela_id', n.id, 'acordo_id', n.acordo_id,
                            'valor_antes', o.valor, 'valor_depois', n.valor,
                            'vencimento_antes', o.vencimento, 'vencimento_depois', n.vencimento),
         'sistema:parcelas'
    from new_t n join old_t o on o.id = n.id
    join public.acordos a on a.id = n.acordo_id and upper(coalesce(a.status,'')) = 'ATIVO' and a.duplicado_de is null
    join public.juridico_casos jc on jc.aluno_id = a.aluno_id and jc.status <> 'REMOVIDO'
   where n.valor is distinct from o.valor or n.vencimento is distinct from o.vencimento;
  return null;
end;
$function$;

create trigger trg_juridico_parcela_historico after update on public.parcelas
  referencing old table as old_t new table as new_t
  for each statement execute function public._juridico_registra_parcela();

-- Classificacao unica da conferencia (usada pelo Excel e pela confirmacao juridica).
create function public._juridico_conferencia_status(p_div text[])
returns text
language sql immutable set search_path to 'public'
as $function$
  select case
    when coalesce(array_length(p_div, 1), 0) = 0 then 'CONFERIDO'
    when p_div && array['PAGAMENTO_NAO_BAIXADO','PAGAMENTO_AGUARDANDO_CONFIRMACAO','TITULO_EM_CONFIRMACAO',
                        'MENSALIDADE_ALTERADA','PARCELA_ALTERADA'] then 'NAO_ENCAMINHAVEL'
    else 'REVISAO_NECESSARIA' end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. GUARDA DO BLOQUEIO: o status JURIDICO nao sai de alunos/casos enquanto
--    houver caso ativo. So a GUC juridico.desbloqueio (ligada em
--    _juridico_desbloquear, dentro da remocao do caso) deixa passar.
-- ---------------------------------------------------------------------------
create function public._juridico_guarda_bloqueio()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare v_aluno uuid; v_saiu boolean;
begin
  if coalesce(current_setting('juridico.desbloqueio', true), '') = 'on' then
    return new;
  end if;
  if tg_table_name = 'alunos' then
    v_aluno := new.id;
    v_saiu := (upper(coalesce(old.status_atual,'')) = 'JURIDICO' and upper(coalesce(new.status_atual,'')) <> 'JURIDICO')
           or (upper(coalesce(old.status_jornada,'')) = 'JURIDICO' and upper(coalesce(new.status_jornada,'')) <> 'JURIDICO')
           or (upper(coalesce(old.status_acionamento,'')) = 'JURIDICO' and upper(coalesce(new.status_acionamento,'')) <> 'JURIDICO');
  else
    v_aluno := new.aluno_id;
    v_saiu := (upper(coalesce(old.status_atual,'')) = 'JURIDICO' and upper(coalesce(new.status_atual,'')) <> 'JURIDICO')
           or (upper(coalesce(old.status_acionamento,'')) = 'JURIDICO' and upper(coalesce(new.status_acionamento,'')) <> 'JURIDICO')
           or (upper(coalesce(old.status_financeiro,'')) = 'JURIDICO' and upper(coalesce(new.status_financeiro,'')) <> 'JURIDICO')
           or (upper(coalesce(old.status_jornada,'')) = 'JURIDICO' and upper(coalesce(new.status_jornada,'')) <> 'JURIDICO');
  end if;
  if not coalesce(v_saiu, false) then
    return new;
  end if;
  if exists (select 1 from public.juridico_casos jc
              where jc.aluno_id = v_aluno
                and jc.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')) then
    raise exception 'Cobrança jurídica ativa: o status JURIDICO só sai pelo procedimento de remoção do caso na aba Jurídico.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

-- MARCA DE FLAG COMPARTILHADA. Um UPDATE que grava nao_acionar=true numa flag JA ligada e
-- sinal de OUTRO fluxo (ex.: confirmacao de saldo zero, antecipacao) que tambem a usa. Se
-- ocorrer com caso encaminhado, a remocao do caso nao pode desliga-la. O gatilho dispara em
-- todo UPDATE OF nao_acionar, mesmo sem mudanca de valor.
create function public._juridico_marca_bloqueio_compartilhado()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if coalesce(old.nao_acionar, false) is true and coalesce(new.nao_acionar, false) is true
     and coalesce(current_setting('juridico.desbloqueio', true), '') <> 'on' then
    update public.juridico_casos
       set bloqueio_compartilhado = true
     where aluno_id = old.aluno_id
       and status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')
       and bloqueio_compartilhado = false;
  end if;
  return new;
end;
$function$;

-- AFTER: roda depois que a linha foi travada e, se houve espera por aprovacao em outra sessao,
-- le o estado ja commitado (o BEFORE leria o snapshot de antes da espera).
create trigger trg_juridico_marca_bloqueio_compartilhado after update of nao_acionar on public.casos
  for each row execute function public._juridico_marca_bloqueio_compartilhado();

-- GUARDA DO BLOQUEIO DE COBRANCA (nao_acionar). Enquanto houver caso APROVADO/ENVIADO/CONFIRMADO,
-- ninguem libera nao_acionar por outra tela ou rotina. So a GUC juridico.desbloqueio (remocao do caso).
create function public._juridico_guarda_nao_acionar()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  -- Liberacao (nao_acionar = false) sem a GUC da remocao: so passa se NAO houver encaminhamento ativo.
  -- Decide pelo estado da linha de casos DEPOIS de ela ser travada, nao por old.nao_acionar (que pode
  -- ser o valor de antes de uma espera). Que o cenario 7 do runner (duas conexoes, PG17) recuse a
  -- liberacao depois do commit e verificado no CI; o mecanismo exato (se e o recheque apos a espera ou
  -- o FOR SHARE) NAO foi isolado. O FOR SHARE fica como trava explicita sobre o encaminhamento.
  if coalesce(new.nao_acionar, false) is false
     and coalesce(current_setting('juridico.desbloqueio', true), '') <> 'on' then
    perform 1 from public.juridico_casos jc
     where jc.aluno_id = new.aluno_id
       and jc.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')
     for share;
    if exists (select 1 from public.juridico_casos jc
                where jc.aluno_id = new.aluno_id
                  and jc.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')) then
      raise exception 'Cobrança jurídica ativa: o bloqueio de cobrança só é liberado pela remoção do caso na aba Jurídico.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

create trigger trg_juridico_guarda_nao_acionar before update of nao_acionar on public.casos
  for each row execute function public._juridico_guarda_nao_acionar();

-- Caso de cobranca novo para aluno que ja tem encaminhamento ativo: recusa.
create function public._juridico_guarda_caso_novo()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.aluno_id is not null and exists (
       select 1 from public.juridico_casos jc
        where jc.aluno_id = new.aluno_id
          and jc.status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO')) then
    raise exception 'Aluno com encaminhamento jurídico ativo: não se abre novo caso de cobrança.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

create trigger trg_juridico_guarda_bloqueio before update on public.alunos
  for each row execute function public._juridico_guarda_bloqueio();
create trigger trg_juridico_guarda_bloqueio before update on public.casos
  for each row execute function public._juridico_guarda_bloqueio();
create trigger trg_juridico_guarda_caso_novo before insert on public.casos
  for each row execute function public._juridico_guarda_caso_novo();

-- ---------------------------------------------------------------------------
-- 6. ALERTA: registra no historico o que mudou depois do encaminhamento.
--    Nao apaga, nao reescreve e nao cancela nada. Idempotente: so registra
--    quando o conjunto de divergencias mudou desde o ultimo alerta do caso.
-- ---------------------------------------------------------------------------
create function public.juridico_varrer_alertas()
returns integer
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text := public._juridico_exigir_gestao();
  r public.juridico_casos;
  v_d text[];
  v_ultimo jsonb;
  v_n int := 0;
begin
  for r in select * from public.juridico_casos
            where status in ('APROVADO','ENVIADO_FINANCEIRO','CONFIRMADO_JURIDICO') loop
    v_d := public._juridico_divergencias(r);
    continue when array_length(v_d, 1) is null;
    select h.detalhe->'codigos' into v_ultimo
      from public.juridico_historico h
     where h.caso_id = r.id and h.evento = 'ALERTA_DIVERGENCIA'
     order by h.id desc limit 1;
    continue when v_ultimo is not distinct from to_jsonb(v_d);
    perform public._juridico_registrar(r.id, r.lote_id, 'ALERTA_DIVERGENCIA',
      jsonb_build_object('codigos', to_jsonb(v_d), 'status_caso', r.status,
        'aviso', 'Mudança depois do encaminhamento: gestão e jurídico devem rever. Histórico preservado.'),
      v_email);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. GRANTS EXPLICITOS: lista fechada, sem casar por nome. Publicas: execute
--    so para authenticated (a porta de gestao esta dentro). Internas: nenhum.
-- ---------------------------------------------------------------------------
do $grants$
declare sig text;
begin
  foreach sig in array array[
  'public.juridico_candidatos(integer,integer,integer,text[])',
  'public.juridico_lote_gerar(integer,integer,integer,text[],text)',
  'public.juridico_caso_substituir(uuid,text)',
  'public.juridico_caso_remover(uuid,text)',
  'public.juridico_caso_documento_vincular(uuid,text,text,text)',
  'public.juridico_caso_autorizar_documento(uuid,text)',
  'public.juridico_caso_aprovar_acordo_ativo(uuid,text,uuid[])',
  'public.juridico_caso_revisar_acordo_quebrado(uuid,text,uuid[],numeric,uuid[])',
  'public.juridico_caso_aprovar(uuid)',
  'public.juridico_lote_exportar(uuid)',
  'public.juridico_lote_enviar_financeiro(uuid)',
  'public.juridico_casos_confirmar_juridico(uuid[],date,text)',
  'public.juridico_painel()',
  'public.juridico_varrer_alertas()',
  'public.juridico_bloqueio_ids(uuid[])',
  'public.juridico_autorizar_envio(uuid,uuid,text,text,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', sig);
    execute format('grant execute on function %s to authenticated', sig);
  end loop;
  foreach sig in array array[
  'public._juridico_exigir_gestao()',
  'public._juridico_grupo(text)',
  'public._juridico_pagamento_nao_baixado(uuid)',
  'public._juridico_pagamento_nao_baixado_ids(uuid[])',
  'public._juridico_conferencia(uuid)',
  'public._juridico_pendencias(public.juridico_casos,jsonb)',
  'public._juridico_divergencias(public.juridico_casos)',
  'public._juridico_acordos_assinatura(uuid)',
  'public._juridico_registra_parcela()',
  'public._juridico_conferencia_status(text[])',
  'public._juridico_registrar(uuid,uuid,text,jsonb,text)',
  'public._juridico_candidatos(integer,integer,integer,text[],uuid[])',
  'public._juridico_lote_payload(uuid)',
  'public._juridico_desbloquear(public.juridico_casos)',
  'public._juridico_guarda_bloqueio()',
  'public._juridico_guarda_caso_novo()',
  'public._juridico_guarda_nao_acionar()',
  'public._juridico_bloqueio_efetivo(uuid)',
  'public.juridico_checar_envio(uuid,uuid,text,text,text)',
  'public._juridico_marca_bloqueio_compartilhado()',
  'public._juridico_so_anexa()',
  'public._juridico_registra_acordo_status()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', sig);
  end loop;
end
$grants$;

-- ---------------------------------------------------------------------------
-- 8. ASSEGURACAO
-- ---------------------------------------------------------------------------
do $prova$
declare v_n int;
begin
  -- inventario fechado: qualquer funcao nova com este prefixo quebra a migration
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname like 'juridico\_%' or p.proname like '\_juridico\_%');
  if v_n <> 38 then
    raise exception 'juridico: inventario de funcoes diverge (% encontradas, 38 esperadas).', v_n;
  end if;

  select count(*) into v_n
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname like 'juridico\_%' or p.proname like '\_juridico\_%')
     and (has_function_privilege('anon', p.oid, 'execute')
       or ((p.proname like '\_%' or p.proname = 'juridico_checar_envio') and has_function_privilege('authenticated', p.oid, 'execute'))
       or ((p.proname like '\_%' or p.proname = 'juridico_checar_envio') and has_function_privilege('service_role', p.oid, 'execute'))
       or not coalesce(p.proconfig @> array['search_path=public'], false));
  if v_n > 0 then
    raise exception 'juridico: % funcao(oes) com grant indevido ou sem search_path fixo.', v_n;
  end if;

  select count(*) into v_n
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('juridico_lotes','juridico_casos','juridico_casos_titulos','juridico_historico','juridico_documentos','juridico_envio_autorizacoes')
     and (not c.relrowsecurity
       or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate')
       or has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate'));
  if v_n > 0 then
    raise exception 'juridico: % tabela(s) sem RLS ou com grant direto.', v_n;
  end if;

  select count(*) into v_n
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
     and c.relname in ('juridico_protocolo_seq','juridico_historico_id_seq','juridico_documentos_id_seq')
     and (has_sequence_privilege('authenticated', c.oid, 'usage,select,update')
       or has_sequence_privilege('anon', c.oid, 'usage,select,update'));
  if v_n > 0 then
    raise exception 'juridico: % sequence(s) com grant direto.', v_n;
  end if;
end
$prova$;

commit;
