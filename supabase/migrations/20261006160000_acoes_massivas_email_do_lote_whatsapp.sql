-- ACOES MASSIVAS: E-MAIL EXATAMENTE DOS ALUNOS DE UM LOTE DE WHATSAPP.
--
-- O PROBLEMA MEDIDO. Depois de exportar um lote de WhatsApp, a gestao quer
-- alcancar os MESMOS alunos por e-mail. Hoje o unico caminho e refazer os
-- filtros na aba E-mail e torcer para cair no mesmo recorte -- e nao cai:
--   * `acoes_massivas_lotes` guarda `aluno_ids`, mas nada na tela le essa lista;
--   * os filtros do dia nao sao reconstituiveis a partir do nome do arquivo;
--   * o atalho "Acionados hoje" nao e o lote: pega tambem acionamento
--     individual do dia, e perde quem foi acionado e saiu do universo depois.
--
-- O QUE ESTA MIGRATION FAZ. Um caminho novo, ao lado do que existe:
--   1. `acoes_massivas_lotes_whatsapp(p_dias)` -- lista os lotes de WhatsApp
--      recentes com a contagem de quantos daqueles alunos tem e-mail valido;
--   2. `acoes_massivas_exportar_emails_do_lote(p_lote_id, p_arquivo)` -- pega os
--      `aluno_ids` GRAVADOS no lote, exclui SOMENTE quem nao tem e-mail valido,
--      e grava um lote NOVO de canal EMAIL com as movimentacoes individuais.
--
-- O CRITERIO E SO ESSE, DE PROPOSITO. Esta funcao NAO passa pelo
-- `acoes_massivas_universo`: quem entrou no lote de WhatsApp ja foi revalidado
-- quando o lote saiu, e o pedido e alcancar aquelas pessoas no outro canal, nao
-- reabrir a elegibilidade. Por isso aqui nao ha recencia, acionamento, tipo de
-- cobranca, responsavel nem valor -- um unico motivo de exclusao
-- (`sem_email_valido`), contado e devolvido. As demais acoes massivas seguem
-- exatamente como estao: nenhuma funcao existente e redefinida aqui.
--
-- O QUE NAO MUDA, DE PROPOSITO:
--   * o lote de WhatsApp de origem nao recebe UPDATE nenhum (nem confirmado,
--     nem descartado, nem resultado) -- ele e so lido;
--   * nada em `alunos`, `casos`, acordos, pagamentos, responsavel, retorno ou
--     fidelizacao: o unico efeito e a movimentacao individual do lote novo,
--     e quem avanca `data_ultimo_acionamento` continua sendo o gatilho
--     `fn_atualizar_ultimo_acionamento`, so para frente;
--   * nada e disparado: o envio e externo, como em toda acao massiva.
--
-- IDEMPOTENCIA. Um lote de WhatsApp gera UM lote de e-mail: a segunda chamada
-- falha apontando o lote derivado que ja existe. Dentro do lote, a trava
-- continua sendo o indice unico parcial (lote_id, aluno_id).

-- ------------------------------------------------------- 0. pre-condicoes
do $pre$
begin
  if to_regclass('public.acoes_massivas_lotes') is null then
    raise exception 'acoes_massivas_lotes ausente: aplique antes a migration do subsistema de lotes.';
  end if;
  if to_regclass('public.aluno_movimentacoes') is null then
    raise exception 'aluno_movimentacoes ausente.';
  end if;
end $pre$;

-- Colunas de registro. Em producao ja existem (regra de 02/10); o `if not
-- exists` e para o banco que ainda nao recebeu aquela migration nao quebrar.
alter table public.acoes_massivas_lotes
  add column if not exists registrados         integer,
  add column if not exists registro_automatico boolean not null default false,
  add column if not exists lote_origem_id      uuid;

comment on column public.acoes_massivas_lotes.lote_origem_id is
  'Lote que ORIGINOU este. Preenchido quando o lote de e-mail foi derivado de um lote de WhatsApp (acoes_massivas_exportar_emails_do_lote). NULL = lote montado pela previa, como sempre.';

do $fk$
begin
  if not exists (select 1 from pg_constraint where conname = 'acoes_massivas_lotes_origem_fk') then
    alter table public.acoes_massivas_lotes
      add constraint acoes_massivas_lotes_origem_fk
      foreign key (lote_origem_id) references public.acoes_massivas_lotes(id);
  end if;
end $fk$;

create index if not exists ix_amlotes_origem
  on public.acoes_massivas_lotes (lote_origem_id)
  where lote_origem_id is not null;

-- Trava de idempotencia das movimentacoes do lote. Igual a da regra de 02/10:
-- se aquela migration ja passou, isto e no-op. Se houver par duplicado, falha
-- alto em vez de criar o indice pela metade.
do $ux$
declare v_dup int;
begin
  if not exists (select 1 from pg_class where relname = 'ux_aluno_mov_lote_aluno') then
    select count(*) into v_dup from (
      select lote_id, aluno_id
        from public.aluno_movimentacoes
       where lote_id is not null
       group by 1, 2 having count(*) > 1) d;
    if v_dup > 0 then
      raise exception 'Existem % pares (lote_id, aluno_id) duplicados: decida sobre eles antes de criar a trava de idempotencia.', v_dup
        using errcode = '55000';
    end if;
    create unique index ux_aluno_mov_lote_aluno
      on public.aluno_movimentacoes (lote_id, aluno_id)
      where lote_id is not null;
  end if;
end $ux$;

-- ------------------------------------------------- 1. o que e e-mail valido
-- Mesma regra que o `acoes_massivas_universo` usa na flag `f_mail` (tem texto e
-- tem @ depois do primeiro caractere). Vive numa funcao para que a listagem, a
-- exportacao e a validacao usem a MESMA regra, sem copia que possa divergir.
create or replace function public.email_valido_para_acao_massiva(p_email text)
returns boolean
language sql immutable
set search_path to 'public'
as $function$
  select btrim(coalesce(p_email, '')) <> ''
     and position('@' in btrim(coalesce(p_email, ''))) > 1;
$function$;

comment on function public.email_valido_para_acao_massiva(text) is
  'E-mail utilizavel em acao massiva: nao vazio e com @ depois do primeiro caractere. Mesma regra da flag f_mail de acoes_massivas_universo.';

revoke all on function public.email_valido_para_acao_massiva(text) from public, anon;
grant execute on function public.email_valido_para_acao_massiva(text) to authenticated, service_role;

-- -------------------------------------- 2. lotes de WhatsApp selecionaveis
create or replace function public.acoes_massivas_lotes_whatsapp(p_dias integer default 7)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_sistema boolean := (auth.role() = 'service_role')
                       or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor'));
  v_dias int := least(greatest(coalesce(p_dias, 7), 1), 90);
begin
  if not v_sistema and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: lotes de acao massiva restritos a gestao.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', l.id,
             'arquivo', l.arquivo,
             'operador_email', l.operador_email,
             'operador_nome', (select u.nome from public.usuarios u
                                where lower(u.email) = l.operador_email limit 1),
             'tipo_cobranca', l.tipo_cobranca,
             'total', l.total,
             'exportado_em', l.exportado_em,
             'exportado_por_email', l.exportado_por_email,
             -- contagem por aluno, pela mesma regra da exportacao
             'com_email', e.com_email,
             'sem_email', l.total - e.com_email,
             -- lote de e-mail ja derivado deste (se houver): nao se exporta duas vezes
             'email_lote_id', d.id,
             'email_exportado_em', d.exportado_em)
           order by l.exportado_em desc)
      from (select * from public.acoes_massivas_lotes
             where canal = 'WHATSAPP'
               and descartado_em is null
               and exportado_em >= now() - make_interval(days => v_dias)
             order by exportado_em desc
             limit 50) l
      cross join lateral (
        select count(*)::int as com_email
          from unnest(l.aluno_ids) as x(id_txt)
          join public.alunos a on a.id = x.id_txt::uuid
         where public.email_valido_para_acao_massiva(a.email)) e
      left join lateral (
        select o.id, o.exportado_em
          from public.acoes_massivas_lotes o
         where o.lote_origem_id = l.id
           and o.canal = 'EMAIL'
           and o.descartado_em is null
         order by o.exportado_em desc
         limit 1) d on true), '[]'::jsonb);
end;
$function$;

comment on function public.acoes_massivas_lotes_whatsapp(integer) is
  'Lotes de WhatsApp recentes para derivar e-mail, com quantos dos aluno_ids gravados tem e-mail valido e qual lote de e-mail ja saiu deste. Somente leitura.';

revoke all on function public.acoes_massivas_lotes_whatsapp(integer) from public, anon;
grant execute on function public.acoes_massivas_lotes_whatsapp(integer) to authenticated, service_role;

-- ----------------------------------- 3. exportar os e-mails de um lote
create or replace function public.acoes_massivas_exportar_emails_do_lote(
  p_lote_id uuid,
  p_arquivo text default null
) returns jsonb
language plpgsql
volatile security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
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

comment on function public.acoes_massivas_exportar_emails_do_lote(uuid, text) is
  'Deriva uma acao massiva de E-MAIL dos aluno_ids gravados num lote de WhatsApp. Unico motivo de exclusao: sem e-mail valido. Grava lote novo (canal EMAIL, lote_origem_id) e as movimentacoes individuais; NAO altera o lote de origem, nao revalida pelo universo, nao dispara nada.';

revoke all on function public.acoes_massivas_exportar_emails_do_lote(uuid, text) from public, anon;
grant execute on function public.acoes_massivas_exportar_emails_do_lote(uuid, text) to authenticated, service_role;
