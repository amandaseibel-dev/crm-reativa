-- TITULO DEVOLVIDO: o desfecho sem recuperacao deixa de se chamar "CANCELADA".
--
-- Regra da gestao em 08/10/2026:
--   DEVOLVIDO -- tabulacao que encerra o saldo SEM recuperacao pela ReATIVA;
--   NEGOCIADO -- acordo realizado com parcelas ainda pendentes;
--   QUITADO   -- todas as parcelas do acordo quitadas ou pagamento confirmado.
-- E: corrigir os gatilhos para PRESERVAR esses status, sem reversao automatica;
-- e garantir que valor devolvido NAO conte como recuperacao financeira.
--
-- O QUE JA ESTAVA CERTO, medido em producao antes de escrever isto. NEGOCIADO e
-- QUITADO nao sao alterados aqui porque ja se comportam como a regra pede:
-- `_titulo_situacao_e_status_coerentes` ja casa NEGOCIADO<->'vinculada' (acordo
-- vivo com parcela pendente) e PAGO<->'quitada' (acordo zerado ou pagamento
-- confirmado, com `origem_liquidacao`). O rotulo armazenado da quitacao e
-- 'PAGO'/'quitada'; renomear para 'QUITADO' tocaria 19 funcoes que filtram
-- `lower(status)='quitada'` para ZERO mudanca de comportamento, entao fica como
-- decisao separada da gestao. O QUE FALTAVA de verdade era o DEVOLVIDO.
--
-- POR QUE 'CANCELADA' ESTAVA ERRADO. O motor gravava `situacao='CANCELADA'` para
-- as cinco tabulacoes de devolucao. Mas CANCELADA ja significa outra coisa na
-- base -- saida administrativa pela Conferencia Prime (29 titulos,
-- R$ 286.319,45) -- e misturar as duas causas no mesmo rotulo apaga a diferenca
-- entre "a divida saiu porque alguem a devolveu" e "a divida saiu porque nao
-- era nossa". Sao 2 origens distintas em `origem_encerramento` e passam a ter 2
-- rotulos distintos.
--
-- OS CINCO PONTOS QUE O LEVANTAMENTO ENCONTROU, e por que todos tem de mudar
-- juntos: escrever DEVOLVIDO sem tocar os quatro gatilhos abaixo nao funciona,
-- e em dois dos casos falha EM SILENCIO.
--
--   1. `parcela_efeito_sem_pagamento_aplicar` -- gravava CANCELADA e so
--      alcancava titulo em ABERTO/NEGOCIADO.
--
--   2. `_trg_auto_quitar_titulo` -- O MAIS GRAVE. O early return esta fixado em
--      `new.situacao = 'CANCELADA'`. Com DEVOLVIDO ele NAO casaria, cairia no
--      bloco seguinte (old em ABERTO/NEGOCIADO/EM_CONFIRMACAO, new fora dessa
--      lista) e chamaria `_talvez_quitar_aluno`. A devolucao QUITARIA o aluno --
--      recuperacao falsa, exatamente o que a regra 6 proibe.
--
--   3. `_titulo_encerrado_administrativo_protegido` -- em qualquer toque
--      posterior num titulo ja encerrado ele FORCA 'CANCELADA'/'cancelada'. O
--      rotulo DEVOLVIDO apodreceria para CANCELADA sozinho, sem ninguem mexer.
--
--   4. `_titulo_em_confirmacao_protegido` -- tirar titulo de EM_CONFIRMACAO sem
--      `conferencia_prime.decisao='on'` e REVERTIDO EM SILENCIO (ele reescreve
--      new := old e loga a recusa). O motor diria "encerrei 1 titulo" e nao
--      teria encerrado nada.
--
--   5. `_titulo_situacao_e_status_coerentes` -- nao tem ramo para DEVOLVIDO,
--      entao `status` nao seria normalizado.
--
-- POR QUE O MOTOR PASSA A ALCANCAR EM_CONFIRMACAO. Foi o defeito medido hoje:
-- 3 alunos tabulados ANTECIPACAO_SEMESTRE seguem com a mensalidade contando
-- (R$ 31.925,06) porque o titulo estava em EM_CONFIRMACAO no instante da
-- tabulacao. Trilha do titulo 4406533: foi para EM_CONFIRMACAO em 18/09, a
-- antecipacao rodou em 08/10 as 18:02:06 com ele ainda em confirmacao (motor
-- devolveu ok:true com titulos_encerrados_qtd = 0 e saldo_antes = 0,00, porque
-- EM_CONFIRMACAO tambem esta fora do saldo) e as 18:02:37 -- 31 segundos depois
-- -- ele voltou para ABERTO. O efeito e tiro unico e ja tinha passado.
-- Retabular o mesmo codigo nao resolve: `trg_tabulacao_efeito_financeiro` e
-- `AFTER UPDATE OF status_jornada` e sai se o status nao mudou.
-- Armadilha ainda aberta hoje: 643 titulos / 381 alunos / R$ 842.223,42 em
-- EM_CONFIRMACAO.
--
-- DUPLICADA fica DE FORA, por decisao da gestao: ja e titulo que nao conta por
-- outra causa, e encerra-lo por tabulacao misturaria duas causas no mesmo
-- `origem_encerramento`.
--
-- ROLLBACK: supabase/rollbacks/20261008190000_titulo_devolvido_status.rollback.sql

-- ---------------------------------------------------------------------------
-- 1. COERENCIA: DEVOLVIDO <-> devolvido
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

-- ---------------------------------------------------------------------------
-- 2. AUTO QUITAR: devolucao NAO e quitacao  <- a garantia da regra 6
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. PROTECAO DO ENCERRADO: preserva o rotulo que o titulo recebeu
-- ---------------------------------------------------------------------------
-- Antes ela FIXAVA 'CANCELADA'. Agora restaura `old.situacao`/`old.status`.
-- Para os 48 titulos ja encerrados o efeito e IDENTICO (todos sao CANCELADA,
-- logo restaurar `old` restaura CANCELADA); a diferenca e que um titulo
-- encerrado como DEVOLVIDO deixa de ser rebatido para CANCELADA. Uma protecao
-- que ALTERA o dado que deveria proteger era, ela mesma, uma reversao
-- automatica -- o que a regra 4 manda remover.
create or replace function public._titulo_encerrado_administrativo_protegido()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_oficial boolean := coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on';
begin
  if v_oficial or old.origem_encerramento is null then
    return new;
  end if;
  if upper(coalesce(new.situacao,'')) is distinct from upper(coalesce(old.situacao,''))
     or lower(coalesce(new.status,'')) is distinct from lower(coalesce(old.status,''))
     or new.origem_encerramento is distinct from old.origem_encerramento
     or new.origem_encerramento_ref is distinct from old.origem_encerramento_ref
     or new.origem_encerramento_em is distinct from old.origem_encerramento_em then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('sistema', 'TITULO_ENCERRADO_ADMINISTRATIVO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,
            jsonb_build_object('documento', old.documento,
                               'tentou_situacao', new.situacao, 'tentou_status', new.status,
                               'preservou_situacao', old.situacao, 'preservou_status', old.status));
    new.situacao := old.situacao;
    new.status := old.status;
    new.origem_encerramento := old.origem_encerramento;
    new.origem_encerramento_ref := old.origem_encerramento_ref;
    new.origem_encerramento_em := old.origem_encerramento_em;
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. O MOTOR: grava DEVOLVIDO, alcanca EM_CONFIRMACAO e PROVA que gravou
-- ---------------------------------------------------------------------------
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

comment on function public.parcela_efeito_sem_pagamento_aplicar(uuid, text, text, boolean) is
  'Aplica o efeito financeiro de uma tabulacao sem pagamento. O efeito vem do catalogo (tabulacoes.efeito_desfecho), nunca do chamador. DEVOLVE_PARCELA: parcela DEVOLVIDA e mensalidade DEVOLVIDO (nao CANCELADA -- cancelamento e a saida administrativa da Conferencia Prime). SUSPENDE_PARCELA: parcela SUSPENSA e titulo intocado, porque a divida continua existindo. Alcanca titulo em ABERTO, NEGOCIADO e EM_CONFIRMACAO, e prova que gravou antes de confirmar. Nunca escreve PAGO, pago_em, origem_baixa, honorarios, quitado_em nem origem_quitacao.';

-- ---------------------------------------------------------------------------
-- ASSEGURACAO. Estrutural: nao escreve dado nenhum. O comportamento e provado
-- pela suite (supabase/tests/titulo_devolvido_status.test.js), que roda o motor
-- de verdade contra um Postgres isolado.
-- ---------------------------------------------------------------------------
do $prova$
declare
  v_falhas text[] := '{}';
  v_corpo   text;
begin
  -- 1. os 4 objetos de banco existem
  foreach v_corpo in array array['_titulo_situacao_e_status_coerentes',
                                 '_trg_auto_quitar_titulo',
                                 '_titulo_encerrado_administrativo_protegido',
                                 'parcela_efeito_sem_pagamento_aplicar'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = v_corpo) then
      v_falhas := v_falhas || ('funcao ausente: ' || v_corpo);
    end if;
  end loop;

  -- 2. a garantia da regra 6: devolucao nao pode chamar quitacao
  select pg_get_functiondef(p.oid) into v_corpo
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='_trg_auto_quitar_titulo';
  if v_corpo !~ '''CANCELADA''\s*,\s*''DEVOLVIDO''' then
    v_falhas := v_falhas || 'auto_quitar: DEVOLVIDO nao esta no early return -- devolucao quitaria o aluno';
  end if;

  -- 3. a protecao do encerrado nao fixa mais CANCELADA
  select pg_get_functiondef(p.oid) into v_corpo
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='_titulo_encerrado_administrativo_protegido';
  if v_corpo ~ 'new\.situacao\s*:=\s*''CANCELADA''' then
    v_falhas := v_falhas || 'protecao do encerrado ainda fixa CANCELADA -- DEVOLVIDO seria rebatido';
  end if;
  if v_corpo !~ 'new\.situacao\s*:=\s*old\.situacao' then
    v_falhas := v_falhas || 'protecao do encerrado nao restaura old.situacao';
  end if;

  -- 4. o motor grava DEVOLVIDO, alcanca EM_CONFIRMACAO e prova que gravou
  select pg_get_functiondef(p.oid) into v_corpo
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='parcela_efeito_sem_pagamento_aplicar';
  if v_corpo ~ 'situacao\s*=\s*''CANCELADA''' then
    v_falhas := v_falhas || 'motor ainda grava CANCELADA no titulo';
  end if;
  if v_corpo !~ 'situacao\s*=\s*''DEVOLVIDO''' then
    v_falhas := v_falhas || 'motor nao grava DEVOLVIDO';
  end if;
  if v_corpo !~ '''ABERTO''\s*,\s*''NEGOCIADO''\s*,\s*''EM_CONFIRMACAO''' then
    v_falhas := v_falhas || 'motor nao alcanca EM_CONFIRMACAO';
  end if;
  if v_corpo !~ 'reverteu em sil' then
    v_falhas := v_falhas || 'motor sem asseguracao contra reversao silenciosa';
  end if;
  -- o contrato que nao pode cair: nada de pagamento
  if v_corpo ~ 'set\s+pago_em' or v_corpo ~ 'origem_baixa\s*=' or v_corpo ~ 'honorarios\s*=' then
    v_falhas := v_falhas || 'motor passou a escrever marca de pagamento';
  end if;

  -- 5. o par DEVOLVIDO/devolvido e coerente
  select pg_get_functiondef(p.oid) into v_corpo
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='_titulo_situacao_e_status_coerentes';
  if v_corpo !~ '''DEVOLVIDO''' then
    v_falhas := v_falhas || 'coerencia nao conhece DEVOLVIDO';
  end if;

  if array_length(v_falhas,1) > 0 then
    raise exception 'titulo DEVOLVIDO -- asseguracao falhou: %', array_to_string(v_falhas, ' | ');
  end if;

  raise notice 'titulo DEVOLVIDO OK -- 4 funcoes no lugar, devolucao nao quita, protecao preserva o rotulo, motor alcanca EM_CONFIRMACAO e prova a escrita.';
end
$prova$;
