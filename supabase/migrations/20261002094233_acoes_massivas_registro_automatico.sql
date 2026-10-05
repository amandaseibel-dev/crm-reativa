-- ACOES MASSIVAS: REGISTRO AUTOMATICO, IDEMPOTENTE, CONTANDO COMO ACIONAMENTO.
--
-- Aprovada pela gestao em 02/10/2026. Timestamp = aplicacao real em producao.
--
-- O QUE ESTAVA ERRADO (medido em producao em 02/10/2026):
--   * 16/09 separou exportar de registrar: a planilha passou a sair sem gravar
--     nada, e o registro so acontecia se alguem voltasse e clicasse "Confirmar
--     acao realizada". Resultado: 4 lotes de 01 e 02/10, 1.400 destinatarios,
--     ZERO movimentacao individual. O disparo e externo, entao nada no sistema
--     sabe que ele aconteceu -- o lote fica aberto para sempre.
--   * 20/09 tirou a acao massiva do ultimo acionamento: o gatilho
--     fn_atualizar_ultimo_acionamento passou a ignorar ACAO_MASSIVA_EXTERNA*.
--     Medido: 1.475 de 2.086 alunos (70,7%) com acao massiva nos ultimos 7 dias
--     seguem com data_ultimo_acionamento nula ou anterior a ela.
--
-- O QUE MUDA (decisao da gestao, 02/10):
--   1. acoes_massivas_exportar passa a REGISTRAR na mesma transacao, pela mesma
--      revalidacao de sempre (acoes_massivas_universo). Ninguem precisa voltar.
--   2. O lote continua guardando o SELECIONADO/EXPORTADO. Isso NAO e "enviado":
--      nao existe retorno tecnico da mensageria (conferido: whatsapp_mensagens
--      nao tem coluna de status de entrega e nao se liga a lote nem a aluno).
--      Passa a guardar tambem `registrados` -- o que foi gravado no CRM.
--   3. O registro e IDEMPOTENTE: indice unico parcial (lote_id, aluno_id) e
--      `on conflict do nothing`. Chamar de novo nao cria linha nova.
--   4. A acao massiva volta a contar como ultimo acionamento do aluno/caso --
--      so se for MAIS RECENTE que o acionamento existente (a guarda ja estava
--      no gatilho e continua: `data_ultimo_acionamento < new.registrado_em`).
--      Com isso volta a valer a fidelizacao de 10 dias, e o aluno cujo unico
--      acionamento valido e massivo deixa de ser "nunca acionado".
--   5. NAO cria data_retorno, NAO grava status_acionamento, NAO troca
--      responsavel, NAO libera aluno, NAO toca acordo/pagamento/baixa/titulo.
--
-- O QUE NAO MUDA, DE PROPOSITO:
--   * os 4 lotes pendentes de 01 e 02/10 ficam intocados (nenhum update neles);
--   * nenhum backfill de 17 e 18/09;
--   * lotes descartados ficam descartados;
--   * nenhuma movimentacao existente e recriada, alterada ou apagada;
--   * acoes_massivas_concluir_lote continua existindo e funcionando, para os
--     lotes antigos que ainda estao abertos.
--
-- HISTORICO: esta regra ja oscilou (20260826260000 acao_massiva_externa_volta_a
-- _registrar, 20260827310000 acao_massiva_conta_como_acionamento, 20260920120000
-- registro_sem_fidelizacao). Esta migration retoma a contagem como acionamento
-- SEM retomar o retorno +10 nem a troca de responsavel, que eram o motivo real
-- da reclamacao de 20/09.

-- ------------------------------------------------- 0. pre-condicoes e trava
-- Idempotencia so e garantida se nao houver par duplicado hoje. Falha alto.
do $pre$
declare v_dup int;
begin
  select count(*) into v_dup from (
    select lote_id, aluno_id
      from public.aluno_movimentacoes
     where lote_id is not null
     group by 1, 2 having count(*) > 1) d;
  if v_dup > 0 then
    raise exception 'Existem % pares (lote_id, aluno_id) duplicados: o indice unico nao pode ser criado sem decisao sobre eles.', v_dup
      using errcode = '55000';
  end if;
end $pre$;

create unique index if not exists ux_aluno_mov_lote_aluno
  on public.aluno_movimentacoes (lote_id, aluno_id)
  where lote_id is not null;

comment on index public.ux_aluno_mov_lote_aluno is
  'Um aluno so entra uma vez em cada lote de acao massiva. E a trava de idempotencia do registro automatico.';

alter table public.acoes_massivas_lotes
  add column if not exists registrados         integer,
  add column if not exists registro_automatico boolean not null default false;

comment on column public.acoes_massivas_lotes.total is
  'Quantidade SELECIONADA/EXPORTADA. NAO e "enviado": nao existe retorno da mensageria.';
comment on column public.acoes_massivas_lotes.registrados is
  'Movimentacoes individuais efetivamente gravadas no CRM para este lote.';
comment on column public.acoes_massivas_lotes.registro_automatico is
  'true = registrado na propria exportacao (regra de 02/10). false = lote antigo, registrado pelo clique de confirmacao.';

-- ------------------------------------------- 1. gatilho do ultimo acionamento
-- Volta a tratar acao massiva como acionamento. A unica diferenca para o
-- contato do operador continua sendo o que a acao massiva NAO faz (retorno,
-- status, responsavel) -- e isso esta em registrar_acao_massiva, nao aqui.
create or replace function public.fn_atualizar_ultimo_acionamento()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  -- SO AVANCA: um acionamento mais antigo nunca sobrescreve um mais novo.
  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = new.registrado_em::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < new.registrado_em::date);

  begin
    perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
  exception when others then
    null;
  end;

  return new;
exception when others then
  -- nunca impedir o registro do acionamento por falha na atualizacao da ficha
  return new;
end;
$function$;

-- --------------------------------------------------------- 2. registrar
-- Mesma assinatura, mesma revalidacao. Muda so a gravacao: on conflict do
-- nothing, e a contagem separa registrado de ja_registrado.
create or replace function public.registrar_acao_massiva(
  p_aluno_ids text[],
  p_canal text,
  p_arquivo text,
  p_registrado_por_nome text,
  p_registrado_por_email text,
  p_operador_email text default null,
  p_lote_id uuid default null,
  p_filtros jsonb default null
) returns jsonb
language plpgsql security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
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

  -- Esta funcao NAO dispara nada: registra uma acao que aconteceu POR FORA
  -- (planilha). Disparar em massa pelo nosso numero segue proibido no gateway.

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

    -- Unico efeito: a movimentacao individual, ligada ao lote. Nao toca em
    -- alunos (quem avanca data_ultimo_acionamento e o gatilho, e so para frente).
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
      -- ja existia para este lote: idempotencia, nao e exclusao nem erro.
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
$function$;

comment on function public.registrar_acao_massiva(text[], text, text, text, text, text, uuid, jsonb) is
  'Registra a movimentacao individual (com lote_id) de uma acao massiva, revalidando pela fonte unica acoes_massivas_universo. Idempotente por (lote_id, aluno_id). Conta como acionamento pelo gatilho. NAO dispara nada, NAO altera responsavel, NAO cria retorno.';

-- ---------------------------------------------------------- 3. exportar
-- Exportar passa a ser o EVENTO UNICO: revalida, grava o lote, registra as
-- movimentacoes e devolve os contatos para a planilha. Mesma assinatura.
create or replace function public.acoes_massivas_exportar(
  p_aluno_ids text[],
  p_canal text,
  p_arquivo text default null,
  p_operador_email text default null,
  p_tipo_cobranca text default null,
  p_previa_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
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

    -- REGISTRO AUTOMATICO, na mesma transacao. Revalida de novo pela mesma
    -- fonte (quem saiu do universo entre uma leitura e outra fica de fora, com
    -- o motivo). Ninguem precisa voltar e clicar depois.
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

comment on function public.acoes_massivas_exportar(text[], text, text, text, text, uuid) is
  'Exporta a planilha E registra as movimentacoes individuais do lote na mesma transacao (regra de 02/10). total = SELECIONADO, nunca "enviado": nao ha retorno da mensageria.';

-- ----------------------------------------------- 4. concluir lote (legado)
-- Continua existindo para os lotes antigos que ficaram abertos. Muda so o
-- CONFIRMAR repetido: em vez de estourar, devolve o resultado guardado e nao
-- grava nada. Os 4 lotes pendentes de 01 e 02/10 NAO sao tocados por esta
-- migration -- sao tocados quando alguem decidir concluí-los.
create or replace function public.acoes_massivas_concluir_lote(p_lote_id uuid, p_acao text)
returns jsonb
language plpgsql security definer
set search_path to 'public'
set statement_timeout to '120s'
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

  -- IDEMPOTENCIA: ja registrado -> devolve o que foi gravado, sem escrever.
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

  -- Contato posterior a exportacao: o mais novo manda, a campanha nao sobrescreve.
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
$function$;

-- --------------------------------------------------------------------- ACL
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('registrar_acao_massiva', 'acoes_massivas_exportar', 'acoes_massivas_concluir_lote')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;
