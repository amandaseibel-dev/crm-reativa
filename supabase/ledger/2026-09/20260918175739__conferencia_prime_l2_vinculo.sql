-- CONFERENCIA PRIME -- LOTE L2 (A2 coberto vinculavel direto), fatia unica.
-- Autorizado pela gestao em 18/09/2026. So a funcao oficial prime_conferencia_vincular.
-- Cada titulo e revalidado antes; titulo que mudou ou pertence a lote excluido e pulado.
-- Nenhum acordo, parcela, pagamento ou baixa e criado. Qualquer erro desfaz a fatia inteira.
set local statement_timeout = '600s';
do $l2$
declare
  c_obs    constant text := 'Lote L2 (A2 coberto vinculavel direto) autorizado pela gestao em 18/09/2026; execucao em lote, fatia unica.';
  c_corte  constant timestamptz := '2026-09-18 15:19:00+00';
  c_seis   constant text[] := array['3769303','3769305','4521350','4049973','4230290','1109937','1109938','3943353','3943354','3943355'];
  c_r3     constant text[] := array['4606','4609','4611','4616','4618'];
  c_bloq   constant text[] := array['JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA'];
  v_md5 text; v_md5_vta text;
  v_fila bigint; v_acordos bigint; v_parcelas bigint; v_pagamentos bigint; v_vinc bigint; v_emconf bigint;
  r record; v_res jsonb; v_motivo text; v_n int;
  v_ok uuid[] := '{}'; v_valor numeric := 0;
  v_pul jsonb := '[]'::jsonb; v_err jsonb := '[]'::jsonb;
begin
  -- 0. funcoes oficiais intactas e reposicao pausada
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any(array['_talvez_quitar_aluno','_titulo_em_confirmacao_protegido','_titulo_situacao_e_status_coerentes','_trg_auto_quitar_titulo','aluno_saldo_pendente_detalhe','assumir_caso_livre','caso_aguarda_confirmacao_financeira','caso_protegido_redistribuicao','casos_encerrar_zerados_sem_debito','casos_reavaliar_encerramento','contar_carteira_ativa','nivelar_medias_progressivo','prime_conferencia_baixar','prime_conferencia_confirmar','prime_conferencia_detectar_grupo_a','prime_conferencia_fila','prime_conferencia_rejeitar','prime_conferencia_rejeitar_lote','prime_conferencia_vincular','prime_grupo_a_candidatos','recalcular_situacao_aluno','reforcar_teto_operadores','titulo_liquidado_na_origem_e_terminal']);
  select md5(prosrc) into v_md5_vta from pg_proc where pronamespace = 'public'::regnamespace and proname = 'vincular_titulos_acordo';
  if v_md5 is distinct from 'd9e15cb291b2aa3c05f3a0f0f335f732' or v_md5_vta is distinct from 'd857ce1e53b4f5aea87ee49f7e92406f' then
    raise exception 'L2_PRE: funcoes mudaram (% / %)', v_md5, v_md5_vta;
  end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then
    raise exception 'L2_PRE: reposicao de carteira nao esta pausada';
  end if;

  -- 1. quem decide e a gestao que autorizou (o vinculo exige pessoa autenticada)
  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","sub":"52b292e4-e43e-4200-a684-b63d889d273a","role":"authenticated"}', true);

  -- 2. universo fixo: A2 coberto sem revisao
  create temp table _fatia on commit drop as
    select d.titulo_id, d.aluno_id from public.prime_conferencia_decisao d
     where d.subgrupo = 'A2_COBRE' and not d.revisao_obrigatoria;

  -- 3. fotografia antes
  create temp table _t0 on commit drop as
    select id, situacao, status, acordo_id, valor_original, saldo_corrigido, valor_em_aberto, valor_cobranca_ajustado,
           documento, vencimento, origem_liquidacao
      from public.acordos_titulos where aluno_id in (select aluno_id from _fatia);
  create temp table _c0 on commit drop as
    select id, aluno_id, operador_email, encerrado_operacional from public.casos where aluno_id in (select aluno_id from _fatia);
  create temp table _a0 on commit drop as
    select id, responsavel_atual_email from public.alunos where id in (select aluno_id from _fatia);
  create temp table _ac0 on commit drop as
    select id, status, valor_total, aluno_id from public.acordos where aluno_id in (select aluno_id from _fatia);
  create temp table _p0 on commit drop as
    select p.id, p.acordo_id, p.status, p.valor, p.vencimento from public.parcelas p where p.acordo_id in (select id from _ac0);
  select coalesce(max(id), 0) into v_fila from public.reposicao_carteira_fila;
  select count(*) into v_acordos from public.acordos;
  select count(*) into v_parcelas from public.parcelas;
  select count(*) into v_pagamentos from public.pagamentos;
  select count(*) into v_vinc from public.acordo_titulo_vinculo where coalesce(ativo, true);
  select count(*) into v_emconf from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';

  -- 4. evidencia Prime reavaliada agora, pela funcao oficial
  create temp table _cand on commit drop as
    select * from public.prime_grupo_a_candidatos(array(select titulo_id from _fatia));

  -- 5. titulo a titulo
  for r in
    select f.titulo_id, f.aluno_id, d.decisao, d.subgrupo, d.revisao_obrigatoria, d.evidencia_chave, d.valor,
           d.acordo_id, d.acordo_numero,
           t.situacao, t.status, t.documento,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor_atual,
           (c.titulo_id is not null) as tem_ev, c.subgrupo as sub_agora, c.evidencia_chave as chave_agora,
           c.revisao_obrigatoria as rev_agora, c.acordo_id as acordo_agora,
           ac.status as ac_status, ac.aluno_id as ac_aluno,
           a.status_jornada, a.status_atual, a.status_acionamento, a.responsavel_atual_email,
           nullif(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), '') as cpf_limpo
      from _fatia f
      join public.prime_conferencia_decisao d on d.titulo_id = f.titulo_id
      join public.acordos_titulos t on t.id = f.titulo_id
      join public.alunos a on a.id = f.aluno_id
      left join public.acordos ac on ac.id = d.acordo_id
      left join _cand c on c.titulo_id = f.titulo_id
     order by f.aluno_id, t.vencimento, f.titulo_id
  loop
    v_motivo := case
      when r.situacao is distinct from 'EM_CONFIRMACAO' or r.status is distinct from 'em_confirmacao' then 'NAO_ESTA_EM_CONFIRMACAO'
      when r.decisao <> 'PENDENTE' then 'DECISAO_NAO_PENDENTE'
      when r.subgrupo <> 'A2_COBRE' or r.revisao_obrigatoria then 'FORA_DO_L2'
      when r.valor is distinct from r.valor_atual then 'VALOR_MUDOU'
      when not r.tem_ev then 'EVIDENCIA_NAO_SUSTENTA'
      when r.sub_agora <> 'A2_COBRE' then 'SUBGRUPO_MUDOU'
      when r.acordo_agora is distinct from r.acordo_id then 'ACORDO_MUDOU'
      when r.chave_agora is distinct from r.evidencia_chave then 'EVIDENCIA_MUDOU'
      when r.rev_agora then 'REVISAO_OBRIGATORIA'
      when r.acordo_numero = any(c_r3) then 'R3_ACORDO_EXCLUIDO'
      when exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = r.aluno_id::text
                     and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) then 'R3_SOLICITACAO_FINANCEIRO'
      when r.documento = any(c_seis)
        or exists (select 1 from public.acordos_titulos t6 where t6.aluno_id = r.aluno_id and t6.documento = any(c_seis)) then 'R4_SEIS_BOLETOS'
      when exists (select 1 from public.fila_pagamento_sem_vinculo fp left join public.pagamentos pg on pg.id = fp.pagamento_id
                    where fp.decisao is null and (pg.aluno_id = r.aluno_id or fp.aluno_escolhido_id = r.aluno_id)) then 'FILA_PAGAMENTOS'
      when upper(coalesce(r.status_jornada,'')) = any(c_bloq) or upper(coalesce(r.status_atual,'')) = any(c_bloq)
        or upper(coalesce(r.status_acionamento,'')) = any(c_bloq) then 'COBRANCA_NAO_COMUM'
      when lower(coalesce(r.responsavel_atual_email,'')) like 'juridico%'
        or exists (select 1 from public.casos k where k.aluno_id = r.aluno_id and not coalesce(k.encerrado_operacional,false)
                     and lower(coalesce(k.operador_email,'')) like 'juridico%') then 'JURIDICO'
      when upper(coalesce(r.ac_status,'')) <> 'ATIVO' then 'ACORDO_NAO_ATIVO'
      when r.ac_aluno is distinct from r.aluno_id then 'ACORDO_DE_OUTRO_ALUNO'
      when exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = r.titulo_id and coalesce(v.ativo, true)) then 'TITULO_JA_TEM_VINCULO'
      when exists (select 1 from public.acordos x where x.aluno_id = r.aluno_id and x.criado_em >= c_corte) then 'ACORDO_NOVO'
      when exists (select 1 from public.pagamentos p where p.created_at >= c_corte
                     and (p.aluno_id = r.aluno_id
                          or (r.cpf_limpo is not null and regexp_replace(coalesce(p.cpf,''), '\D', '', 'g') = r.cpf_limpo))) then 'PAGAMENTO_NOVO'
    end;
    if v_motivo is not null then
      v_pul := v_pul || jsonb_build_object('titulo_id', r.titulo_id, 'documento', r.documento, 'acordo', r.acordo_numero, 'motivo', v_motivo);
      continue;
    end if;
    begin
      v_res := public.prime_conferencia_vincular(r.titulo_id, null, c_obs);
      if not coalesce((v_res->>'ok')::boolean, false) or coalesce(v_res->>'decisao','') <> 'VINCULADO'
         or coalesce(v_res->>'estado_titulo','') <> 'vinculada' then
        raise exception 'RESULTADO_INESPERADO %', v_res::text;
      end if;
      v_ok := v_ok || r.titulo_id;
      v_valor := v_valor + r.valor;
    exception when others then
      v_err := v_err || jsonb_build_object('documento', r.documento, 'erro', left(sqlerrm, 160));
    end;
  end loop;

  if jsonb_array_length(v_err) > 0 then
    raise exception 'L2_ERRO: % erro(s) da funcao oficial; primeiros: %', jsonb_array_length(v_err),
      (select jsonb_agg(e) from (select e from jsonb_array_elements(v_err) e limit 2) z)::text;
  end if;
  if cardinality(v_ok) > 50 then
    raise exception 'L2_CONF: mais de 50 titulos na fatia (%)', cardinality(v_ok);
  end if;

  -- 6. conferencias
  select count(*) into v_n from public.acordos_titulos t join _t0 p on p.id = t.id
    join public.prime_conferencia_decisao d on d.titulo_id = t.id
   where t.id = any(v_ok) and t.situacao = 'NEGOCIADO' and t.status = 'vinculada' and t.acordo_id = d.acordo_id
     and d.decisao = 'VINCULADO' and d.decidido_em is not null
     and (select count(*) from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true)) = 1
     and exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and v.acordo_id = d.acordo_id and coalesce(v.ativo, true))
     and (t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado, t.documento, t.vencimento)
         is not distinct from (p.valor_original, p.saldo_corrigido, p.valor_em_aberto, p.valor_cobranca_ajustado, p.documento, p.vencimento);
  if v_n <> cardinality(v_ok) then
    raise exception 'L2_CONF: % de % vinculados fora do esperado (NEGOCIADO, acordo, vinculo unico, decisao)', cardinality(v_ok) - v_n, cardinality(v_ok);
  end if;
  select count(*) into v_n from public.acordos_titulos t join _t0 p on p.id = t.id
   where not (t.id = any(v_ok))
     and (t.situacao, t.status, t.acordo_id, t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado, t.origem_liquidacao)
         is distinct from (p.situacao, p.status, p.acordo_id, p.valor_original, p.saldo_corrigido, p.valor_em_aberto, p.valor_cobranca_ajustado, p.origem_liquidacao);
  if v_n <> 0 then
    raise exception 'L2_CONF: % outros titulos desses alunos mudaram', v_n;
  end if;
  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') <> v_emconf - cardinality(v_ok) then
    raise exception 'L2_CONF: EM_CONFIRMACAO nao caiu exatamente o vinculado';
  end if;
  if (select count(*) from public.acordos) <> v_acordos then raise exception 'L2_CONF: acordo criado'; end if;
  if (select count(*) from public.parcelas) <> v_parcelas then raise exception 'L2_CONF: parcela criada'; end if;
  if (select count(*) from public.pagamentos) <> v_pagamentos then raise exception 'L2_CONF: pagamento criado'; end if;
  if (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) <> v_vinc + cardinality(v_ok) then
    raise exception 'L2_CONF: vinculos ativos nao cresceram exatamente o vinculado';
  end if;
  if exists (select 1 from public.acordo_titulo_vinculo where coalesce(ativo, true) group by titulo_id having count(*) > 1) then
    raise exception 'L2_CONF: titulo com dois vinculos ativos';
  end if;
  if exists (select 1 from public.acordos a join _ac0 p on p.id = a.id
              where (a.status, a.valor_total, a.aluno_id) is distinct from (p.status, p.valor_total, p.aluno_id)) then
    raise exception 'L2_CONF: acordo existente alterado';
  end if;
  if exists (select 1 from _p0 p left join public.parcelas x on x.id = p.id
              where x.id is null or (x.status, x.valor, x.vencimento, x.acordo_id) is distinct from (p.status, p.valor, p.vencimento, p.acordo_id)) then
    raise exception 'L2_CONF: parcela existente alterada';
  end if;
  select count(*) into v_n from public.casos c join _c0 p on p.id = c.id
   where (c.operador_email, c.encerrado_operacional) is distinct from (p.operador_email, p.encerrado_operacional);
  if v_n <> 0 then
    raise exception 'L2_CONF: % casos trocaram operador ou encerraram', v_n;
  end if;
  select count(*) into v_n from public.alunos a join _a0 p on p.id = a.id where a.responsavel_atual_email is distinct from p.responsavel_atual_email;
  if v_n <> 0 then
    raise exception 'L2_CONF: % alunos trocaram/perderam responsavel', v_n;
  end if;
  if (select coalesce(max(id), 0) from public.reposicao_carteira_fila) <> v_fila then
    raise exception 'L2_CONF: reposicao enfileirada';
  end if;

  -- 7. registro
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_LOTE_L2', 'acordos_titulos',
          jsonb_build_object('fatia', 1, 'de', 1, 'universo', (select count(*) from _fatia),
                             'vinculados', cardinality(v_ok), 'valor_vinculado', round(v_valor, 2),
                             'vinculos_criados', (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) - v_vinc,
                             'pulados', v_pul,
                             'autorizacao', 'gestao 18/09/2026: executar somente L1 e L2'));
end;
$l2$;
