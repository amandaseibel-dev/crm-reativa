-- ---------------------------------------------------------------------------
-- CARTEIRA GERAL — execucao do remanejamento e desfazer
--
-- SO SE MOVE O QUE ESTA NA PREVIA. A funcao nao refaz a consulta: ela le a
-- lista congelada em carteira_geral_previas.itens. Se o dono de um aluno mudou
-- entre a previa e o clique, o item e RECUSADO e volta no resultado — nunca
-- reinterpretado.
--
-- O QUE MUDA: a custodia (quem trabalha o caso hoje).
--   . casos.operador_email / operador_nome / operador
--   . alunos.responsavel_atual_email / _nome
--   . acordos.operador_responsavel_email  (opcional, p_mover_acordos)
--
-- O QUE NAO MUDA, NUNCA:
--   . acordos.criado_por_email / criado_por_nome / confirmado_por_email
--   . pagamentos.operador_email  (e o que define honorario e comissao)
--   . baixas_pagamento, parcelas, titulos, valores, status financeiro
--   . historico_operadores_alunos e aluno_movimentacoes ja gravados
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

create or replace function public.carteira_geral_mover(
  p_previa_id uuid,
  p_motivo text,
  p_mover_acordos boolean default true
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
  v_movidos     int := 0;
  v_recusados   jsonb := '[]'::jsonb;
  v_acordos_mov int := 0;
  v_ac_detalhe  jsonb;
  v_ac_n        int;
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
    -- O mundo mudou desde a previa? Entao este item nao entra.
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
        'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
        'motivo', 'O dono mudou depois da previa (previa: '||coalesce(nullif(it->>'caso_de_email',''),'ninguem')||
                  ', agora: '||coalesce(v_caso_agora,'ninguem')||').');
      continue;
    end if;

    -- 1. ficha do aluno (caminho oficial, com movimentacao registrada)
    perform internal.set_resp_aluno(
      (it->>'aluno_id')::uuid, v_destino_email, v_destino_nome,
      'CARTEIRA_GERAL_REMANEJAMENTO',
      'Remanejamento em lote -> '||coalesce(v_destino_nome,'fila livre')||'. Motivo: '||v_motivo||'. Lote: '||v_lote::text||'.',
      v_autor, coalesce(v_autor_nome, v_autor));

    -- 2. caso. O gatilho _sync_casos_resp_aluno ja espelha o e-mail, mas o
    -- update explicito garante nome/operador e a marca de quem mexeu — mesmo
    -- padrao de alterar_responsavel_aluno.
    update public.casos
       set operador_email = lower(v_destino_email),
           operador_nome  = v_destino_nome,
           operador       = upper(coalesce(v_destino_nome,'')),
           caso_atualizado_por = v_autor,
           caso_atualizado_em  = now()
     where aluno_id = (it->>'aluno_id')::uuid;

    -- 3. acordos (opcional). Sem isto, um acordo que continua com o dono
    -- antigo devolve o aluno para ele: o gatilho _aluno_segue_dono_do_acordo
    -- realinha a ficha ao dono do acordo ATIVO quando nao ha mensalidade em
    -- aberto. Recolher sem levar o acordo nao se sustenta.
    v_ac_n := 0;
    v_ac_detalhe := '[]'::jsonb;
    if p_mover_acordos then
      for ac in select * from jsonb_array_elements(it->'acordos') loop
        perform internal.set_resp_acordo(
          (ac->>'acordo_id')::uuid, v_destino_email, v_destino_nome,
          'CARTEIRA_GERAL_REMANEJAMENTO',
          'Acordo segue o aluno no remanejamento -> '||coalesce(v_destino_nome,'fila livre')||
          '. Motivo: '||v_motivo||'. Lote: '||v_lote::text||'. (autoria do acordo NAO muda)',
          v_autor, coalesce(v_autor_nome, v_autor));
        v_ac_n := v_ac_n + 1;
        v_ac_detalhe := v_ac_detalhe || jsonb_build_object(
          'acordo_id', ac->>'acordo_id', 'de_email', ac->>'de_email', 'para_email', v_destino_email);
      end loop;
      v_acordos_mov := v_acordos_mov + v_ac_n;
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
    'recusados', v_recusados,
    'total_recusados', jsonb_array_length(v_recusados));
end;
$fn$;

revoke all on function public.carteira_geral_mover(uuid, text, boolean) from public, anon;
grant execute on function public.carteira_geral_mover(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- DESFAZER — devolve um lote inteiro a titularidade anterior.
--
-- Este projeto NAO tem PITR. Todo rollback tem de ser reconstruido a partir do
-- que foi gravado, por id exato, sem tocar no que entrou depois. E o que esta
-- funcao faz: le a auditoria do lote e devolve cada aluno/acordo exatamente ao
-- e-mail registrado como anterior. Linha ja desfeita e ignorada.
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
  v_n int := 0; v_ac int := 0;
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
    select coalesce(u.nome, r.aluno_de_email) into v_nome_de
      from public.usuarios u where lower(u.email) = lower(r.aluno_de_email);

    perform internal.set_resp_aluno(
      r.aluno_id, r.aluno_de_email, v_nome_de,
      'CARTEIRA_GERAL_DESFAZER',
      'Desfeito o lote '||p_lote_id::text||'. Motivo: '||v_motivo||'.',
      v_autor, coalesce(v_autor_nome, v_autor));

    update public.casos
       set operador_email = lower(r.caso_de_email),
           operador_nome  = v_nome_de,
           operador       = upper(coalesce(v_nome_de,'')),
           caso_atualizado_por = v_autor,
           caso_atualizado_em  = now()
     where aluno_id = r.aluno_id;

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

    update public.carteira_geral_auditoria
       set desfeito_em = now(), desfeito_por_email = v_autor
     where id = r.id;

    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'lote_id', p_lote_id,
                            'alunos_devolvidos', v_n, 'acordos_devolvidos', v_ac);
end;
$fn$;

revoke all on function public.carteira_geral_desfazer_lote(uuid, text) from public, anon;
grant execute on function public.carteira_geral_desfazer_lote(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Interruptor de distribuicao automatica por operador.
-- Recolher a carteira de alguem sem desligar isto e inutil: a rotina das 09:20
-- devolve casos novos para a mesma pessoa na manha seguinte.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_definir_distribuicao(
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
     set recebe_distribuicao_automatica = coalesce(p_recebe, true)
   where lower(email) = lower(btrim(coalesce(p_operador_email,'')))
     and perfil = 'operador'
  returning nome into v_nome;

  if v_nome is null then
    raise exception 'Operador nao encontrado: %', p_operador_email;
  end if;

  -- `aluno_movimentacoes` exige aluno_id (NOT NULL) e isto nao e sobre um
  -- aluno: e sobre um operador. Vai na auditoria generica.
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values (v_autor, 'CARTEIRA_GERAL_DISTRIBUICAO', 'usuarios',
          jsonb_build_object(
            'operador', v_nome,
            'operador_email', lower(btrim(p_operador_email)),
            'recebe_distribuicao_automatica', coalesce(p_recebe, true),
            'motivo', coalesce(nullif(btrim(coalesce(p_motivo,'')),''),'nao informado')));

  return jsonb_build_object('ok', true, 'operador', v_nome, 'recebe', coalesce(p_recebe, true));
end;
$fn$;

revoke all on function public.carteira_geral_definir_distribuicao(text, boolean, text) from public, anon;
grant execute on function public.carteira_geral_definir_distribuicao(text, boolean, text) to authenticated;
