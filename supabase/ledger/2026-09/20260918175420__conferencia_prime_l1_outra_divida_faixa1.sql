-- CONFERENCIA PRIME -- L1 COM OUTRA DIVIDA (opcao 1), faixa 1 de 3 (alunos com id em [0, 8)).
-- Autorizado pela gestao em 18/09/2026. So a funcao oficial prime_conferencia_confirmar, e so para aluno que
-- continua com outra divida exigivel. Aluno que ficaria quitado nao e confirmado: o bloco dele volta inteiro
-- e ele fica na decisao separada. Qualquer outro efeito ou erro desfaz a faixa inteira.
set local statement_timeout = '600s';
do $l1b$
declare
  c_faixa  constant int  := 1;
  c_ini    constant text := '0';
  c_fim    constant text := '8';
  c_obs    constant text := 'Lote L1 com outra divida (opcao 1) autorizado pela gestao em 18/09/2026; execucao em lote, faixa 1 de 3.';
  c_corte  constant timestamptz := '2026-09-18 15:19:00+00';
  c_seis   constant text[] := array['3769303','3769305','4521350','4049973','4230290','1109937','1109938','3943353','3943354','3943355'];
  c_bloq   constant text[] := array['JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA'];
  v_md5 text;
  v_fila bigint; v_acordos bigint; v_parcelas bigint; v_pagamentos bigint; v_vinc bigint; v_emconf bigint;
  al record; r record; v_res jsonb; v_motivo text; v_n int;
  v_ok uuid[] := '{}'; v_ok_al uuid[]; v_valor numeric := 0; v_valor_al numeric; v_alunos_ok int := 0;
  v_pul jsonb := '[]'::jsonb; v_pul_al jsonb; v_mov jsonb := '[]'::jsonb; v_err jsonb := '[]'::jsonb;
  v_so_conf_alunos int := 0; v_so_conf_titulos int := 0;
  v_resp0 text; v_fila_al bigint;
begin
  -- 0. funcoes oficiais intactas e reposicao pausada
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any(array['_talvez_quitar_aluno','_titulo_em_confirmacao_protegido','_titulo_situacao_e_status_coerentes','_trg_auto_quitar_titulo','aluno_saldo_pendente_detalhe','assumir_caso_livre','caso_aguarda_confirmacao_financeira','caso_protegido_redistribuicao','casos_encerrar_zerados_sem_debito','casos_reavaliar_encerramento','contar_carteira_ativa','nivelar_medias_progressivo','prime_conferencia_baixar','prime_conferencia_confirmar','prime_conferencia_detectar_grupo_a','prime_conferencia_fila','prime_conferencia_rejeitar','prime_conferencia_rejeitar_lote','prime_conferencia_vincular','prime_grupo_a_candidatos','recalcular_situacao_aluno','reforcar_teto_operadores','titulo_liquidado_na_origem_e_terminal']);
  if v_md5 is distinct from 'd9e15cb291b2aa3c05f3a0f0f335f732' then
    raise exception 'L1B_PRE: funcoes do grupo A mudaram (%)', v_md5;
  end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then
    raise exception 'L1B_PRE: reposicao de carteira nao esta pausada';
  end if;

  -- 1. quem decide e a gestao que autorizou (as funcoes oficiais exigem pessoa autenticada)
  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","sub":"52b292e4-e43e-4200-a684-b63d889d273a","role":"authenticated"}', true);

  -- 2. universo da faixa: A1 sem revisao, PENDENTE, alunos da faixa
  create temp table _u on commit drop as
    select d.titulo_id, d.aluno_id from public.prime_conferencia_decisao d
     where d.subgrupo = 'A1' and not d.revisao_obrigatoria and d.decisao = 'PENDENTE'
       and (d.aluno_id::text collate "C") >= c_ini and (d.aluno_id::text collate "C") < c_fim;

  -- 3. fotografia antes
  create temp table _t0 on commit drop as
    select id, situacao, status, acordo_id, valor_original, saldo_corrigido, valor_em_aberto, valor_cobranca_ajustado,
           documento, vencimento, origem_liquidacao
      from public.acordos_titulos where aluno_id in (select aluno_id from _u);
  create temp table _c0 on commit drop as
    select id, aluno_id, operador_email, encerrado_operacional from public.casos where aluno_id in (select aluno_id from _u);
  create temp table _a0 on commit drop as
    select id, responsavel_atual_email from public.alunos where id in (select aluno_id from _u);
  select coalesce(max(id), 0) into v_fila from public.reposicao_carteira_fila;
  select count(*) into v_acordos from public.acordos;
  select count(*) into v_parcelas from public.parcelas;
  select count(*) into v_pagamentos from public.pagamentos;
  select count(*) into v_vinc from public.acordo_titulo_vinculo where coalesce(ativo, true);
  select count(*) into v_emconf from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';

  -- 4. evidencia Prime reavaliada agora, pela funcao oficial
  create temp table _cand on commit drop as
    select * from public.prime_grupo_a_candidatos(array(select titulo_id from _u));

  -- 5. aluno a aluno
  for al in
    select u.aluno_id, max(a.situacao_operacional) sit, max(a.saldo_total) saldo, count(*) n
      from _u u join public.alunos a on a.id = u.aluno_id group by u.aluno_id order by u.aluno_id
  loop
    -- so com a confirmacao pendente: fica para a decisao separada (quitacao total)
    if coalesce(al.sit,'') = 'AGUARDANDO_CONFIRMACAO' or coalesce(al.sit,'') like 'QUITADO%' or coalesce(al.saldo, 0) <= 0.005 then
      v_so_conf_alunos := v_so_conf_alunos + 1;
      v_so_conf_titulos := v_so_conf_titulos + al.n;
      continue;
    end if;
    v_ok_al := '{}'; v_valor_al := 0; v_pul_al := '[]'::jsonb;
    begin
      select responsavel_atual_email into v_resp0 from public.alunos where id = al.aluno_id;
      select coalesce(max(id), 0) into v_fila_al from public.reposicao_carteira_fila;
      for r in
        select u.titulo_id, u.aluno_id, d.decisao, d.subgrupo, d.revisao_obrigatoria, d.evidencia_chave, d.valor,
               t.situacao, t.status, t.documento,
               coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor_atual,
               (c.titulo_id is not null) as tem_ev, c.subgrupo as sub_agora, c.evidencia_chave as chave_agora,
               c.revisao_obrigatoria as rev_agora,
               a.status_jornada, a.status_atual, a.status_acionamento, a.responsavel_atual_email,
               nullif(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), '') as cpf_limpo
          from _u u
          join public.prime_conferencia_decisao d on d.titulo_id = u.titulo_id
          join public.acordos_titulos t on t.id = u.titulo_id
          join public.alunos a on a.id = u.aluno_id
          left join _cand c on c.titulo_id = u.titulo_id
         where u.aluno_id = al.aluno_id
         order by t.vencimento, u.titulo_id
      loop
        v_motivo := case
          when r.situacao is distinct from 'EM_CONFIRMACAO' or r.status is distinct from 'em_confirmacao' then 'NAO_ESTA_EM_CONFIRMACAO'
          when r.decisao <> 'PENDENTE' then 'DECISAO_NAO_PENDENTE'
          when r.subgrupo <> 'A1' or r.revisao_obrigatoria then 'FORA_DO_L1'
          when r.valor is distinct from r.valor_atual then 'VALOR_MUDOU'
          when not r.tem_ev then 'EVIDENCIA_NAO_SUSTENTA'
          when r.sub_agora <> 'A1' then 'SUBGRUPO_MUDOU'
          when r.chave_agora is distinct from r.evidencia_chave then 'EVIDENCIA_MUDOU'
          when r.rev_agora then 'REVISAO_OBRIGATORIA'
          when r.documento = any(c_seis)
            or exists (select 1 from public.acordos_titulos t6 where t6.aluno_id = r.aluno_id and t6.documento = any(c_seis)) then 'R4_SEIS_BOLETOS'
          when exists (select 1 from public.fila_pagamento_sem_vinculo fp left join public.pagamentos pg on pg.id = fp.pagamento_id
                        where fp.decisao is null and (pg.aluno_id = r.aluno_id or fp.aluno_escolhido_id = r.aluno_id)) then 'R4_FILA_PAGAMENTOS'
          when upper(coalesce(r.status_jornada,'')) = any(c_bloq) or upper(coalesce(r.status_atual,'')) = any(c_bloq)
            or upper(coalesce(r.status_acionamento,'')) = any(c_bloq) then 'R1_COBRANCA_NAO_COMUM'
          when lower(coalesce(r.responsavel_atual_email,'')) like 'juridico%'
            or exists (select 1 from public.casos k where k.aluno_id = r.aluno_id and not coalesce(k.encerrado_operacional,false)
                         and lower(coalesce(k.operador_email,'')) like 'juridico%') then 'JURIDICO'
          when exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = r.aluno_id::text
                         and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) then 'R2_SOLICITACAO_FINANCEIRO'
          when exists (select 1 from public.acordos x where x.aluno_id = r.aluno_id and x.criado_em >= c_corte) then 'ACORDO_NOVO'
          when exists (select 1 from public.pagamentos p where p.created_at >= c_corte
                         and (p.aluno_id = r.aluno_id
                              or (r.cpf_limpo is not null and regexp_replace(coalesce(p.cpf,''), '\D', '', 'g') = r.cpf_limpo))) then 'PAGAMENTO_NOVO'
        end;
        if v_motivo is not null then
          v_pul_al := v_pul_al || jsonb_build_object('titulo_id', r.titulo_id, 'documento', r.documento, 'motivo', v_motivo);
          continue;
        end if;
        v_res := public.prime_conferencia_confirmar(r.titulo_id, c_obs);
        if coalesce(v_res->>'decisao','') <> 'CONFIRMADO' or coalesce((v_res->>'ja_processado')::boolean, false) then
          raise exception 'RESULTADO_INESPERADO %', v_res::text;
        end if;
        v_ok_al := v_ok_al || r.titulo_id;
        v_valor_al := v_valor_al + r.valor;
      end loop;
      -- o aluno tem de continuar com outra divida, com responsavel, operador e caso intactos
      if exists (select 1 from public.alunos a where a.id = al.aluno_id
                  and (coalesce(a.situacao_operacional,'') like 'QUITADO%' or coalesce(a.situacao_operacional,'') = 'AGUARDANDO_CONFIRMACAO'
                       or coalesce(a.saldo_total, 0) <= 0.005)) then
        raise exception 'ALUNO_QUITARIA';
      end if;
      if (select responsavel_atual_email from public.alunos where id = al.aluno_id) is distinct from v_resp0 then
        raise exception 'ALUNO_EFEITO: responsavel mudou';
      end if;
      if exists (select 1 from public.casos c join _c0 p on p.id = c.id where c.aluno_id = al.aluno_id
                  and (c.operador_email, c.encerrado_operacional) is distinct from (p.operador_email, p.encerrado_operacional)) then
        raise exception 'ALUNO_EFEITO: caso mudou';
      end if;
      if (select coalesce(max(id), 0) from public.reposicao_carteira_fila) <> v_fila_al then
        raise exception 'ALUNO_EFEITO: reposicao enfileirada';
      end if;
      v_ok := v_ok || v_ok_al;
      v_valor := v_valor + v_valor_al;
      v_pul := v_pul || v_pul_al;
      if cardinality(v_ok_al) > 0 then v_alunos_ok := v_alunos_ok + 1; end if;
    exception when others then
      if sqlerrm = 'ALUNO_QUITARIA' then
        v_mov := v_mov || jsonb_build_object('aluno_id', al.aluno_id, 'motivo', 'QUITARIA_NA_EXECUCAO');
      else
        v_err := v_err || jsonb_build_object('aluno', left(al.aluno_id::text, 8), 'erro', left(sqlerrm, 160));
      end if;
    end;
  end loop;

  if jsonb_array_length(v_err) > 0 then
    raise exception 'L1B_ERRO faixa %: % aluno(s) com erro ou efeito; primeiros: %', c_faixa, jsonb_array_length(v_err),
      (select jsonb_agg(e) from (select e from jsonb_array_elements(v_err) e limit 2) z)::text;
  end if;
  if cardinality(v_ok) > 50 then
    raise exception 'L1B_CONF faixa %: mais de 50 titulos (%)', c_faixa, cardinality(v_ok);
  end if;

  -- 6. conferencias da faixa
  select count(*) into v_n from public.acordos_titulos t join _t0 p on p.id = t.id
   where t.id = any(v_ok) and t.situacao = 'PAGO' and t.status = 'quitada'
     and t.origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL' and t.acordo_id is null
     and (t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado, t.documento, t.vencimento)
         is not distinct from (p.valor_original, p.saldo_corrigido, p.valor_em_aberto, p.valor_cobranca_ajustado, p.documento, p.vencimento);
  if v_n <> cardinality(v_ok) then
    raise exception 'L1B_CONF faixa %: % confirmados fora do esperado', c_faixa, cardinality(v_ok) - v_n;
  end if;
  if (select count(*) from public.prime_conferencia_decisao where titulo_id = any(v_ok) and decisao = 'CONFIRMADO' and decidido_em is not null) <> cardinality(v_ok) then
    raise exception 'L1B_CONF faixa %: decisao CONFIRMADO faltando', c_faixa;
  end if;
  select count(*) into v_n from public.acordos_titulos t join _t0 p on p.id = t.id
   where not (t.id = any(v_ok))
     and (t.situacao, t.status, t.acordo_id, t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado, t.origem_liquidacao)
         is distinct from (p.situacao, p.status, p.acordo_id, p.valor_original, p.saldo_corrigido, p.valor_em_aberto, p.valor_cobranca_ajustado, p.origem_liquidacao);
  if v_n <> 0 then
    raise exception 'L1B_CONF faixa %: % outros titulos desses alunos mudaram', c_faixa, v_n;
  end if;
  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') <> v_emconf - cardinality(v_ok) then
    raise exception 'L1B_CONF faixa %: EM_CONFIRMACAO nao caiu exatamente o confirmado', c_faixa;
  end if;
  if (select count(*) from public.acordos) <> v_acordos or (select count(*) from public.parcelas) <> v_parcelas
     or (select count(*) from public.pagamentos) <> v_pagamentos
     or (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) <> v_vinc then
    raise exception 'L1B_CONF faixa %: acordo, parcela, pagamento ou vinculo criado', c_faixa;
  end if;
  select count(*) into v_n from public.casos c join _c0 p on p.id = c.id
   where (c.operador_email, c.encerrado_operacional) is distinct from (p.operador_email, p.encerrado_operacional);
  if v_n <> 0 then
    raise exception 'L1B_CONF faixa %: % casos mudaram operador ou encerramento', c_faixa, v_n;
  end if;
  if (select count(*) from public.casos where aluno_id in (select aluno_id from _u)) <> (select count(*) from _c0) then
    raise exception 'L1B_CONF faixa %: numero de casos mudou', c_faixa;
  end if;
  select count(*) into v_n from public.alunos a join _a0 p on p.id = a.id where a.responsavel_atual_email is distinct from p.responsavel_atual_email;
  if v_n <> 0 then
    raise exception 'L1B_CONF faixa %: % alunos trocaram/perderam responsavel', c_faixa, v_n;
  end if;
  if (select coalesce(max(id), 0) from public.reposicao_carteira_fila) <> v_fila then
    raise exception 'L1B_CONF faixa %: reposicao enfileirada', c_faixa;
  end if;

  -- 7. registro da faixa
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_LOTE_L1_OUTRA_DIVIDA', 'acordos_titulos',
          jsonb_build_object('faixa', c_faixa, 'de', 3, 'alunos_id_de', c_ini, 'alunos_id_ate', c_fim,
                             'universo', (select count(*) from _u),
                             'confirmados', cardinality(v_ok), 'alunos_confirmados', v_alunos_ok, 'valor_confirmado', round(v_valor, 2),
                             'pulados', v_pul, 'movidos_para_quitacao_total', v_mov,
                             'mantidos_quitacao_total', jsonb_build_object('alunos', v_so_conf_alunos, 'titulos', v_so_conf_titulos),
                             'autorizacao', 'gestao 18/09/2026: opcao 1 (L2 + L1 com outra divida)'));
end;
$l1b$;
