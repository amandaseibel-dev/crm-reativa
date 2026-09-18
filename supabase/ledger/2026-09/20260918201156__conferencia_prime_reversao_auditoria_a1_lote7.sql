-- CONFERENCIA PRIME -- reversao da auditoria dos A1 confirmados (AUDITORIA_GRUPO_A_EVIDENCIA_INSUFICIENTE), lote 7 de 8 (classe D).
-- Decisao da gestao (18/09/2026): os titulos das classes C e D saem de PAGO e voltam para EM_CONFIRMACAO / PENDENTE.
-- Nao voltam para ABERTO nem para cobranca. A confirmacao anterior fica registrada (evidencia, auditoria, movimentacao).
-- Aluno que ficou QUITADO so por estes titulos: volta para AGUARDANDO_CONFIRMACAO pela fotografia oficial de antes da
-- quitacao (alunos_estado_anterior), o caso fechado hoje e reaberto pelo padrao de casos_reabrir_com_divida, o operador
-- volta pelo caso (o responsavel segue pela sincronizacao oficial) e a reposicao gerada e neutralizada como o proprio
-- processador faz (processado_em, repostos 0, erro). A trava titulo_liquidado_na_origem_e_terminal e desligada SO dentro
-- desta transacao, para estes titulos, e religada antes do fim. Nada de pagamento, acordo, parcela ou vinculo.
set local statement_timeout = '300s';
do $rev$
declare
  c_rotulo  constant text   := 'lote 7 de 8 (classe D)';
  c_modo    constant text   := 'EXECUCAO';
  c_alunos  constant uuid[] := array['9147bf43-7669-418a-ac3f-6b40af2d8010','9207da44-0521-428e-a767-3fde08e6caf8','94c2435c-249f-4a5f-82fc-851eb6c90303','94e3813f-70e2-4073-bc6c-dfdcc3f422c7','99ffcfca-8fc5-4dd3-a6e5-21f68ba57bd9','9a28644b-1528-4bd5-ac50-11e872323b1d','9a6998b1-051a-4bf4-be69-89d63f90da06','9d0b0dbd-6226-44c3-bf9b-5a18f9748b9a','9d28ed4f-bb66-432e-b2e3-0d78cf1c627f','a6075e17-cf0c-4fbc-b1a6-863c2c549aac','a68ffdf2-313e-41bf-90ed-9c4b89699e0f','a890587b-caa0-4070-a8d7-9b5828fb31d8','a93c98c7-3e3b-4623-8265-5d4a1fc43ae6','a9e6bdc5-5bbb-4e9d-92ca-2431f02fd67e','aca6d66b-5603-4e4b-9034-7c33039b0908','adc35aa5-d0d9-4d1d-8251-3fec1933ec05','ae2aa40f-13e3-4284-b2a7-aba02bce2a96','b2f6c999-980b-4356-bb51-769262a73b3f','b31e880b-e366-4312-8a59-917b2ca1df98','b609c6d8-e416-4136-a5cd-ebafe1cf05fa','bb6010e9-55b6-4920-b45e-3b0d251d25b9','bb607fa7-2230-46e8-9f6e-4e9162e56be1','bff11ff3-32d7-4967-b3d2-e2dc7e4596f0','c14b9426-5f2d-4203-9be5-69f229f35985','c2f5d0f1-57be-4cd0-a47a-862c034b1991','c41c44d6-5a4a-4d47-a849-426010d80cf4','c506376f-c6ed-42dc-ad0a-16b635bbaf5d','c51992d9-85b7-427f-a474-889e6a2a6429','c6af5d55-fe03-453e-8e37-a73cddb76b0b','c736d447-74a9-4524-b679-00c2c3298c23','caad5e96-cfba-4b6c-b63f-d5fdf082cd45','cd776d2a-dc18-4870-8179-723d56217ea5','ce32a76b-1cac-409c-8dc5-869956aafdd8','d2b2ba32-c05c-48da-b8d4-96ce87d39446']::uuid[];
  c_motivo  constant text   := 'AUDITORIA_GRUPO_A_EVIDENCIA_INSUFICIENTE';
  c_explica constant text   := 'a confirmacao anterior usou o valor_pago da Prime como evidencia de caixa; a auditoria de 18/09/2026 '
                               || 'comprovou que esse campo tambem representa divida corrigida/renegociacao; por isso a decisao foi reaberta '
                               || 'para conferencia financeira';
  c_classe_a constant uuid[] := array['04c857e4-352c-4159-8257-094f41211733','094cbdf1-772f-42eb-9f84-26ac9a51dd7f','0d0fa847-0f7e-4df0-a9de-8aed1c30132e','20b11e1a-bf03-4e51-a4c0-f4018991d791','3a4243ab-690f-44bf-a78d-176b99145f25','4e272224-653f-4c2f-b9dd-591f01399256','4f56715a-6c7e-4de5-86c7-075d323f55bc','56908563-c6a0-44bd-b89a-fa527c920c6c','7338eb57-00f3-4bb9-8eba-38764ae1636c','8690b452-4ce7-4ef8-a35b-8413f3aad80d','9ce2225f-77a7-484a-8c66-dfbfd12cc9cf','a20ce0ff-8789-4c43-99c3-101fe0760584','b3b493a8-4553-45c2-b896-5d0a131cae05','b7043662-d024-4331-b5ff-abe8b685f6d5','b85f7b35-81cc-4b7a-95d5-94fa9cca62c3','ba573607-8ebb-4370-9ad1-a9fe1865ea82','cb0ea97a-dc05-450b-b8e5-be1c06c61cb8','d6b05f07-ecbf-4d29-ace0-25cd74cbfaf6','e19e45dc-5afb-4157-8016-70714f8b0759']::uuid[];
  c_quit    constant text[] := array['QUITADO','PAGO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO'];
  v_md5 text; al record; v_n int; v_t0 timestamptz := clock_timestamp();
  v_snap jsonb; v_caso uuid; v_rep record; v_reps bigint[]; v_sit_antes text; v_saldo_antes numeric; v_saldo_depois numeric;
  v_resp_antes text; v_resp_depois text; v_op text;
  v_a0 bigint; v_p0 bigint; v_pp0 bigint; v_g0 bigint; v_b0 bigint; v_v0 bigint; v_rep0 bigint; v_hist0 bigint; v_barr0 bigint;
  v_emconf0 bigint; v_rel jsonb := '[]'::jsonb; v_det jsonb;
begin
  -- 0. funcoes oficiais intactas, reposicao pausada, decisao registrada
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any(array['_talvez_quitar_aluno','_titulo_em_confirmacao_protegido','_titulo_situacao_e_status_coerentes','_trg_auto_quitar_titulo','aluno_saldo_pendente_detalhe','assumir_caso_livre','caso_aguarda_confirmacao_financeira','caso_protegido_redistribuicao','casos_encerrar_zerados_sem_debito','casos_reavaliar_encerramento','contar_carteira_ativa','nivelar_medias_progressivo','prime_conferencia_baixar','prime_conferencia_confirmar','prime_conferencia_detectar_grupo_a','prime_conferencia_fila','prime_conferencia_rejeitar','prime_conferencia_rejeitar_lote','prime_conferencia_vincular','prime_grupo_a_candidatos','recalcular_situacao_aluno','reforcar_teto_operadores','titulo_liquidado_na_origem_e_terminal']);
  if v_md5 is distinct from 'd9e15cb291b2aa3c05f3a0f0f335f732' then
    raise exception 'REV_PRE: funcoes do grupo A mudaram (%)', v_md5;
  end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then
    raise exception 'REV_PRE: reposicao de carteira nao esta pausada';
  end if;
  if c_modo = 'EXECUCAO' and not exists (select 1 from public.auditoria where acao = 'CONFERENCIA_PRIME_AUDITORIA_A1_REVERSAO_AUTORIZADA') then
    raise exception 'REV_PRE: decisao da gestao nao registrada';
  end if;
  if c_alunos && c_classe_a then
    raise exception 'REV_PRE: aluno da classe A no lote';
  end if;

  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","sub":"52b292e4-e43e-4200-a684-b63d889d273a","role":"authenticated"}', true);

  -- 1. universo do lote: todos os titulos CONFIRMADOS destes alunos, e so eles
  create temp table _u on commit drop as
    select d.titulo_id, d.aluno_id, d.documento, d.valor, d.decidido_por, d.decidido_em, d.motivo as motivo_ant, d.subgrupo,
           t.origem_liquidacao, t.origem_liquidacao_ref, t.origem_liquidacao_em, t.situacao, t.status, t.acordo_id, t.tipo_boleto, t.vencimento,
           t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado,
           (d.evidencia ->> 'liquidado_em')::date as liq
      from public.prime_conferencia_decisao d join public.acordos_titulos t on t.id = d.titulo_id
     where d.aluno_id = any(c_alunos) and d.decisao = 'CONFIRMADO';
  select count(*) into v_n from _u;
  if v_n = 0 or v_n > 50 then raise exception 'REV_PRE: lote com % titulos', v_n; end if;
  if (select count(distinct aluno_id) from _u) <> cardinality(c_alunos) then
    raise exception 'REV_PRE: aluno do lote sem titulo confirmado';
  end if;
  if exists (select 1 from _u where situacao <> 'PAGO' or status <> 'quitada' or origem_liquidacao is distinct from 'PRIME_LIQUIDACAO_OFICIAL'
                                  or acordo_id is not null or subgrupo <> 'A1'
                                  or exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = _u.titulo_id and coalesce(v.ativo, true))) then
    raise exception 'REV_PRE: titulo fora do estado confirmado pela Conferencia';
  end if;

  -- classe de cada aluno, pela mesma regra da auditoria (pagamento ReATIVA na janela / portador 166 / nada)
  create temp table _cls on commit drop as
    with k as (
      select u.aluno_id, min(u.liq) liq_min, max(u.liq) liq_max, sum(u.valor) vcrm,
             lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0') cpf
        from _u u join public.alunos a on a.id = u.aluno_id group by u.aluno_id, a.cpf)
    select k.aluno_id,
           case when coalesce((select sum(p.valor_pago - coalesce(p.valor_honorario,0)) from public.pagamentos p
                                where (p.aluno_id = k.aluno_id or lpad(regexp_replace(coalesce(p.cpf,''),'\D','','g'),11,'0') = k.cpf)
                                  and p.data_pagamento between k.liq_min - 10 and k.liq_max + 10 and coalesce(p.retroativo,false) = false), 0) > 0
                  then 'C_parcial'
                when exists (select 1 from public.prime_portador_membro m where lpad(m.cpf,11,'0') = k.cpf and m.portador = 166) then 'C_166'
                else 'D' end as classe
      from k;

  -- 2. fotografia de antes (contadores globais)
  select count(*) into v_a0 from public.acordos;
  select count(*) into v_p0 from public.parcelas;
  select count(*) filter (where status = 'PAGO') into v_pp0 from public.parcelas;
  select count(*) into v_g0 from public.pagamentos;
  select count(*) into v_b0 from public.baixas_pagamento;
  select count(*) into v_v0 from public.acordo_titulo_vinculo where coalesce(ativo, true);
  select coalesce(max(id), 0) into v_rep0 from public.reposicao_carteira_fila;
  select count(*) into v_hist0 from public.historico_operadores_alunos where criado_em >= now() - interval '1 hour';
  select count(*) into v_barr0 from public.ficha_reabertura_barrada;
  select count(*) into v_emconf0 from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';

  -- 3. a trava terminal sai so aqui dentro
  execute 'alter table public.acordos_titulos disable trigger trg_titulo_liquidado_na_origem_e_terminal';

  for al in
    select u.aluno_id, c.classe, min(u.decidido_em) c0, max(u.decidido_em) c1, count(*) n, sum(u.valor) valor,
           a.situacao_operacional sit, lower(a.responsavel_atual_email) resp
      from _u u join _cls c using (aluno_id) join public.alunos a on a.id = u.aluno_id
     group by u.aluno_id, c.classe, a.situacao_operacional, a.responsavel_atual_email
     order by u.aluno_id
  loop
    v_sit_antes := al.sit;
    v_saldo_antes := coalesce((public.aluno_saldo_pendente_detalhe(al.aluno_id) ->> 'total')::numeric, 0);
    v_caso := null; v_reps := '{}'; v_snap := null; v_op := null;

    -- 3a. titulos: PAGO -> EM_CONFIRMACAO, sem as marcas de liquidacao oficial (ficam na evidencia e na auditoria)
    perform set_config('conferencia_prime.decisao', 'on', true);
    update public.acordos_titulos t
       set situacao = 'EM_CONFIRMACAO', status = 'em_confirmacao',
           origem_liquidacao = null, origem_liquidacao_ref = null, origem_liquidacao_em = null,
           motivo_ajuste = coalesce(t.motivo_ajuste,'') || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'reaberto para EM_CONFIRMACAO pela ' || c_motivo || ' em 18/09/2026 (confirmacao anterior '
             || coalesce(u.origem_liquidacao_ref,'?') || ' em ' || coalesce(to_char(u.origem_liquidacao_em, 'DD/MM/YYYY HH24:MI'),'?') || ')',
           atualizado_em = now()
      from _u u
     where u.titulo_id = t.id and u.aluno_id = al.aluno_id;
    perform set_config('conferencia_prime.decisao', 'off', true);

    -- 3b. decisao volta a PENDENTE, com a confirmacao anterior preservada na evidencia
    update public.prime_conferencia_decisao d
       set decisao = 'PENDENTE', motivo = c_motivo || ': ' || c_explica,
           decidido_por = null, decidido_em = null, revisao_obrigatoria = true,
           evidencia = coalesce(d.evidencia, '{}'::jsonb) || jsonb_build_object('reaberta_por_auditoria', jsonb_build_object(
             'em', now(), 'motivo', c_motivo, 'explicacao', c_explica, 'classe', al.classe,
             'lote_48_altos', (coalesce(u.tipo_boleto,'') = 'Cursos de Graduação Presencial' and u.valor >= 5000
                               and u.vencimento = '2026-07-05' and u.liq between '2026-08-12' and '2026-08-14'),
             'confirmacao_anterior', jsonb_build_object('decisao', 'CONFIRMADO', 'decidido_por', u.decidido_por, 'decidido_em', u.decidido_em,
                                                        'motivo', u.motivo_ant, 'origem_liquidacao', u.origem_liquidacao,
                                                        'origem_liquidacao_ref', u.origem_liquidacao_ref, 'origem_liquidacao_em', u.origem_liquidacao_em)))
      from _u u
     where u.titulo_id = d.titulo_id and u.aluno_id = al.aluno_id;

    insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_email, registrado_em, valor_movimentacao)
    select al.aluno_id::text, 'REABERTURA_CONFERENCIA_PRIME_AUDITORIA',
           'Titulo ' || btrim(coalesce(u.documento,'')) || ' volta para confirmacao (' || c_motivo || '): ' || c_explica || '.',
           'PAGO', 'EM_CONFIRMACAO', 'amanda.seibel@aelbra.com.br', now(), u.valor
      from _u u where u.aluno_id = al.aluno_id;

    -- 3c. aluno que ficou QUITADO so por estes titulos
    if al.sit = 'QUITADO' then
      select e.estado into v_snap from public.alunos_estado_anterior e
       where e.aluno_id = al.aluno_id and e.criado_em between al.c0 - interval '2 min' and al.c1 + interval '2 min'
       order by e.criado_em, e.id limit 1;
      if v_snap is null then raise exception 'REV: aluno % sem fotografia de antes da quitacao', al.aluno_id; end if;

      select c.id into v_caso from public.casos c
       where c.aluno_id = al.aluno_id and c.caso_atualizado_em >= '2026-09-18 18:00'
       order by exists (select 1 from public.reposicao_carteira_fila r where r.caso_origem_id = c.id and r.criado_em >= '2026-09-18 17:00') desc,
                c.created_at desc
       limit 1;
      if v_caso is null then raise exception 'REV: aluno % sem caso fechado hoje', al.aluno_id; end if;

      select array_agg(r.id) into v_reps from public.reposicao_carteira_fila r join public.casos c on c.id = r.caso_origem_id
       where c.aluno_id = al.aluno_id and r.criado_em >= '2026-09-18 17:00' and r.processado_em is null;
      v_reps := coalesce(v_reps, '{}');
      select r.* into v_rep from public.reposicao_carteira_fila r where r.id = any(v_reps)
       order by (r.caso_origem_id = v_caso) desc, r.id limit 1;
      if found then v_op := lower(v_rep.operador_email); end if;

      -- operador de volta pelo caso, enquanto o caso ainda e protegido (so confirmacao): nao ocupa vaga, teto nao age
      if v_op is not null then
        update public.casos set operador_email = lower(v_rep.operador_email), operador_nome = v_rep.operador_nome, operador = v_rep.operador_upper
         where id = v_caso;
      end if;

      -- reabertura pelo padrao oficial (casos_reabrir_com_divida) + as marcas de quitacao automatica de hoje
      update public.casos
         set status_atual = 'Em cobrança', status_acionamento = null, status_jornada = 'Em cobrança',
             status_financeiro = case when public.normalizar_status_acionamento(coalesce(status_financeiro,'')) = any(c_quit) then null else status_financeiro end,
             quitado_em      = case when origem_quitacao = 'QUITACAO_AUTOMATICA' and quitado_em = date '2026-09-18' then null else quitado_em end,
             origem_quitacao = case when origem_quitacao = 'QUITACAO_AUTOMATICA' and quitado_em = date '2026-09-18' then null else origem_quitacao end,
             encerrado_operacional = false,
             caso_atualizado_por = 'reversao_auditoria_grupo_a', caso_atualizado_em = now()
       where id = v_caso;

      -- aluno volta ao estado de antes da quitacao (fotografia oficial)
      perform public._desfazer_restaurar_aluno(al.aluno_id, v_snap);

      -- reposicao gerada pela confirmacao errada: neutralizada como o processador faz, historico preservado
      update public.reposicao_carteira_fila
         set processado_em = now(), repostos = 0, erro = 'REVERSAO_AUDITORIA_GRUPO_A'
       where id = any(v_reps) and processado_em is null;
      get diagnostics v_n = row_count;
      if v_n <> cardinality(v_reps) then raise exception 'REV: reposicao do aluno % mudou', al.aluno_id; end if;

      insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_email, registrado_em)
      values (al.aluno_id::text, 'REABERTURA_CONFERENCIA_PRIME_AUDITORIA',
              'Aluno estava QUITADO so pela confirmacao Prime reaberta (' || c_motivo || '). Volta para aguardar a conferencia financeira; '
              || 'caso reaberto' || case when v_op is not null then ' com o operador anterior' else ' na fila livre, como antes' end || '.',
              'QUITADO', 'AGUARDANDO_CONFIRMACAO', 'amanda.seibel@aelbra.com.br', now());
    end if;

    perform public.recalcular_situacao_aluno(al.aluno_id, 'reversao_auditoria_grupo_a');

    -- 3d. travas por aluno
    if exists (select 1 from _u u join public.acordos_titulos t on t.id = u.titulo_id
                where u.aluno_id = al.aluno_id
                  and (t.situacao <> 'EM_CONFIRMACAO' or t.status <> 'em_confirmacao' or t.origem_liquidacao is not null or t.acordo_id is not null))
       or exists (select 1 from _u u join public.prime_conferencia_decisao d on d.titulo_id = u.titulo_id
                   where u.aluno_id = al.aluno_id and d.decisao <> 'PENDENTE') then
      raise exception 'REV_POS: titulos do aluno % fora de EM_CONFIRMACAO/PENDENTE', al.aluno_id;
    end if;
    v_saldo_depois := coalesce((public.aluno_saldo_pendente_detalhe(al.aluno_id) ->> 'total')::numeric, 0);
    select lower(responsavel_atual_email) into v_resp_depois from public.alunos where id = al.aluno_id;
    if al.sit = 'QUITADO' then
      if (select situacao_operacional from public.alunos where id = al.aluno_id) <> 'AGUARDANDO_CONFIRMACAO' then
        raise exception 'REV_POS: aluno % nao voltou para AGUARDANDO_CONFIRMACAO (%)', al.aluno_id,
          (select situacao_operacional from public.alunos where id = al.aluno_id);
      end if;
      if v_saldo_depois > 0.005 then raise exception 'REV_POS: aluno % ganhou saldo exigivel %', al.aluno_id, v_saldo_depois; end if;
      if not public.caso_aguarda_confirmacao_financeira(al.aluno_id) then
        raise exception 'REV_POS: caso do aluno % nao ficou protegido como so-confirmacao', al.aluno_id;
      end if;
      if not exists (select 1 from public.casos c where c.aluno_id = al.aluno_id and not coalesce(c.encerrado_operacional, false)) then
        raise exception 'REV_POS: aluno % ficou sem caso aberto', al.aluno_id;
      end if;
      -- com reposicao: volta o operador que a quitacao liberou; sem reposicao: fica exatamente o que ja era
      if v_resp_depois is distinct from coalesce(v_op, al.resp) then
        raise exception 'REV_POS: responsavel do aluno % ficou % (esperado %)', al.aluno_id, v_resp_depois, coalesce(v_op, al.resp);
      end if;
    else
      if (select situacao_operacional from public.alunos where id = al.aluno_id) is distinct from v_sit_antes then
        raise exception 'REV_POS: aluno % com outra divida mudou de situacao', al.aluno_id;
      end if;
      if abs(v_saldo_depois - v_saldo_antes) > 0.005 then
        raise exception 'REV_POS: saldo exigivel do aluno % mudou (% -> %)', al.aluno_id, v_saldo_antes, v_saldo_depois;
      end if;
      if v_resp_depois is distinct from al.resp then raise exception 'REV_POS: responsavel do aluno % mudou', al.aluno_id; end if;
    end if;

    v_rel := v_rel || jsonb_build_object('aluno_id', al.aluno_id, 'classe', al.classe, 'titulos', al.n, 'valor', al.valor,
      'situacao_antes', v_sit_antes, 'situacao_depois', (select situacao_operacional from public.alunos where id = al.aluno_id),
      'saldo_exigivel_depois', v_saldo_depois, 'caso_reaberto', v_caso, 'operador_restaurado', v_op,
      'reposicoes_neutralizadas', to_jsonb(v_reps),
      'status_restaurado', case when v_snap is not null then v_snap ->> 'status_atual' end);
  end loop;

  execute 'alter table public.acordos_titulos enable trigger trg_titulo_liquidado_na_origem_e_terminal';

  -- 4. travas do lote
  if (select count(*) from public.acordos) <> v_a0 then raise exception 'REV_POS: acordo criado'; end if;
  if (select count(*) from public.parcelas) <> v_p0 then raise exception 'REV_POS: parcela criada'; end if;
  if (select count(*) filter (where status = 'PAGO') from public.parcelas) <> v_pp0 then raise exception 'REV_POS: baixa de parcela mudou'; end if;
  if (select count(*) from public.pagamentos) <> v_g0 then raise exception 'REV_POS: pagamento criado'; end if;
  if (select count(*) from public.baixas_pagamento) <> v_b0 then raise exception 'REV_POS: baixa criada'; end if;
  if (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) <> v_v0 then raise exception 'REV_POS: vinculo mudou'; end if;
  if (select coalesce(max(id), 0) from public.reposicao_carteira_fila) <> v_rep0 then raise exception 'REV_POS: reposicao nova enfileirada'; end if;
  if exists (select 1 from public.historico_operadores_alunos h where h.criado_em >= v_t0
              and h.acao in ('LIBERACAO_AUTOMATICA_TETO_EXCEDIDO','REPOSICAO_AUTOMATICA_VAGA','LIBERACAO_AUTOMATICA_CASO_FECHADO')) then
    raise exception 'REV_POS: houve liberacao ou redistribuicao de caso';
  end if;
  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') <> v_emconf0 + (select count(*) from _u) then
    raise exception 'REV_POS: EM_CONFIRMACAO nao subiu exatamente o lote';
  end if;
  if exists (select 1 from _u u join public.acordos_titulos t on t.id = u.titulo_id
              where (t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado)
                    is distinct from (u.valor_original, u.saldo_corrigido, u.valor_em_aberto, u.valor_cobranca_ajustado)) then
    raise exception 'REV_POS: valor de titulo mudou';
  end if;
  if exists (select 1 from _u u join public.acordos_titulos t on t.id = u.titulo_id where upper(coalesce(t.situacao,'')) = 'ABERTO') then
    raise exception 'REV_POS: titulo ficou ABERTO';
  end if;
  if (select tgenabled from pg_trigger where tgname = 'trg_titulo_liquidado_na_origem_e_terminal' and tgrelid = 'public.acordos_titulos'::regclass) <> 'O' then
    raise exception 'REV_POS: trava terminal nao foi religada';
  end if;

  v_det := jsonb_build_object('lote', c_rotulo, 'modo', c_modo, 'motivo', c_motivo, 'explicacao', c_explica,
    'titulos', (select count(*) from _u), 'alunos', cardinality(c_alunos), 'valor', (select sum(valor) from _u),
    'titulo_ids', (select jsonb_agg(titulo_id order by titulo_id) from _u),
    'confirmacao_anterior', (select jsonb_agg(jsonb_build_object('titulo_id', titulo_id, 'documento', documento, 'decidido_por', decidido_por,
                               'decidido_em', decidido_em, 'origem_liquidacao_ref', origem_liquidacao_ref, 'origem_liquidacao_em', origem_liquidacao_em)
                               order by titulo_id) from _u),
    'por_aluno', v_rel,
    'fichas_reabertura_barradas', (select count(*) from public.ficha_reabertura_barrada) - v_barr0,
    'duracao_s', round(extract(epoch from clock_timestamp() - v_t0)::numeric, 1));

  if c_modo = 'SIMULACAO' then
    raise exception 'SIMULACAO %', v_det::text;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_REVERSAO_AUDITORIA_A1', 'prime_conferencia_decisao', null, v_det);
end;
$rev$;
