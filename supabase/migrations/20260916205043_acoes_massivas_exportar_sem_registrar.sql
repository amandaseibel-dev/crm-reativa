-- Acoes Massivas: exportar a planilha NAO e contato realizado.
--
-- Amanda, 16/09/2026: "os envios das Acoes Massivas sao realizados em uma
-- ferramenta externa, a geracao ou exportacao da planilha nao pode, por si so:
-- regravar a tabulacao do aluno; alterar a data de retorno; renovar a
-- fidelizacao; registrar o aluno como efetivamente acionado."
--
-- COMO ERA (conferido em producao em 16/09): a tela tinha UM botao, "Gerar
-- Excel e registrar acao". Ele chamava `registrar_acao_massiva` ANTES de baixar
-- o arquivo -- e so essa funcao devolvia os contatos completos. O registro:
--   * grava no aluno data_retorno = hoje + 10, retorno_origem = AUTOMATICO,
--     status_acionamento = 'Acao massiva externa enviada -- aguardando retorno'
--     e data_ultimo_acionamento = agora;
--   * insere a movimentacao ACAO_MASSIVA_EXTERNA(_EMAIL);
--   * e, pelos gatilhos `trg_sync_acionamento_alunos_para_casos` e
--     `trg_atualizar_ultimo_acionamento`, empurra casos.data_ultimo_acionamento
--     (fidelizacao de 10 dias) e recalcula situacao/criticidade.
-- 11.852 movimentacoes dessas em 30 dias: cada uma nasceu no clique de exportar,
-- nao no disparo.
--
-- COMO FICA -- tres eventos separados:
--   1. Previa: somente leitura (ja era).
--   2. Exportar planilha: `acoes_massivas_exportar`. Revalida exatamente como o
--      registro revalidaria (confirmacao de pagamento, liquidado no Prime, e o
--      recorte: sem operador = sem dono ou nunca acionado; com operador = na
--      carteira dele) e devolve os contatos. NAO escreve em alunos, casos nem
--      aluno_movimentacoes. Grava so um LOTE de exportacao (quem exportou,
--      quando, canal, operador, arquivo e os ids) -- registro de auditoria, sem
--      efeito operacional nenhum.
--   3. Confirmar acao realizada: `acoes_massivas_concluir_lote(lote, 'CONFIRMAR')`,
--      usada depois que o disparo externo terminou. So aqui entram tabulacao,
--      retorno, acionamento e movimentacao -- pelo mesmo `registrar_acao_massiva`
--      de sempre, que revalida tudo de novo. Um lote so pode ser confirmado uma
--      vez. 'DESCARTAR' fecha o lote que nao foi enviado, sem escrever nada.
--
-- UMA TRAVA A MAIS NA CONFIRMACAO: quem foi acionado DEPOIS da exportacao fica
-- de fora e e contado. O contato real mais novo (a tabulacao de um operador, ou
-- a confirmacao de outro lote) nao e sobrescrito pela campanha.
--
-- O LOTE PERSISTE para a confirmacao sobreviver a recarregar a pagina: o
-- disparo externo pode levar horas. `acoes_massivas_lotes_pendentes` lista os
-- lotes abertos, sem dado pessoal de aluno.
--
-- DEPENDE de 20260916200000 (registro com p_operador_email). Falha alto se ela
-- nao estiver aplicada.
--
-- SEGURANCA: tabela com RLS ligado e sem policy (so as funcoes SECURITY DEFINER
-- leem/escrevem); sem grant para anon/authenticated. As tres funcoes: gate de
-- gestao ou executor tecnico, search_path fixo, sem anon/PUBLIC. O resultado
-- guardado no lote e o devolvido pela confirmacao NAO levam contatos.
--
-- NAO MUDA: `registrar_acao_massiva` continua existindo e com a mesma ACL, para
-- a tela antiga seguir funcionando ate o front novo ser publicado.

do $pre$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'registrar_acao_massiva'
       and pg_get_function_identity_arguments(p.oid) like '%p_operador_email%') then
    raise exception 'registrar_acao_massiva sem p_operador_email: aplique antes a migration 20260916200000';
  end if;
end $pre$;

create table if not exists public.acoes_massivas_lotes (
  id                    uuid primary key default gen_random_uuid(),
  canal                 text not null check (canal in ('WHATSAPP', 'EMAIL')),
  operador_email        text,
  arquivo               text,
  aluno_ids             text[] not null,
  total                 integer not null,
  exportado_por_email   text not null,
  exportado_em          timestamptz not null default now(),
  confirmado_por_email  text,
  confirmado_em         timestamptz,
  descartado_por_email  text,
  descartado_em         timestamptz,
  resultado             jsonb,
  constraint acoes_massivas_lotes_um_desfecho check (confirmado_em is null or descartado_em is null)
);

comment on table public.acoes_massivas_lotes is
  'Planilhas de Acoes Massivas exportadas. Exportar NAO e contato realizado: o aluno so e registrado quando a gestao confirma o lote (acoes_massivas_concluir_lote). Sem dado pessoal alem dos ids.';

create index if not exists acoes_massivas_lotes_abertos
  on public.acoes_massivas_lotes (exportado_em desc)
  where confirmado_em is null and descartado_em is null;

alter table public.acoes_massivas_lotes enable row level security;
revoke all on table public.acoes_massivas_lotes from public, anon, authenticated;
grant all on table public.acoes_massivas_lotes to service_role;

-- ------------------------------------------------------------------ exportar
create or replace function public.acoes_massivas_exportar(
  p_aluno_ids text[],
  p_canal text,
  p_arquivo text default null,
  p_operador_email text default null
)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_canal text := upper(btrim(coalesce(p_canal, '')));
  v_operador text := lower(nullif(btrim(p_operador_email), ''));
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
  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;

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
      (canal, operador_email, arquivo, aluno_ids, total, exportado_por_email)
    values (v_canal, v_operador, p_arquivo, v_ok, array_length(v_ok, 1), v_autor)
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
    'operador_email', v_operador,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
end;
$function$;

-- ------------------------------------------------------------------ concluir
create or replace function public.acoes_massivas_concluir_lote(p_lote_id uuid, p_acao text)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
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
  v_reg := public.registrar_acao_massiva(v_ids, v_lote.canal, v_lote.arquivo, null, null, v_lote.operador_email);

  v_res := (v_reg - 'contatos') || jsonb_build_object(
    'lote_id', v_lote.id,
    'excluidos_acionados_apos_exportacao', coalesce(array_length(v_depois, 1), 0),
    'ids_acionados_apos_exportacao', to_jsonb(v_depois));

  update public.acoes_massivas_lotes
     set confirmado_em = now(), confirmado_por_email = v_autor, resultado = v_res
   where id = v_lote.id;

  return v_res;
end;
$function$;

-- ------------------------------------------------------------------ pendentes
create or replace function public.acoes_massivas_lotes_pendentes()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: lotes de acao massiva restritos a gestao.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', l.id,
             'canal', l.canal,
             'operador_email', l.operador_email,
             'operador_nome', (select u.nome from public.usuarios u where lower(u.email) = l.operador_email limit 1),
             'arquivo', l.arquivo,
             'total', l.total,
             'exportado_por_email', l.exportado_por_email,
             'exportado_em', l.exportado_em)
           order by l.exportado_em desc)
      from (select * from public.acoes_massivas_lotes
             where confirmado_em is null and descartado_em is null
             order by exportado_em desc limit 50) l), '[]'::jsonb);
end;
$function$;

revoke all on function public.acoes_massivas_exportar(text[], text, text, text) from public, anon;
grant execute on function public.acoes_massivas_exportar(text[], text, text, text) to authenticated, service_role;
revoke all on function public.acoes_massivas_concluir_lote(uuid, text) from public, anon;
grant execute on function public.acoes_massivas_concluir_lote(uuid, text) to authenticated, service_role;
revoke all on function public.acoes_massivas_lotes_pendentes() from public, anon;
grant execute on function public.acoes_massivas_lotes_pendentes() to authenticated, service_role;
