-- ROLLBACK de 20261008192000_titulo_suspenso_status.sql
--
-- Volta ao estado da 20261008190000: titulo DEVOLVIDO existe, SUSPENSO nao.
--
-- ATENCAO AO DADO. Se a migration ja rodou e alguma suspensao foi aplicada
-- depois dela, havera titulo com `situacao='SUSPENSO'` na base. Este rollback
-- DEVOLVE esses titulos ao estado gravado em `suspensao_situacao_anterior`
-- ANTES de restaurar as funcoes -- porque com as funcoes antigas de volta
-- ninguem mais saberia reverte-los, e eles ficariam fora do saldo para sempre.
--
-- As colunas `suspensao_*` NAO sao removidas: dado de reversao nao se apaga em
-- rollback. Ficam vazias e inertes.

-- ---------------------------------------------------------------------------
-- 1. PRIMEIRO o dado: nenhum titulo pode sobrar SUSPENSO
-- ---------------------------------------------------------------------------
do $devolve$
declare v_qtd int := 0;
begin
  perform set_config('conferencia_prime.decisao', 'on', true);
  with t as (
    update public.acordos_titulos t
       set situacao = coalesce(nullif(t.suspensao_situacao_anterior,''), 'ABERTO'),
           status   = coalesce(nullif(t.suspensao_status_anterior,''), 'em_aberto'),
           suspensao_situacao_anterior = null,
           suspensao_status_anterior   = null,
           suspensao_origem = null,
           suspensao_em     = null,
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'rollback de 20261008192000: mensalidade devolvida ao estado anterior a suspensao.',
           atualizado_em = now()
     where upper(coalesce(t.situacao,'')) = 'SUSPENSO'
    returning t.id)
  select count(*) into v_qtd from t;
  perform set_config('conferencia_prime.decisao', '', true);

  if exists (select 1 from public.acordos_titulos where upper(coalesce(situacao,'')) = 'SUSPENSO') then
    raise exception 'rollback: sobrou titulo SUSPENSO. Abortado -- restaurar as funcoes agora deixaria esses titulos sem caminho de volta.';
  end if;
  raise notice 'rollback: % titulo(s) devolvido(s) do SUSPENSO ao estado anterior.', v_qtd;
end
$devolve$;

-- a constraint de coerencia da suspensao sai; as colunas FICAM
alter table public.acordos_titulos
  drop constraint if exists acordos_titulos_suspensao_coerente;

-- ---------------------------------------------------------------------------
-- 2. e so depois as funcoes, nos corpos da 20261008190000
-- ---------------------------------------------------------------------------
create or replace function public._titulo_situacao_e_status_coerentes()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  -- + 08/10/2026: devolucao sem recuperacao. Par proprio, para nao se
  -- confundir com CANCELADA (saida administrativa pela Conferencia Prime).
  elsif v_sit = 'DEVOLVIDO' and v_st <> 'devolvido' then
    new.status := 'devolvido';
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$function$;

create or replace function public._trg_auto_quitar_titulo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- EM_CONFIRMACAO conta como divida ainda nao resolvida: entrar nele nao
  -- quita ninguem; sair dele para PAGO (baixa confirmada) segue quitando.
  --
  -- CANCELADA e DEVOLVIDO sao saidas ADMINISTRATIVAS, nao quitacao:
  --   CANCELADA  -- saiu da base / encerramento pela Conferencia Prime;
  --   DEVOLVIDO  -- + 08/10/2026: devolvido sem recuperacao pela ReATIVA.
  -- Nenhuma das duas chama `_talvez_quitar_aluno`.
  --
  -- O 'DEVOLVIDO' aqui NAO e cosmetico: sem ele o titulo devolvido cairia no
  -- bloco seguinte (old em ABERTO/NEGOCIADO/EM_CONFIRMACAO e new fora da
  -- lista) e a devolucao quitaria o aluno, criando recuperacao que nao
  -- existiu.
  if upper(coalesce(new.situacao,'')) in ('CANCELADA','DEVOLVIDO') then
    return new;
  end if;
  if upper(coalesce(old.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO') then
    perform public._talvez_quitar_aluno(new.aluno_id);
  end if;
  return new;
end;
$function$;

create or replace function public.parcela_efeito_sem_pagamento_aplicar(p_aluno_id uuid, p_motivo text, p_origem text, p_dry_run boolean DEFAULT true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_efeito_cat text;
  v_efeito  text;
  v_definitivo boolean;
  v_nome text; v_st_ant text;
  v_saldo_antes jsonb; v_saldo_depois jsonb;
  v_parc_qtd int := 0; v_parc_val numeric := 0;
  v_tit_qtd int := 0;  v_tit_val numeric := 0;
  v_tit_ids uuid[] := '{}';
  v_ref text;
begin
  if p_aluno_id is null then
    raise exception 'aluno_id nulo.' using errcode = '22023';
  end if;

  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Aplicar devolução ou suspensão de parcela é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;

  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatório: registre o que a unidade confirmou e quando.'
      using errcode = '22023';
  end if;

  -- O EFEITO VEM DO CATALOGO, nunca do chamador. Assim nao existe caminho que
  -- devolva parcela por uma tabulacao que a gestao marcou como suspensao.
  select t.efeito_desfecho into v_efeito_cat
    from public.tabulacoes t
   where t.codigo = p_origem and t.ativa and t.efeito_desfecho is not null;

  if v_efeito_cat is null then
    raise exception 'Tabulação % não tem efeito financeiro no catálogo (tabulacoes.efeito_desfecho).', coalesce(p_origem,'(nula)')
      using errcode = '22023';
  end if;

  v_efeito := case v_efeito_cat when 'DEVOLVE_PARCELA' then 'DEVOLVIDA' else 'SUSPENSA' end;
  v_definitivo := (v_efeito_cat = 'DEVOLVE_PARCELA');

  select nome, coalesce(status_jornada, status_atual, '(sem status)')
    into v_nome, v_st_ant
    from public.alunos where id = p_aluno_id;

  if not exists (select 1 from public.alunos where id = p_aluno_id) then
    raise exception 'Aluno % não existe.', p_aluno_id using errcode = '22023';
  end if;

  v_saldo_antes := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);
  v_ref := lower(p_origem) || ':' || p_aluno_id::text;

  if p_dry_run then
    select count(*), coalesce(sum(coalesce(p.valor,0)),0)
      into v_parc_qtd, v_parc_val
      from public.parcelas p
      join public.acordos a on a.id = p.acordo_id
     where a.aluno_id = p_aluno_id
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and public.parcela_viva(p.status);

    if v_definitivo then
      select count(*), coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)),0)
        into v_tit_qtd, v_tit_val
        from public.acordos_titulos t
       where t.aluno_id = p_aluno_id
         -- + 08/10/2026: EM_CONFIRMACAO entra. Era o furo: titulo parado em
         -- confirmacao escapava do desfecho e voltava a contar depois.
         and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
         and coalesce(lower(t.status),'') not in ('quitada')
         and t.origem_encerramento is null
         and not exists (
           select 1 from public.acordo_titulo_vinculo v
             join public.acordos a on a.id = v.acordo_id
            where v.titulo_id = t.id and coalesce(v.ativo, true)
              and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));
    end if;

    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'aluno_id', p_aluno_id,
      'origem', p_origem, 'efeito', v_efeito, 'definitivo', v_definitivo,
      'parcelas_afetadas_qtd', v_parc_qtd, 'parcelas_afetadas_valor', round(v_parc_val,2),
      'titulos_a_encerrar_qtd', v_tit_qtd, 'titulos_a_encerrar_valor', round(v_tit_val,2),
      'saldo_antes', (v_saldo_antes->>'total')::numeric);
  end if;

  perform set_config('parcela_efeito_sem_pagamento.aplicando', 'on', true);

  -- (a) A PARCELA. Nunca PAGO (regra 1). `pago_em`, `origem_baixa` e
  -- `honorarios` ficam INTOCADOS -- nao houve pagamento nem baixa.
  with q as (
    update public.parcelas p
       set status = v_efeito,
           efeito_sem_pagamento = v_efeito,
           efeito_sem_pagamento_origem = p_origem,
           efeito_sem_pagamento_por = coalesce(nullif(v_email,''), 'sistema'),
           efeito_sem_pagamento_em = now(),
           observacao = coalesce(p.observacao,'')
             || case when coalesce(p.observacao,'') = '' then '' else ' | ' end
             || case when v_definitivo
                     then 'DEVOLVIDA em ' else 'SUSPENSA em ' end
             || to_char(now(),'DD/MM/YYYY') || ' por ' || coalesce(nullif(v_email,''),'gestão')
             || ' (' || p_origem || '): ' || btrim(p_motivo)
             || '. Sem pagamento, sem baixa e sem honorário.',
           atualizado_em = now()
     where p.acordo_id in (
             select a.id from public.acordos a
              where a.aluno_id = p_aluno_id
                and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
       and public.parcela_viva(p.status)
    returning coalesce(p.valor,0) as valor)
  select count(*), coalesce(sum(valor),0) into v_parc_qtd, v_parc_val from q;

  -- (b) O TITULO DO ALUNO -- so no caso DEFINITIVO. Em suspensao a divida
  -- continua existindo: o aluno sai da cobranca, o titulo nao sai da base.
  if v_definitivo then
    -- O OVERRIDE E NECESSARIO E E ESTREITO. `_titulo_em_confirmacao_protegido`
    -- reverte EM SILENCIO qualquer saida de EM_CONFIRMACAO sem esta chave --
    -- reescreve new := old e apenas loga a recusa. Sem ela o UPDATE abaixo
    -- "funcionaria" e nao mudaria nada. A chave e transacional (3o argumento
    -- true), vale so para este bloco e e desligada logo depois; os titulos ja
    -- encerrados seguem fora do alvo pelo `origem_encerramento is null`.
    perform set_config('conferencia_prime.decisao', 'on', true);

    with e as (
      update public.acordos_titulos t
         set situacao = 'DEVOLVIDO',
             status   = 'devolvido',
             origem_encerramento     = p_origem,
             origem_encerramento_ref = v_ref,
             origem_encerramento_em  = now(),
             motivo_ajuste = coalesce(t.motivo_ajuste,'')
               || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
               || 'devolvido sem recuperação (' || p_origem || ') em '
               || to_char(now(),'DD/MM/YYYY') || ' por ' || coalesce(nullif(v_email,''),'gestão')
               || ': ' || btrim(p_motivo)
               || '. Não foi pago a nós. Sem pagamento, acordo ou recuperação.',
             atualizado_em = now()
       where t.aluno_id = p_aluno_id
         and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
         and coalesce(lower(t.status),'') not in ('quitada')
         and t.origem_encerramento is null
         and not exists (
           select 1 from public.acordo_titulo_vinculo v
             join public.acordos a on a.id = v.acordo_id
            where v.titulo_id = t.id and coalesce(v.ativo, true)
              and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
      returning t.id as id, coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor)
    select count(*), coalesce(sum(valor),0), coalesce(array_agg(id), '{}')
      into v_tit_qtd, v_tit_val, v_tit_ids
      from e;

    perform set_config('conferencia_prime.decisao', '', true);

    -- ASSEGURACAO CONTRA REVERSAO SILENCIOSA. Nao basta o UPDATE "ter rodado":
    -- ha gatilhos BEFORE nesta tabela que reescrevem NEW e so registram a
    -- recusa numa tabela de auditoria. Se qualquer titulo do alvo nao estiver
    -- DEVOLVIDO/devolvido agora, a transacao inteira volta.
    if v_tit_qtd > 0 and exists (
      select 1 from public.acordos_titulos t
       where t.id = any(v_tit_ids)
         and (upper(coalesce(t.situacao,'')) <> 'DEVOLVIDO'
              or lower(coalesce(t.status,''))  <> 'devolvido'
              or t.origem_encerramento is distinct from p_origem)) then
      raise exception 'efeito sem pagamento: algum título do aluno % não ficou DEVOLVIDO depois do UPDATE -- um gatilho reverteu em silêncio. Abortado sem gravar nada.', p_aluno_id
        using errcode = 'P0001';
    end if;
  end if;

  -- (c) MARCADOR OPERACIONAL. `quitado_em` e `origem_quitacao` seguem NULOS:
  -- nada disto e quitacao (regra 4).
  update public.alunos
     set status_atual = p_origem,
         status_jornada = p_origem,
         status_acionamento = p_origem,
         situacao_operacional = p_origem,
         valor_em_aberto = case when v_definitivo then 0 else valor_em_aberto end,
         fila_destino = null,
         proxima_acao = null,
         data_retorno = null,
         hora_retorno = null
   where id = p_aluno_id;

  update public.casos
     set status_atual = p_origem,
         status_jornada = p_origem,
         status_acionamento = p_origem,
         status_financeiro = p_origem,
         situacao_operacional = p_origem,
         total_em_aberto = case when v_definitivo then 0 else total_em_aberto end,
         nao_acionar = true,
         quitado_em = null,
         origem_quitacao = null,
         data_retorno = null,
         proxima_acao_automatica = null,
         caso_atualizado_por = coalesce(nullif(v_email,''), 'sistema'),
         caso_atualizado_em = now()
   where aluno_id = p_aluno_id;

  v_saldo_depois := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);

  insert into public.parcela_efeito_sem_pagamento_auditoria
    (aluno_id, motivo, efeito, origem,
     parcelas_quitadas_qtd, parcelas_quitadas_valor,
     titulos_encerrados_qtd, titulos_encerrados_valor,
     saldo_antes, saldo_depois, status_anterior, executado_por)
  values (p_aluno_id, btrim(p_motivo), v_efeito, p_origem,
          v_parc_qtd, round(v_parc_val,2), v_tit_qtd, round(v_tit_val,2),
          (v_saldo_antes->>'total')::numeric, (v_saldo_depois->>'total')::numeric,
          v_st_ant, coalesce(nullif(v_email,''), 'sistema'));

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (p_aluno_id::text, 'PARCELA_' || v_efeito,
    case when v_definitivo then 'Devolução' else 'Suspensão' end
      || ' aplicada por ' || p_origem || ': ' || v_parc_qtd || ' parcela(s) marcada(s) como '
      || v_efeito || ' (' || public.fmt_brl(round(v_parc_val,2)) || ')'
      || case when v_definitivo
              then ' e ' || v_tit_qtd || ' mensalidade(s) marcada(s) como DEVOLVIDO ('
                   || public.fmt_brl(round(v_tit_val,2)) || '), que deixam de contabilizar no saldo.'
              else '. A dívida continua existindo: a cobrança está suspensa, não encerrada.' end
      || ' Nenhum pagamento, baixa, honorário ou recuperação foi gerado. Motivo: ' || btrim(p_motivo),
    v_st_ant, p_origem,
    coalesce(v_nome, nullif(v_email,''), 'gestão'), coalesce(nullif(v_email,''),'sistema'), now(),
    round(v_parc_val + v_tit_val, 2));

  return jsonb_build_object(
    'ok', true, 'dry_run', false, 'aluno_id', p_aluno_id,
    'origem', p_origem, 'efeito', v_efeito, 'definitivo', v_definitivo,
    'parcelas_afetadas_qtd', v_parc_qtd, 'parcelas_afetadas_valor', round(v_parc_val,2),
    'titulos_encerrados_qtd', v_tit_qtd, 'titulos_encerrados_valor', round(v_tit_val,2),
    'saldo_antes', (v_saldo_antes->>'total')::numeric,
    'saldo_depois', (v_saldo_depois->>'total')::numeric);
end;
$function$;

-- reativacao volta ao corpo de producao: so parcelas, sem titulo
create or replace function public.suspensao_cobranca_reativar(p_aluno_id uuid, p_motivo text, p_dry_run boolean DEFAULT true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_qtd int := 0; v_val numeric := 0;
  v_nome text;
  v_recalc jsonb;
begin
  if p_aluno_id is null then
    raise exception 'aluno_id nulo.' using errcode = '22023';
  end if;
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Levantar suspensão de cobrança é decisão da gestão.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatório para levantar a suspensão.' using errcode = '22023';
  end if;

  select nome into v_nome from public.alunos where id = p_aluno_id;

  if p_dry_run then
    select count(*), coalesce(sum(coalesce(p.valor,0)),0) into v_qtd, v_val
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where a.aluno_id = p_aluno_id and upper(coalesce(p.status,'')) = 'SUSPENSA';
    return jsonb_build_object('ok', true, 'dry_run', true, 'aluno_id', p_aluno_id,
      'parcelas_a_reativar_qtd', v_qtd, 'parcelas_a_reativar_valor', round(v_val,2));
  end if;

  perform set_config('parcela_efeito_sem_pagamento.aplicando', 'on', true);

  -- Volta para A_VENCER ou VENCIDA conforme o vencimento -- a mesma regra do
  -- cron `atualizar_parcelas_vencidas`, para que o estado nao dependa de quando
  -- a suspensao foi levantada.
  with v as (
    update public.parcelas p
       set status = case when p.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
           efeito_sem_pagamento = null,
           efeito_sem_pagamento_origem = null,
           efeito_sem_pagamento_por = null,
           efeito_sem_pagamento_em = null,
           observacao = coalesce(p.observacao,'')
             || case when coalesce(p.observacao,'') = '' then '' else ' | ' end
             || 'suspensão levantada em ' || to_char(now(),'DD/MM/YYYY')
             || ' por ' || coalesce(nullif(v_email,''),'gestão') || ': ' || btrim(p_motivo),
           atualizado_em = now()
     where p.acordo_id in (select a.id from public.acordos a where a.aluno_id = p_aluno_id)
       and upper(coalesce(p.status,'')) = 'SUSPENSA'
    returning coalesce(p.valor,0) as valor)
  select count(*), coalesce(sum(valor),0) into v_qtd, v_val from v;

  -- O aluno volta para a fila. `nao_acionar` sai, o status volta a neutro e o
  -- motor decide situacao, criticidade e retorno -- em vez de a funcao chutar.
  --
  -- `status_acionamento` recebe 'CONTATAR', NAO null. O gatilho
  -- `_acionamento_nao_volta_para_nulo` restaura o valor antigo quando alguem
  -- tenta anular esse campo ("acionamento e fato consumado"), e por isso a
  -- primeira versao desta funcao deixava 'SUSPENSAO_COBRANCA' gravado no aluno.
  -- Consequencia medida pelo teste: `aluno_bloqueio_administrativo` continuava
  -- devolvendo SUSPENSAO_COBRANCA, o saldo cobravel ficava em ZERO e a
  -- suspensao era, na pratica, IRREVERSIVEL. Valor real contorna o gatilho sem
  -- precisar desliga-lo.
  update public.casos
     set nao_acionar = false,
         status_atual = 'CONTATAR',
         status_jornada = null,
         status_acionamento = 'CONTATAR',
         status_financeiro = 'EM_ABERTO',
         situacao_operacional = null,
         caso_atualizado_por = coalesce(nullif(v_email,''), 'sistema'),
         caso_atualizado_em = now()
   where aluno_id = p_aluno_id;

  update public.alunos
     set status_atual = 'CONTATAR',
         status_jornada = null,
         status_acionamento = 'CONTATAR',
         situacao_operacional = null
   where id = p_aluno_id;

  -- A SUSPENSAO TEM DE TER CAIDO DE VERDADE. Sem esta conferencia, uma
  -- reativacao que nao reativa devolve `ok: true` e o saldo segue fora da
  -- cobranca -- erro silencioso, que e o pior tipo aqui.
  if public.aluno_bloqueio_administrativo(p_aluno_id) = 'SUSPENSAO_COBRANCA' then
    raise exception 'Reativação não levantou a suspensão: o portão ainda bloqueia o aluno %. Nada foi confirmado.', p_aluno_id
      using errcode = 'P0001';
  end if;

  v_recalc := public.recalcular_situacao_aluno(p_aluno_id, 'suspensao_reativada');

  update public.parcela_efeito_sem_pagamento_auditoria
     set revertida_em = now(), revertida_por = coalesce(nullif(v_email,''), 'sistema')
   where aluno_id = p_aluno_id and efeito = 'SUSPENSA' and revertida_em is null;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (p_aluno_id::text, 'SUSPENSAO_LEVANTADA',
    'Suspensão de cobrança levantada: ' || v_qtd || ' parcela(s) voltaram a ser cobráveis ('
      || public.fmt_brl(round(v_val,2)) || '). Motivo: ' || btrim(p_motivo),
    coalesce(v_recalc->>'situacao','CONTATAR'),
    coalesce(v_nome, nullif(v_email,''), 'gestão'), coalesce(nullif(v_email,''),'sistema'), now(),
    round(v_val,2));

  return jsonb_build_object('ok', true, 'dry_run', false, 'aluno_id', p_aluno_id,
    'parcelas_reativadas_qtd', v_qtd, 'parcelas_reativadas_valor', round(v_val,2),
    'situacao', v_recalc->>'situacao');
end;
$function$;
