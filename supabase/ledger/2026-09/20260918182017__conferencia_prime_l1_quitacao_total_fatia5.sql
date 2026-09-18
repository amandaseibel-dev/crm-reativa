-- CONFERENCIA PRIME -- L1 QUITACAO TOTAL, fatia 5 de 8.
-- Decisao da gestao CONFIRMACAO_PRIME_QUITACAO_TOTAL_AUTORIZADA (18/09/2026): quando a confirmacao quita a ultima
-- divida exigivel, o aluno fica QUITADO, o caso encerra, responsavel/operador saem e a reposicao pode ser
-- ENFILEIRADA; a reposicao automatica segue pausada. So a funcao oficial prime_conferencia_confirmar.
-- Aluno e unidade indivisivel: ou todos os titulos dele entram e o saldo fica zero, ou nada dele muda.
set local statement_timeout = '600s';
do $l1q$
declare
  c_fatia  constant int  := 5;
  c_tam    constant int  := 43;
  c_obs    constant text := 'Lote L1 quitacao total autorizado pela gestao em 18/09/2026 (CONFIRMACAO_PRIME_QUITACAO_TOTAL_AUTORIZADA); execucao em lote, fatia 5 de 8.';
  c_corte  constant timestamptz := '2026-09-18 15:19:00+00';
  c_seis   constant text[] := array['3769303','3769305','4521350','4049973','4230290','1109937','1109938','3943353','3943354','3943355'];
  c_bloq   constant text[] := array['JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA'];
  v_md5 text;
  v_fila bigint; v_acordos bigint; v_parcelas bigint; v_pagamentos bigint; v_vinc bigint; v_emconf bigint;
  al record; r record; v_res jsonb; v_motivo text; v_n int;
  v_ok uuid[] := '{}'; v_ok_al uuid[]; v_alunos_ok uuid[] := '{}'; v_valor numeric := 0; v_valor_al numeric;
  v_pul jsonb := '[]'::jsonb; v_nz jsonb := '[]'::jsonb; v_stop jsonb := '[]'::jsonb; v_err jsonb := '[]'::jsonb;
  v_sit text; v_saldo numeric; v_rem int;
begin
  -- 0. funcoes oficiais intactas, reposicao pausada, decisao da gestao registrada
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any(array['_talvez_quitar_aluno','_titulo_em_confirmacao_protegido','_titulo_situacao_e_status_coerentes','_trg_auto_quitar_titulo','aluno_saldo_pendente_detalhe','assumir_caso_livre','caso_aguarda_confirmacao_financeira','caso_protegido_redistribuicao','casos_encerrar_zerados_sem_debito','casos_reavaliar_encerramento','contar_carteira_ativa','nivelar_medias_progressivo','prime_conferencia_baixar','prime_conferencia_confirmar','prime_conferencia_detectar_grupo_a','prime_conferencia_fila','prime_conferencia_rejeitar','prime_conferencia_rejeitar_lote','prime_conferencia_vincular','prime_grupo_a_candidatos','recalcular_situacao_aluno','reforcar_teto_operadores','titulo_liquidado_na_origem_e_terminal']);
  if v_md5 is distinct from 'd9e15cb291b2aa3c05f3a0f0f335f732' then
    raise exception 'L1Q_PRE: funcoes do grupo A mudaram (%)', v_md5;
  end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then
    raise exception 'L1Q_PRE: reposicao de carteira nao esta pausada';
  end if;
  if not exists (select 1 from public.auditoria where acao = 'CONFIRMACAO_PRIME_QUITACAO_TOTAL_AUTORIZADA') then
    raise exception 'L1Q_PRE: decisao da gestao nao registrada';
  end if;

  -- 1. quem decide e a gestao que autorizou (as funcoes oficiais exigem pessoa autenticada)
  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","sub":"52b292e4-e43e-4200-a684-b63d889d273a","role":"authenticated"}', true);

  -- 2. universo fixo: os 312 titulos registrados na auditoria; fatia por aluno, sem partir aluno
  create temp table _q on commit drop as
    select (x)::uuid as titulo_id from public.auditoria a, jsonb_array_elements_text(a.detalhes->'titulo_ids') x
     where a.acao = 'CONFIRMACAO_PRIME_QUITACAO_TOTAL_AGUARDA_REGRA_GESTAO';
  if (select count(*) from _q) <> 312 then
    raise exception 'L1Q_PRE: lista registrada nao tem 312 titulos';
  end if;
  create temp table _u on commit drop as
    with u as (select d.titulo_id, d.aluno_id from public.prime_conferencia_decisao d join _q using (titulo_id)),
         al as (select aluno_id, count(*)::int n from u group by 1),
         c as (select aluno_id, (sum(n) over (order by aluno_id))::int cum from al)
    select u.titulo_id, u.aluno_id from u join c using (aluno_id) where ((c.cum - 1) / c_tam) + 1 = c_fatia;
  select count(*) into v_n from _u;
  if v_n = 0 or v_n > 50 then
    raise exception 'L1Q_PRE: fatia % vazia ou acima de 50 (%)', c_fatia, v_n;
  end if;

  -- 3. fotografia antes
  create temp table _t0 on commit drop as
    select id, aluno_id, situacao, status, acordo_id, valor_original, saldo_corrigido, valor_em_aberto, valor_cobranca_ajustado,
           documento, vencimento, origem_liquidacao
      from public.acordos_titulos where aluno_id in (select aluno_id from _u);
  create temp table _c0 on commit drop as
    select id, aluno_id, operador_email, encerrado_operacional from public.casos where aluno_id in (select aluno_id from _u);
  create temp table _a0 on commit drop as
    select id, responsavel_atual_email, situacao_operacional from public.alunos where id in (select aluno_id from _u);
  select coalesce(max(id), 0) into v_fila from public.reposicao_carteira_fila;
  select count(*) into v_acordos from public.acordos;
  select count(*) into v_parcelas from public.parcelas;
  select count(*) into v_pagamentos from public.pagamentos;
  select count(*) into v_vinc from public.acordo_titulo_vinculo where coalesce(ativo, true);
  select count(*) into v_emconf from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';

  -- 4. evidencia Prime reavaliada agora, pela funcao oficial
  create temp table _cand on commit drop as
    select * from public.prime_grupo_a_candidatos(array(select titulo_id from _u));

  -- 5. aluno a aluno (unidade indivisivel)
  for al in
    select u.aluno_id, a.situacao_operacional sit, a.saldo_total saldo, a.status_jornada, a.status_atual, a.status_acionamento,
           a.responsavel_atual_email resp, nullif(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), '') cpf_limpo
      from (select distinct aluno_id from _u) u join public.alunos a on a.id = u.aluno_id
     order by u.aluno_id
  loop
    v_motivo := case
      when exists (select 1 from _u u join public.acordos_titulos t on t.id = u.titulo_id where u.aluno_id = al.aluno_id
                    and (t.situacao is distinct from 'EM_CONFIRMACAO' or t.status is distinct from 'em_confirmacao')) then 'NAO_ESTA_EM_CONFIRMACAO'
      when exists (select 1 from _u u join public.prime_conferencia_decisao d on d.titulo_id = u.titulo_id where u.aluno_id = al.aluno_id
                    and (d.decisao <> 'PENDENTE' or d.subgrupo <> 'A1' or d.revisao_obrigatoria)) then 'FORA_DO_L1_CONFIRMAVEL'
      when exists (select 1 from _u u join public.prime_conferencia_decisao d on d.titulo_id = u.titulo_id
                     join public.acordos_titulos t on t.id = u.titulo_id where u.aluno_id = al.aluno_id
                    and d.valor is distinct from coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) then 'VALOR_MUDOU'
      when exists (select 1 from _u u join public.prime_conferencia_decisao d on d.titulo_id = u.titulo_id
                     left join _cand c on c.titulo_id = u.titulo_id where u.aluno_id = al.aluno_id
                    and (c.titulo_id is null or c.subgrupo <> 'A1' or c.evidencia_chave is distinct from d.evidencia_chave or c.revisao_obrigatoria)) then 'EVIDENCIA_MUDOU'
      when exists (select 1 from public.prime_conferencia_decisao x where x.aluno_id = al.aluno_id and x.decisao = 'PENDENTE'
                    and x.titulo_id not in (select titulo_id from _u)) then 'OUTRA_PENDENCIA_NA_CONFERENCIA'
      when exists (select 1 from public.acordos_titulos t6 where t6.aluno_id = al.aluno_id and t6.documento = any(c_seis))
        or exists (select 1 from public.fila_pagamento_sem_vinculo fp left join public.pagamentos pg on pg.id = fp.pagamento_id
                    where fp.decisao is null and (pg.aluno_id = al.aluno_id or fp.aluno_escolhido_id = al.aluno_id)) then 'R4'
      when upper(coalesce(al.status_jornada,'')) = any(c_bloq) or upper(coalesce(al.status_atual,'')) = any(c_bloq)
        or upper(coalesce(al.status_acionamento,'')) = any(c_bloq) then 'R1'
      when lower(coalesce(al.resp,'')) like 'juridico%'
        or exists (select 1 from public.casos k where k.aluno_id = al.aluno_id and not coalesce(k.encerrado_operacional,false)
                     and lower(coalesce(k.operador_email,'')) like 'juridico%') then 'JURIDICO'
      when exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = al.aluno_id::text
                     and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) then 'R2'
      when exists (select 1 from public.acordos x where x.aluno_id = al.aluno_id and x.criado_em >= c_corte) then 'ACORDO_NOVO'
      when exists (select 1 from public.pagamentos p where p.created_at >= c_corte
                     and (p.aluno_id = al.aluno_id
                          or (al.cpf_limpo is not null and regexp_replace(coalesce(p.cpf,''), '\D', '', 'g') = al.cpf_limpo))) then 'PAGAMENTO_NOVO'
      when coalesce(al.sit,'') <> 'AGUARDANDO_CONFIRMACAO' or coalesce(al.saldo, 0) > 0.005 then 'TEM_OUTRA_DIVIDA'
    end;
    if v_motivo is not null then
      v_pul := v_pul || jsonb_build_object('aluno_id', al.aluno_id, 'titulos', (select count(*) from _u where aluno_id = al.aluno_id), 'motivo', v_motivo);
      continue;
    end if;

    v_ok_al := '{}'; v_valor_al := 0;
    begin
      for r in
        select u.titulo_id, d.valor from _u u join public.prime_conferencia_decisao d on d.titulo_id = u.titulo_id
          join public.acordos_titulos t on t.id = u.titulo_id
         where u.aluno_id = al.aluno_id order by t.vencimento, u.titulo_id
      loop
        v_res := public.prime_conferencia_confirmar(r.titulo_id, c_obs);
        if coalesce(v_res->>'decisao','') <> 'CONFIRMADO' or coalesce((v_res->>'ja_processado')::boolean, false) then
          raise exception 'RESULTADO_INESPERADO %', v_res::text;
        end if;
        v_ok_al := v_ok_al || r.titulo_id;
        v_valor_al := v_valor_al + r.valor;
      end loop;

      select situacao_operacional, coalesce(saldo_total, 0) into v_sit, v_saldo from public.alunos where id = al.aluno_id;
      select count(*) into v_rem from public.acordos_titulos where aluno_id = al.aluno_id and upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';
      if coalesce(v_sit,'') like 'QUITADO%' then
        if v_saldo > 0.005 or v_rem > 0 then
          raise exception 'PARAR: aluno QUITADO ainda com divida exigivel (saldo %, em confirmacao %)', v_saldo, v_rem;
        end if;
      else
        -- nao zerou: se ainda assim encerrou caso ou liberou responsavel, e parada; senao o aluno volta inteiro
        if exists (select 1 from public.casos c join _c0 p on p.id = c.id where c.aluno_id = al.aluno_id
                    and c.encerrado_operacional and not p.encerrado_operacional) then
          raise exception 'PARAR: caso encerrado com saldo restante';
        end if;
        if al.resp is not null and (select responsavel_atual_email from public.alunos where id = al.aluno_id) is null then
          raise exception 'PARAR: responsavel liberado de aluno que ainda tem divida';
        end if;
        raise exception 'ALUNO_NAO_ZEROU';
      end if;
      -- quitado: operador so pode sair (nunca trocar por outro); nenhum caso novo
      if exists (select 1 from public.casos c join _c0 p on p.id = c.id where c.aluno_id = al.aluno_id
                  and c.operador_email is not null and c.operador_email is distinct from p.operador_email) then
        raise exception 'PARAR: redistribuicao efetiva (operador trocado)';
      end if;
      if (select count(*) from public.casos where aluno_id = al.aluno_id) <> (select count(*) from _c0 where aluno_id = al.aluno_id) then
        raise exception 'PARAR: caso novo criado';
      end if;
      v_ok := v_ok || v_ok_al;
      v_valor := v_valor + v_valor_al;
      v_alunos_ok := v_alunos_ok || al.aluno_id;
    exception when others then
      if sqlerrm = 'ALUNO_NAO_ZEROU' then
        v_nz := v_nz || jsonb_build_object('aluno_id', al.aluno_id, 'situacao_depois', v_sit, 'saldo_depois', v_saldo);
      elsif sqlerrm like 'PARAR:%' then
        v_stop := v_stop || jsonb_build_object('aluno', left(al.aluno_id::text, 8), 'motivo', sqlerrm);
      else
        v_err := v_err || jsonb_build_object('aluno', left(al.aluno_id::text, 8), 'erro', left(sqlerrm, 160));
      end if;
    end;
  end loop;

  if jsonb_array_length(v_stop) > 0 then
    raise exception 'L1Q_PARAR fatia %: %', c_fatia, left(v_stop::text, 400);
  end if;
  if jsonb_array_length(v_err) > 0 then
    raise exception 'L1Q_ERRO fatia %: % aluno(s); primeiros: %', c_fatia, jsonb_array_length(v_err),
      (select jsonb_agg(e) from (select e from jsonb_array_elements(v_err) e limit 2) z)::text;
  end if;
  if cardinality(v_ok) > 50 then
    raise exception 'L1Q_CONF fatia %: mais de 50 titulos (%)', c_fatia, cardinality(v_ok);
  end if;

  -- 6. conferencias da fatia
  select count(*) into v_n from public.acordos_titulos t join _t0 p on p.id = t.id
   where t.id = any(v_ok) and t.situacao = 'PAGO' and t.status = 'quitada'
     and t.origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL' and t.acordo_id is null
     and (t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado, t.documento, t.vencimento)
         is not distinct from (p.valor_original, p.saldo_corrigido, p.valor_em_aberto, p.valor_cobranca_ajustado, p.documento, p.vencimento);
  if v_n <> cardinality(v_ok) then
    raise exception 'L1Q_CONF fatia %: % confirmados sem PAGO/origem oficial/valores intactos', c_fatia, cardinality(v_ok) - v_n;
  end if;
  if (select count(*) from public.prime_conferencia_decisao where titulo_id = any(v_ok) and decisao = 'CONFIRMADO' and decidido_em is not null) <> cardinality(v_ok) then
    raise exception 'L1Q_CONF fatia %: decisao CONFIRMADO faltando', c_fatia;
  end if;
  select count(*) into v_n from public.acordos_titulos t join _t0 p on p.id = t.id
   where not (t.id = any(v_ok))
     and (t.situacao, t.status, t.acordo_id, t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado, t.origem_liquidacao)
         is distinct from (p.situacao, p.status, p.acordo_id, p.valor_original, p.saldo_corrigido, p.valor_em_aberto, p.valor_cobranca_ajustado, p.origem_liquidacao);
  if v_n <> 0 then
    raise exception 'L1Q_CONF fatia %: % outros titulos desses alunos mudaram', c_fatia, v_n;
  end if;
  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') <> v_emconf - cardinality(v_ok) then
    raise exception 'L1Q_CONF fatia %: EM_CONFIRMACAO nao caiu exatamente o confirmado', c_fatia;
  end if;
  if (select count(*) from public.acordos) <> v_acordos or (select count(*) from public.parcelas) <> v_parcelas
     or (select count(*) from public.pagamentos) <> v_pagamentos
     or (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) <> v_vinc then
    raise exception 'L1Q_CONF fatia %: acordo, parcela, pagamento ou vinculo criado', c_fatia;
  end if;
  -- alunos aceitos: QUITADO, saldo zero, nada mais em confirmacao
  if exists (select 1 from public.alunos a where a.id = any(v_alunos_ok)
              and (coalesce(a.situacao_operacional,'') not like 'QUITADO%' or coalesce(a.saldo_total, 0) > 0.005)) then
    raise exception 'L1Q_CONF fatia %: aluno aceito sem QUITADO/saldo zero', c_fatia;
  end if;
  -- alunos nao aceitos: nada mudou
  if exists (select 1 from public.casos c join _c0 p on p.id = c.id where not (c.aluno_id = any(v_alunos_ok))
              and (c.operador_email, c.encerrado_operacional) is distinct from (p.operador_email, p.encerrado_operacional))
     or exists (select 1 from public.alunos a join _a0 p on p.id = a.id where not (a.id = any(v_alunos_ok))
              and a.responsavel_atual_email is distinct from p.responsavel_atual_email) then
    raise exception 'L1Q_CONF fatia %: aluno nao processado teve caso/responsavel alterado', c_fatia;
  end if;
  -- reposicao: pode enfileirar, nunca processar
  if exists (select 1 from public.reposicao_carteira_fila where id > v_fila and processado_em is not null) then
    raise exception 'L1Q_CONF fatia %: reposicao processada apesar de pausada', c_fatia;
  end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then
    raise exception 'L1Q_CONF fatia %: reposicao reativada', c_fatia;
  end if;

  -- 7. registro da fatia
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_LOTE_L1_QUITACAO_TOTAL', 'acordos_titulos',
          jsonb_build_object('fatia', c_fatia, 'de', 8, 'universo', (select count(*) from _u),
            'titulos_confirmados', cardinality(v_ok), 'alunos_processados', cardinality(v_alunos_ok), 'valor', round(v_valor, 2),
            'alunos_quitados', (select count(*) from public.alunos where id = any(v_alunos_ok) and situacao_operacional like 'QUITADO%'),
            'casos_encerrados', (select count(*) from public.casos c join _c0 p on p.id = c.id where c.aluno_id = any(v_alunos_ok) and c.encerrado_operacional and not p.encerrado_operacional),
            'casos_ainda_ativos', (select count(*) from public.casos c where c.aluno_id = any(v_alunos_ok) and not coalesce(c.encerrado_operacional,false)),
            'responsaveis_liberados', (select count(*) from public.alunos a join _a0 p on p.id = a.id where a.id = any(v_alunos_ok) and p.responsavel_atual_email is not null and a.responsavel_atual_email is null),
            'vagas_liberadas', (select count(*) from public.casos c join _c0 p on p.id = c.id where c.aluno_id = any(v_alunos_ok) and p.operador_email is not null and not p.encerrado_operacional
                                  and (c.operador_email is null or c.encerrado_operacional)),
            'reposicoes_enfileiradas', (select count(*) from public.reposicao_carteira_fila f where f.id > v_fila and f.caso_origem_id in (select id from _c0 where aluno_id = any(v_alunos_ok))),
            'reposicoes_de_outras_frentes', (select count(*) from public.reposicao_carteira_fila f where f.id > v_fila and f.caso_origem_id not in (select id from _c0)),
            'alunos_pulados', v_pul, 'alunos_nao_zeraram', v_nz,
            'autorizacao', 'CONFIRMACAO_PRIME_QUITACAO_TOTAL_AUTORIZADA'));
end;
$l1q$;
