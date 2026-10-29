-- Rollback de 20260927120000: volta o executor a percorrer ITEM e a auditoria a
-- uma linha por item, e o desfazer a conferir UM caso por aluno (LIMIT 1).
--
-- ATENCAO, o que reverter reintroduz:
--   1. o executor recusa a si mesmo na segunda ficha do mesmo aluno -- foi o que
--      deixou o lote 559b20bb com 6 linhas para 8 casos e 2 recusas falsas;
--   2. o desfazer volta a olhar UM caso escolhido por LIMIT 1: com duas fichas
--      em que so uma mudou, a decisao de bloquear passa a depender de qual linha
--      o banco devolver;
--   3. `casos_movidos` e `casos_devolvidos` deixam de existir no retorno;
--   4. retornos_preservados volta a contar por ficha (em dobro no aluno gemeo).
--
-- As linhas de auditoria ja gravadas POR CASO continuam existindo e o desfazer
-- antigo as percorreria UMA POR UMA, devolvendo o mesmo aluno mais de uma vez.
-- Antes de reverter, confira se algum lote foi executado pela versao nova:
--   select lote_id, count(*), count(distinct aluno_id)
--     from public.carteira_geral_auditoria group by 1 having count(*) > count(distinct aluno_id);
--
-- Nenhum dado e movido aqui.

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
