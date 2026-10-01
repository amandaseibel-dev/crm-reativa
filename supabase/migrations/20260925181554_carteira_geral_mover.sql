-- ---------------------------------------------------------------------------
-- CARTEIRA GERAL — execucao do remanejamento e desfazer
--
-- SO SE EXECUTA O PLANO DA PREVIA. A funcao nao decide nada e nao refaz
-- consulta: le a lista congelada em carteira_geral_previas.itens, inclusive a
-- decisao `mover` de cada acordo. Antes de tocar em qualquer linha, CONFERE que
-- o mundo continua como estava na previa. O que mudou e RECUSADO e volta no
-- resultado — nunca reinterpretado.
--
-- O QUE MUDA: a custodia (quem trabalha o caso hoje).
--   . casos.operador_email / operador_nome / operador
--   . alunos.responsavel_atual_email / _nome
--   . acordos.operador_responsavel_email — SOMENTE os que a previa marcou
--
-- O QUE NAO MUDA, NUNCA:
--   . acordos.criado_por_email / criado_por_nome / confirmado_por_email
--   . pagamentos.operador_email  (e o que define honorario e comissao)
--   . baixas_pagamento, parcelas, titulos, valores, status financeiro
--   . historico_operadores_alunos e aluno_movimentacoes ja gravados
--   . O AGENDAMENTO DE RETORNO — ver abaixo
-- Quem negociou continua sendo quem negociou. Isto aqui e mudanca de fila, nao
-- reescrita de historia.
--
-- POR QUE NAO USAR alterar_responsavel_aluno EM LOTE
-- Aquela RPC tem COMPENSACAO embutida: ao tirar um caso de A, ela procura um
-- caso equivalente de B e devolve para A, para nao desequilibrar a carteira.
-- E a regra certa para uma troca pontual na ficha e a regra ERRADA para
-- recolher uma carteira inteira: recolher 735 casos da Olga devolveria ate 735
-- casos de outros operadores PARA A OLGA. Esta funcao nao compensa — e o
-- unico jeito de "recolher" significar recolher.
--
-- O CAMINHO DE ESCRITA e o oficial: internal.set_resp_aluno / set_resp_acordo,
-- que pertencem ao papel `reativa_responsavel_executor` e por isso atravessam
-- as travas _guard_resp_aluno e _guard_resp_acordo. Nao ha UPDATE direto em
-- responsavel aqui, nem GUC de bypass.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A troca de dono, com o AGENDAMENTO PRESERVADO.
--
-- `internal.set_resp_aluno` zera o agendamento sempre que o responsavel muda:
-- data_retorno, hora_retorno, proxima_acao (e, por tabela,
-- `limpar_retorno_origem` zera retorno_origem e
-- `tg_aluno_reset_retorno_confirmado` zera retorno_confirmado_em).
-- Faz sentido quando o caso vai para outra pessoa comecar do zero. NAO faz
-- sentido aqui: um retorno agendado e compromisso assumido com o aluno, e a
-- data e a hora tem de continuar valendo — so mudando a quem elas respondem.
--
-- Nao se mexe em set_resp_aluno (17 funcoes escrevem por ela). O agendamento e
-- lido ANTES, e devolvido DEPOIS, e a agenda do operador e reapontada para o
-- novo responsavel. `data_ultimo_acionamento` e `status_acionamento` ja estao
-- protegidos pelo gatilho _acionamento_nao_volta_para_nulo.
-- ---------------------------------------------------------------------------
create or replace function internal.carteira_geral_trocar_dono(
  p_aluno_id uuid,
  p_novo_email text,
  p_novo_nome text,
  p_tipo text,
  p_descricao text,
  p_autor_email text,
  p_autor_nome text
) returns void
language plpgsql
security definer
set search_path to 'public', 'internal'
as $fn$
declare
  v_data  date;
  v_hora  text;
  v_origem text;
  v_prox  text;
  v_conf  timestamptz;
  v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select data_retorno, hora_retorno, retorno_origem, proxima_acao, retorno_confirmado_em
    into v_data, v_hora, v_origem, v_prox, v_conf
    from public.alunos where id = p_aluno_id;

  perform internal.set_resp_aluno(p_aluno_id, p_novo_email, p_novo_nome,
                                  p_tipo, p_descricao, p_autor_email, p_autor_nome);

  -- Devolve o compromisso exatamente como estava. `limpar_retorno_origem` so
  -- apaga a origem quando a data e nula — com a data de volta, a origem fica.
  if v_data is not null then
    update public.alunos
       set data_retorno = v_data,
           hora_retorno = v_hora,
           retorno_origem = v_origem,
           proxima_acao = coalesce(v_prox, proxima_acao)
     where id = p_aluno_id;

    -- Em UPDATE separado, e de proposito. `tg_aluno_reset_retorno_confirmado`
    -- e BEFORE UPDATE OF data_retorno e zera retorno_confirmado_em sempre que a
    -- data muda — entao devolver os dois na mesma linha perderia a confirmacao.
    -- Mexendo so nesta coluna, aquele gatilho nao dispara.
    if v_conf is not null then
      update public.alunos set retorno_confirmado_em = v_conf where id = p_aluno_id;
    end if;
  end if;

  -- O caso tambem carrega a data; o UPDATE de titularidade nao a toca, mas a
  -- garantia fica explicita para quem ler depois.
  update public.casos
     set data_retorno = coalesce(data_retorno, v_data)
   where aluno_id = p_aluno_id;

  -- A agenda e do operador, nao do aluno: sem reapontar, o compromisso
  -- continuaria na lista de quem perdeu o caso. Data e hora (`retorno_em`)
  -- ficam intactas; so o dono muda.
  --
  -- Destino FILA LIVRE nao tem dono: manter a linha na agenda de quem perdeu o
  -- caso seria pior do que apaga-la. Ela e encerrada com o mesmo marcador que
  -- `assumir_caso_livre_aluno` ja usa ao liberar por troca. O compromisso em si
  -- NAO se perde: data, hora e origem ficam no aluno, e quem assumir o herda.
  if v_email is null then
    update public.operador_agenda
       set status = 'CANCELADO_LIBERACAO', atualizado_em = now()
     where aluno_id = p_aluno_id::text
       and coalesce(status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_LIBERACAO');
  else
    update public.operador_agenda
       set operador_email = v_email,
           operador_nome = p_novo_nome,
           atualizado_em = now()
     where aluno_id = p_aluno_id::text
       and coalesce(status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_LIBERACAO');
  end if;
end;
$fn$;

comment on function internal.carteira_geral_trocar_dono(uuid,text,text,text,text,text,text) is
  'Troca o responsavel do aluno preservando data, hora e origem do retorno agendado, e reaponta a agenda para o novo responsavel.';

-- ---------------------------------------------------------------------------
-- EXECUCAO
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_mover(
  p_previa_id uuid,
  p_motivo text
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
set statement_timeout to '300s'
as $fn$
declare
  v_autor       text := lower(coalesce(auth.jwt()->>'email',''));
  v_autor_nome  text;
  v_previa      public.carteira_geral_previas%rowtype;
  v_destino_email text;
  v_destino_nome  text;
  v_lote        uuid := gen_random_uuid();
  v_motivo      text := nullif(btrim(coalesce(p_motivo,'')),'');
  it            jsonb;
  ac            jsonb;
  v_caso_agora  text;
  v_aluno_agora text;
  v_ac_email    text;
  v_ac_status   text;
  v_movidos     int := 0;
  v_recusados   jsonb := '[]'::jsonb;
  v_acordos_mov int := 0;
  v_rec_por_acordo int := 0;
  v_ac_falha    text;
  v_ac_detalhe  jsonb;
  v_ac_n        int;
  v_retornos    int := 0;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para remanejar carteira.' using errcode = '42501';
  end if;
  if v_motivo is null then
    raise exception 'Informe o motivo do remanejamento.' using errcode = '22023';
  end if;

  select * into v_previa from public.carteira_geral_previas where id = p_previa_id for update;
  if not found then raise exception 'Previa nao encontrada.'; end if;
  if v_previa.executada_em is not null then
    raise exception 'Esta previa ja foi executada em %.', v_previa.executada_em;
  end if;
  if now() > v_previa.expira_em then
    raise exception 'Previa expirada (gerada em %). Gere uma nova.', v_previa.criado_em;
  end if;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_autor limit 1;

  v_destino_email := v_previa.destino_email;
  if v_destino_email is not null then
    select coalesce(u.nome, v_destino_email) into v_destino_nome
      from public.usuarios u where lower(u.email) = lower(v_destino_email);
  end if;

  for it in select * from jsonb_array_elements(v_previa.itens) loop
    -- ---------------- revalidacao do ALUNO ----------------
    select lower(nullif(btrim(coalesce(c.operador_email,'')),'')),
           lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),''))
      into v_caso_agora, v_aluno_agora
      from public.casos c
      join public.alunos al on al.id = c.aluno_id
     where c.aluno_id = (it->>'aluno_id')::uuid
     limit 1;

    if coalesce(v_caso_agora,'') is distinct from coalesce(it->>'caso_de_email','')
       or coalesce(v_aluno_agora,'') is distinct from coalesce(it->>'aluno_de_email','') then
      v_recusados := v_recusados || jsonb_build_object(
        'nivel', 'ALUNO',
        'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
        'motivo', 'O dono mudou depois da previa (previa: '||coalesce(nullif(it->>'caso_de_email',''),'ninguem')||
                  ', agora: '||coalesce(v_caso_agora,'ninguem')||').');
      continue;
    end if;

    -- ---------------- PASSO 1: revalida TODOS os acordos, SEM ESCREVER ----
    -- So entram os que a previa marcou `mover`. De cada um se confere o
    -- responsavel E o status: um acordo que virou QUITADO ou CANCELADO depois da
    -- previa nao e mais o mesmo objeto.
    --
    -- POR QUE ESTE PASSO EXISTE SEPARADO (achado na revisao de 25/09)
    -- A versao anterior validava e escrevia no mesmo laco: um acordo divergente
    -- era recusado, mas caso, ficha e agenda do aluno seguiam sendo movidos. O
    -- resultado era pior do que nao mover nada -- titularidade divergente
    -- criada pelo proprio remanejamento: o aluno na Carteira Geral e um acordo
    -- dele com outra pessoa, sem ninguem ter decidido isso.
    --
    -- Agora a regra e tudo-ou-nada POR ALUNO: se qualquer acordo selecionado
    -- falhar, o ALUNO INTEIRO e recusado ANTES de qualquer escrita. Os demais
    -- alunos do lote seguem normalmente -- o lote nao cai por causa de um.
    v_ac_falha := null;

    for ac in select * from jsonb_array_elements(it->'acordos') loop
      if not coalesce((ac->>'mover')::boolean, false) then
        continue;
      end if;

      select lower(coalesce(a.operador_responsavel_email,'')), upper(coalesce(a.status,''))
        into v_ac_email, v_ac_status
        from public.acordos a where a.id = (ac->>'acordo_id')::uuid;

      if not found then
        v_ac_falha := 'o acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' nao existe mais';
      elsif v_ac_email is distinct from coalesce(ac->>'de_email','') then
        v_ac_falha := 'o responsavel do acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' mudou depois da previa (previa: '||
                      coalesce(nullif(ac->>'de_email',''),'ninguem')||', agora: '||
                      coalesce(nullif(v_ac_email,''),'ninguem')||')';
      elsif v_ac_status is distinct from coalesce(ac->>'status','') then
        v_ac_falha := 'o status do acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' mudou depois da previa ('||coalesce(ac->>'status','-')||
                      ' -> '||coalesce(v_ac_status,'-')||')';
      end if;

      exit when v_ac_falha is not null;
    end loop;

    if v_ac_falha is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'nivel', 'ALUNO',
        'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
        'motivo', 'NADA deste aluno foi movido -- caso, ficha, acordos e agenda '||
                  'ficaram como estavam: '||v_ac_falha||'.');
      v_rec_por_acordo := v_rec_por_acordo + 1;
      continue;
    end if;

    -- ---------------- PASSO 2: dai sim, escreve ---------------------------
    v_ac_n := 0;
    v_ac_detalhe := '[]'::jsonb;

    for ac in select * from jsonb_array_elements(it->'acordos') loop
      if not coalesce((ac->>'mover')::boolean, false) then
        continue;
      end if;

      perform internal.set_resp_acordo(
        (ac->>'acordo_id')::uuid, v_destino_email, v_destino_nome,
        'CARTEIRA_GERAL_REMANEJAMENTO',
        'Acordo segue o aluno no remanejamento -> '||coalesce(v_destino_nome,'fila livre')||
        '. Motivo: '||v_motivo||'. Lote: '||v_lote::text||'. (autoria do acordo NAO muda)',
        v_autor, coalesce(v_autor_nome, v_autor));

      v_ac_n := v_ac_n + 1;
      v_ac_detalhe := v_ac_detalhe || jsonb_build_object(
        'acordo_id', ac->>'acordo_id',
        'numero', ac->>'numero',
        'de_email', ac->>'de_email',
        'status_no_lote', ac->>'status',
        'de_terceiro', coalesce((ac->>'de_terceiro')::boolean, false),
        'para_email', v_destino_email);
    end loop;

    v_acordos_mov := v_acordos_mov + v_ac_n;

    -- ---------------- troca de dono, com o retorno preservado ----------------
    perform internal.carteira_geral_trocar_dono(
      (it->>'aluno_id')::uuid, v_destino_email, v_destino_nome,
      'CARTEIRA_GERAL_REMANEJAMENTO',
      'Remanejamento em lote -> '||coalesce(v_destino_nome,'fila livre')||'. Motivo: '||v_motivo||
      '. Lote: '||v_lote::text||'. Agendamento de retorno preservado.',
      v_autor, coalesce(v_autor_nome, v_autor));

    update public.casos
       set operador_email = lower(v_destino_email),
           operador_nome  = v_destino_nome,
           operador       = upper(coalesce(v_destino_nome,'')),
           caso_atualizado_por = v_autor,
           caso_atualizado_em  = now()
     where aluno_id = (it->>'aluno_id')::uuid;

    if nullif(it->>'retorno_data','') is not null then
      v_retornos := v_retornos + 1;
    end if;

    insert into public.carteira_geral_auditoria
      (previa_id, lote_id, autor_email, autor_nome, motivo, destino_tipo,
       aluno_id, caso_id, nome_aluno, cpf,
       caso_de_email, caso_para_email, aluno_de_email, aluno_para_email,
       acordos_movidos, acordos_detalhe, valor_mensalidade, valor_acordo)
    values
      (p_previa_id, v_lote, v_autor, v_autor_nome, v_motivo, v_previa.destino_tipo,
       (it->>'aluno_id')::uuid, nullif(it->>'caso_id','')::uuid, it->>'nome', it->>'cpf',
       nullif(it->>'caso_de_email',''), v_destino_email,
       nullif(it->>'aluno_de_email',''), v_destino_email,
       v_ac_n, v_ac_detalhe,
       coalesce((it->>'saldo_mensalidade')::numeric,0),
       coalesce((it->>'saldo_acordo')::numeric,0));

    v_movidos := v_movidos + 1;
  end loop;

  update public.carteira_geral_previas
     set executada_em = now(), executada_por_email = v_autor
   where id = p_previa_id;

  return jsonb_build_object(
    'ok', true,
    'lote_id', v_lote,
    'previa_id', p_previa_id,
    'destino_tipo', v_previa.destino_tipo,
    'destino_email', v_destino_email,
    'destino_nome', coalesce(v_destino_nome, 'Fila livre'),
    'alunos_movidos', v_movidos,
    'acordos_movidos', v_acordos_mov,
    'alunos_recusados_por_acordo', v_rec_por_acordo,
    'retornos_preservados', v_retornos,
    'recusados', v_recusados,
    'total_recusados', jsonb_array_length(v_recusados));
end;
$fn$;

-- A assinatura antiga decidia acordo na hora da execucao (p_mover_acordos).
-- Agora quem decide e a previa, acordo por acordo. Deixar a antiga viva
-- permitiria mover acordo de terceiro sem ninguem ter olhado.
drop function if exists public.carteira_geral_mover(uuid, text, boolean);

revoke all on function public.carteira_geral_mover(uuid, text) from public, anon;
grant execute on function public.carteira_geral_mover(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- DESFAZER — devolve um lote a titularidade anterior, SEM ATROPELAR O QUE VEIO
-- DEPOIS.
--
-- Este projeto NAO tem PITR. Todo rollback tem de ser reconstruido a partir do
-- que foi gravado, por id exato. E, entre o lote e o desfazer, a operacao
-- continuou trabalhando: alguem pode ter assumido o caso da fila livre, a
-- gestao pode ter movido de novo, um acordo pode ter sido quitado. Desfazer
-- cegamente jogaria esse trabalho fora.
--
-- Por isso cada item so volta se TUDO ainda estiver como o lote deixou:
--   . casos.operador_email  == o destino gravado
--   . alunos.responsavel_atual_email == o destino gravado
--   . cada acordo movido: responsavel == destino E status == o do lote
-- Qualquer divergencia RECUSA o aluno inteiro (nao desfaz pela metade) e volta
-- no resultado com o motivo. A linha de auditoria fica intacta, sem marca de
-- desfeito — o lote continua parcialmente vivo, e isso e visivel.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_desfazer_lote(
  p_lote_id uuid,
  p_motivo text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
set statement_timeout to '300s'
as $fn$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_autor_nome text;
  v_motivo text := coalesce(nullif(btrim(coalesce(p_motivo,'')),''), 'Desfazer remanejamento');
  r record; ac jsonb;
  v_nome_de text;
  v_caso_agora text; v_aluno_agora text;
  v_ac_email text; v_ac_status text;
  v_bloqueio text;
  v_n int := 0; v_ac int := 0;
  v_recusados jsonb := '[]'::jsonb;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para desfazer remanejamento.' using errcode = '42501';
  end if;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_autor limit 1;

  for r in select * from public.carteira_geral_auditoria
            where lote_id = p_lote_id and desfeito_em is null
            order by registrado_em
  loop
    v_bloqueio := null;

    select lower(nullif(btrim(coalesce(c.operador_email,'')),'')),
           lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),''))
      into v_caso_agora, v_aluno_agora
      from public.casos c
      join public.alunos al on al.id = c.aluno_id
     where c.aluno_id = r.aluno_id
     limit 1;

    if v_caso_agora is distinct from lower(nullif(r.caso_para_email,'')) then
      v_bloqueio := 'O caso saiu de '||coalesce(nullif(r.caso_para_email,''),'fila livre')||
                    ' depois do lote (agora: '||coalesce(v_caso_agora,'fila livre')||
                    '). Foi assumido ou movido de novo — desfazer apagaria esse trabalho.';
    elsif v_aluno_agora is distinct from lower(nullif(r.aluno_para_email,'')) then
      v_bloqueio := 'A ficha do aluno saiu de '||coalesce(nullif(r.aluno_para_email,''),'fila livre')||
                    ' depois do lote (agora: '||coalesce(v_aluno_agora,'fila livre')||').';
    else
      for ac in select * from jsonb_array_elements(r.acordos_detalhe) loop
        select lower(coalesce(a.operador_responsavel_email,'')), upper(coalesce(a.status,''))
          into v_ac_email, v_ac_status
          from public.acordos a where a.id = (ac->>'acordo_id')::uuid;

        if v_ac_email is null then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||' nao existe mais.';
          exit;
        end if;
        if v_ac_email is distinct from lower(coalesce(ac->>'para_email','')) then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||
                        ' mudou de responsavel depois do lote (agora: '||
                        coalesce(nullif(v_ac_email,''),'ninguem')||').';
          exit;
        end if;
        if v_ac_status is distinct from upper(coalesce(ac->>'status_no_lote','')) then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||
                        ' mudou de status depois do lote ('||coalesce(ac->>'status_no_lote','-')||
                        ' -> '||coalesce(v_ac_status,'-')||').';
          exit;
        end if;
      end loop;
    end if;

    if v_bloqueio is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'aluno_id', r.aluno_id, 'nome', r.nome_aluno, 'motivo', v_bloqueio);
      continue;
    end if;

    select coalesce(u.nome, r.aluno_de_email) into v_nome_de
      from public.usuarios u where lower(u.email) = lower(r.aluno_de_email);

    -- Devolve os acordos primeiro: se algo falhar, a transacao inteira volta.
    for ac in select * from jsonb_array_elements(r.acordos_detalhe) loop
      perform internal.set_resp_acordo(
        (ac->>'acordo_id')::uuid, nullif(ac->>'de_email',''),
        (select coalesce(u.nome, ac->>'de_email') from public.usuarios u
          where lower(u.email) = lower(ac->>'de_email')),
        'CARTEIRA_GERAL_DESFAZER',
        'Desfeito o lote '||p_lote_id::text||'. Motivo: '||v_motivo||'.',
        v_autor, coalesce(v_autor_nome, v_autor));
      v_ac := v_ac + 1;
    end loop;

    -- Mesma troca de dono da ida: o agendamento tambem e preservado na volta.
    perform internal.carteira_geral_trocar_dono(
      r.aluno_id, r.aluno_de_email, v_nome_de,
      'CARTEIRA_GERAL_DESFAZER',
      'Desfeito o lote '||p_lote_id::text||'. Motivo: '||v_motivo||'. Agendamento preservado.',
      v_autor, coalesce(v_autor_nome, v_autor));

    update public.casos
       set operador_email = lower(r.caso_de_email),
           operador_nome  = v_nome_de,
           operador       = upper(coalesce(v_nome_de,'')),
           caso_atualizado_por = v_autor,
           caso_atualizado_em  = now()
     where aluno_id = r.aluno_id;

    update public.carteira_geral_auditoria
       set desfeito_em = now(), desfeito_por_email = v_autor
     where id = r.id;

    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'lote_id', p_lote_id,
                            'alunos_devolvidos', v_n, 'acordos_devolvidos', v_ac,
                            'recusados', v_recusados,
                            'total_recusados', jsonb_array_length(v_recusados));
end;
$fn$;

revoke all on function public.carteira_geral_desfazer_lote(uuid, text) from public, anon;
grant execute on function public.carteira_geral_desfazer_lote(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Interruptor de entrada de caso novo por operador.
-- Fecha as duas portas de uma vez: distribuicao automatica e auto-atribuicao da
-- fila livre. Recolher a carteira de alguem sem desligar isto e inutil.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_definir_recebimento(
  p_operador_email text,
  p_recebe boolean,
  p_motivo text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_autor text := lower(coalesce(auth.jwt()->>'email','')); v_nome text;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao.' using errcode = '42501';
  end if;

  update public.usuarios
     set recebe_novos_casos = coalesce(p_recebe, true)
   where lower(email) = lower(btrim(coalesce(p_operador_email,'')))
     and perfil = 'operador'
  returning nome into v_nome;

  if v_nome is null then
    raise exception 'Operador nao encontrado: %', p_operador_email;
  end if;

  -- `aluno_movimentacoes` exige aluno_id (NOT NULL) e isto nao e sobre um
  -- aluno: e sobre um operador. Vai na auditoria generica.
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values (v_autor, 'CARTEIRA_GERAL_RECEBIMENTO', 'usuarios',
          jsonb_build_object(
            'operador', v_nome,
            'operador_email', lower(btrim(p_operador_email)),
            'recebe_novos_casos', coalesce(p_recebe, true),
            'motivo', coalesce(nullif(btrim(coalesce(p_motivo,'')),''),'nao informado')));

  return jsonb_build_object('ok', true, 'operador', v_nome, 'recebe', coalesce(p_recebe, true));
end;
$fn$;

drop function if exists public.carteira_geral_definir_distribuicao(text, boolean, text);

revoke all on function public.carteira_geral_definir_recebimento(text, boolean, text) from public, anon;
grant execute on function public.carteira_geral_definir_recebimento(text, boolean, text) to authenticated;
