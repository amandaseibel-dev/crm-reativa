-- ROLLBACK de 20260918230000_prime_liquidacao_regra_entrada
--
-- 1. Todo titulo que a REGRA NOVA pos em EM_CONFIRMACAO (subgrupos
--    A_PAGAMENTO_COMPROVADO / B_ACORDO_COMPROVADO / C_SEM_PROVA, decisao
--    PENDENTE) volta para ABERTO/em_aberto. As decisoes PENDENTES da regra
--    nova sao copiadas para a auditoria e apagadas -- eram fila, nao decisao.
--    O historico do grupo A (A1/A2) nao e tocado.
-- 2. Cada funcao alterada volta ao texto de producao de 18/09/2026:
--    prime_conferencia_baixar, prime_conferencia_vincular,
--    prime_conferencia_confirmar, prime_conferencia_fila,
--    conciliacao_liquidar_titulo_por_prime.
-- 3. Sai o que a migration criou: cron, etapa de config, funcoes novas.
-- FICA (registro, inofensivo): prime_liquidacao_classificacao e
-- prime_liquidacao_regra (deny-all), e o CHECK de subgrupo aceitando os
-- tres valores novos.

begin;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'prime_liquidacao_classificar_hora';
  end if;
  if to_regclass('public.fluxo_pagamentos_config') is not null then
    delete from public.fluxo_pagamentos_config where etapa = 'prime_liquidacao_classificar';
  end if;
end
$cron$;

create temp table _rb_novas on commit drop as
select d.titulo_id, d.aluno_id, d.documento, d.valor, d.subgrupo, d.evidencia
  from public.prime_conferencia_decisao d
 where d.decisao = 'PENDENTE' and d.subgrupo in ('A_PAGAMENTO_COMPROVADO','B_ACORDO_COMPROVADO','C_SEM_PROVA');

insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
select 'sistema', 'ROLLBACK_PRIME_LIQUIDACAO_REGRA_ENTRADA', 'acordos_titulos',
       jsonb_build_object('titulos_devolvidos_a_cobranca', (select coalesce(jsonb_agg(titulo_id), '[]'::jsonb) from _rb_novas),
                          'decisoes_pendentes_apagadas', (select coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) from _rb_novas n));

select set_config('conferencia_prime.decisao', 'on', true);
update public.acordos_titulos t
   set situacao = 'ABERTO', status = 'em_aberto', atualizado_em = now()
  from _rb_novas n
 where t.id = n.titulo_id and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO';
select set_config('conferencia_prime.decisao', 'off', true);

delete from public.prime_conferencia_decisao d where d.titulo_id in (select titulo_id from _rb_novas);

select public.recalcular_situacao_aluno(x.aluno_id, 'rollback_regra_entrada')
  from (select distinct aluno_id from _rb_novas where aluno_id is not null) x;

drop function if exists public.prime_liquidacao_classificar_novas(int, boolean);
drop function if exists public.prime_liquidacao_reavaliar_pendentes(text);
drop function if exists public.prime_liquidacao_suspender(uuid, text, text, text, text, jsonb, uuid, uuid, text);
drop function if exists public.prime_conferencia_seguir_pagamento(uuid, uuid, text);
drop function if exists public.prime_liquidacao_painel();
drop function if exists public.prime_liquidacao_evidencias(uuid);
drop function if exists public.prime_liquidacao_acordo_pago_de_verdade(uuid);
drop function if exists public.prime_liquidacao_chave(text, date, int);
drop index if exists public.ix_prime_extrato_boleto_ltrim;

-- ===== texto de producao de 18/09/2026 (pg_get_functiondef) =================

CREATE OR REPLACE FUNCTION public.prime_conferencia_confirmar(p_titulo_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sub text;
begin
  -- A2 que o acordo cobre confirma por VINCULO (a divida fica so nas parcelas
  -- do acordo); o resto confirma pela baixa oficial, que reconfere a evidencia.
  select subgrupo into v_sub from public.prime_conferencia_decisao
   where titulo_id = p_titulo_id and decisao = 'PENDENTE';
  if v_sub = 'A2_COBRE' then
    return public.prime_conferencia_vincular(p_titulo_id, null, p_observacao) || jsonb_build_object('ok', true);
  end if;
  return coalesce(public.prime_conferencia_baixar(p_titulo_id, p_observacao), '{}'::jsonb) || jsonb_build_object('ok', true);
end;
$function$;

drop function if exists public.prime_conferencia_fila();
CREATE FUNCTION public.prime_conferencia_fila()
 RETURNS TABLE(titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text, vencimento date, valor numeric, liquidado_em date, portador integer, corroboracao text, subgrupo text, acordo_id uuid, acordo_numero text, acordo_status text, razao numeric, revisao_obrigatoria boolean, operador_responsavel text, outras_dividas boolean, detectado_em timestamp with time zone, evidencia jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;
  return query
  select d.titulo_id, d.aluno_id, al.nome, d.cpf, d.documento, t.vencimento, d.valor,
         (d.evidencia->>'liquidado_em')::date, (d.evidencia->>'portador')::int,
         d.corroboracao, d.subgrupo, d.acordo_id, d.acordo_numero, ac.status,
         (d.evidencia->>'razao_acordo_lote')::numeric, d.revisao_obrigatoria,
         al.responsavel_atual_email,
         not public.caso_aguarda_confirmacao_financeira(d.aluno_id),
         d.detectado_em, d.evidencia
    from public.prime_conferencia_decisao d
    join public.acordos_titulos t on t.id = d.titulo_id
    left join public.alunos al on al.id = d.aluno_id
    left join public.acordos ac on ac.id = d.acordo_id
   where d.decisao = 'PENDENTE'
   order by (coalesce(d.subgrupo,'') like 'A2%') desc, d.valor desc, d.titulo_id;
end;
$function$;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prime_conferencia_vincular(p_titulo_id uuid, p_acordo_id uuid DEFAULT NULL::uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs    text := nullif(btrim(coalesce(p_observacao,'')), '');
  v_titulo public.acordos_titulos%rowtype;
  v_dec    public.prime_conferencia_decisao%rowtype;
  v_acordo uuid;
  v_num    text;
  v_res    jsonb;
begin
  if not (public.crm_usuario_pode_quitar_baixar() or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'SEM_PERMISSAO: seu usuário não pode vincular título a acordo por aqui.';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;
  if upper(coalesce(v_titulo.situacao,'')) <> 'EM_CONFIRMACAO' then
    raise exception 'NAO_ESTA_EM_CONFIRMACAO: so se vincula por aqui titulo que a Conferencia Prime colocou em confirmacao.';
  end if;

  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE';
  end if;
  -- So o A2 que o acordo cobre vincula direto ao acordo da deteccao. Qualquer
  -- outro (A2 inconclusivo, A2 que nao cobre, A1 que ganhou acordo depois)
  -- so com o acordo escolhido por gente e motivo escrito.
  v_acordo := coalesce(p_acordo_id, v_dec.acordo_id);
  if coalesce(v_dec.subgrupo,'') <> 'A2_COBRE' and (p_acordo_id is null or length(coalesce(v_obs,'')) < 10) then
    raise exception 'ESCOLHA_O_ACORDO_E_O_MOTIVO: titulo % exige o acordo escolhido e motivo explicito (minimo 10 caracteres).', coalesce(v_dec.subgrupo,'?');
  end if;
  if v_dec.revisao_obrigatoria and length(coalesce(v_obs,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: aluno com acordo cancelado no historico -- escreva o motivo da decisao (minimo 10 caracteres).';
  end if;
  if v_acordo is null then
    raise exception 'ACORDO_NAO_INFORMADO';
  end if;
  select coalesce(numero_acordo::text,'') into v_num
    from public.acordos where id = v_acordo and aluno_id = v_titulo.aluno_id;
  if not found then
    raise exception 'ACORDO_DE_OUTRO_ALUNO: o acordo informado nao e deste aluno.';
  end if;

  perform set_config('conferencia_prime.decisao', 'on', true);
  v_res := public.vincular_titulos_acordo(array[p_titulo_id], v_acordo);
  perform set_config('conferencia_prime.decisao', 'off', true);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'VINCULO_FALHOU: %', v_res::text;
  end if;

  update public.prime_conferencia_decisao
     set decisao = 'VINCULADO', motivo = v_obs, decidido_por = nullif(v_email,''),
         decidido_em = now(), acordo_id = v_acordo, acordo_numero = v_num
   where titulo_id = p_titulo_id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (v_titulo.aluno_id::text, 'TITULO_VINCULADO_CONFERENCIA_PRIME',
          'Titulo ' || coalesce(v_titulo.documento,'?') || ' vinculado ao acordo ' || v_num
            || ' pela Conferencia Prime: a divida fica so nas parcelas do acordo.'
            || coalesce(' ' || v_obs, ''),
          'EM_CONFIRMACAO', upper(coalesce(v_res->>'estado_titulo','')), v_email, v_email, now(),
          coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido, v_titulo.valor_em_aberto, v_titulo.valor_original, 0));

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_VINCULO', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('acordo_id', v_acordo, 'acordo_numero', v_num, 'subgrupo', v_dec.subgrupo,
                             'observacao', v_obs, 'evidencia', v_dec.evidencia, 'resultado', v_res));

  perform public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_vinculo');
  return v_res || jsonb_build_object('decisao', 'VINCULADO', 'acordo_numero', v_num);
end;
$function$;

CREATE OR REPLACE FUNCTION public.prime_conferencia_baixar(p_titulo_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs       text := nullif(btrim(coalesce(p_observacao,'')), '');
  v_titulo    public.acordos_titulos%rowtype;
  v_dec       public.prime_conferencia_decisao%rowtype;
  v_ev        record;
  v_valor     numeric;
  v_bloqueio  text;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'SEM_PERMISSAO: seu usuário não pode dar baixa em título.';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;

  if upper(coalesce(v_titulo.situacao,'')) = 'PAGO' then
    return jsonb_build_object('ja_processado', true, 'status', v_titulo.status, 'situacao', v_titulo.situacao);
  end if;

  -- Premissa 6: so baixa o que a deteccao do grupo A pos em confirmacao e que
  -- ainda espera decisao humana. Nunca mais a data crua da Prime.
  if upper(coalesce(v_titulo.situacao,'')) <> 'EM_CONFIRMACAO' then
    raise exception 'NAO_ESTA_EM_CONFIRMACAO: so se baixa por aqui titulo que a Conferencia Prime colocou em confirmacao.';
  end if;

  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE';
  end if;

  if v_dec.subgrupo = 'A2_COBRE' then
    raise exception 'USE_O_VINCULO: o acordo % cobre este titulo -- confirme pelo vinculo ao acordo, nao por baixa.', coalesce(v_dec.acordo_numero,'?');
  end if;
  if (v_dec.revisao_obrigatoria or v_dec.subgrupo in ('A2_NAO_COBRE','A2_INCONCLUSIVO'))
     and length(coalesce(v_obs,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: este titulo exige revisao humana -- escreva o motivo da decisao (minimo 10 caracteres).';
  end if;

  select case
           when upper(coalesce(a.status_jornada,''))     in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_jornada)
           when upper(coalesce(a.status_atual,''))       in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_atual)
           when upper(coalesce(a.status_acionamento,'')) in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_acionamento)
         end
    into v_bloqueio
  from public.alunos a where a.id = v_titulo.aluno_id;

  if v_bloqueio is not null then
    raise exception 'COBRANCA_NAO_COMUM: aluno está como % -- fora do escopo desta conferência.', v_bloqueio;
  end if;

  -- A evidencia e conferida DE NOVO, agora -- nao vale a da deteccao.
  select * into v_ev from public.prime_grupo_a_candidatos(array[p_titulo_id]) limit 1;
  if not found then
    raise exception 'EVIDENCIA_NAO_CONFIRMA: a liquidacao deste titulo nao se sustenta mais na Prime -- rejeite para voltar a cobrar.';
  end if;
  if v_ev.subgrupo = 'A2_COBRE' and v_dec.subgrupo <> 'A2_COBRE' then
    raise exception 'CLASSIFICACAO_MUDOU: hoje o acordo % cobre este titulo -- vincule ao acordo em vez de baixar.', coalesce(v_ev.acordo_numero,'?');
  end if;

  v_valor := round(coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido,
                            v_titulo.valor_em_aberto, v_titulo.valor_original, 0), 2);

  perform set_config('conferencia_prime.decisao', 'on', true);
  update public.acordos_titulos
     set situacao = 'PAGO', status = 'quitada',
         origem_liquidacao     = 'PRIME_LIQUIDACAO_OFICIAL',
         origem_liquidacao_ref = 'conferencia_prime:' || p_titulo_id::text,
         origem_liquidacao_em  = now(),
         motivo_ajuste = coalesce(motivo_ajuste,'')
           || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
           || 'baixado pela Conferencia Prime: liquidado na Prime em ' || to_char(v_ev.liquidado_em, 'DD/MM/YYYY')
           || ', corroborado por ' || v_ev.corroboracao || '; decisao de ' || coalesce(nullif(v_email,''), 'sistema'),
         atualizado_em = now()
   where id = p_titulo_id;
  perform set_config('conferencia_prime.decisao', 'off', true);

  update public.prime_conferencia_decisao
     set decisao = 'CONFIRMADO', motivo = v_obs, decidido_por = nullif(v_email,''), decidido_em = now(),
         evidencia = coalesce(evidencia, '{}'::jsonb) || jsonb_build_object('reconferida_na_decisao', v_ev.evidencia)
   where titulo_id = p_titulo_id;

  if v_titulo.aluno_id is not null then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_titulo.aluno_id::text,
      'BAIXA_CONFERENCIA_PRIME',
      concat_ws(' ',
        'Titulo', btrim(coalesce(v_titulo.documento,'')),
        'venc.', to_char(v_titulo.vencimento, 'DD/MM/YYYY'),
        'baixado por conferencia com a Prime (liquidado em',
        to_char(v_ev.liquidado_em, 'DD/MM/YYYY') || ', corroborado por ' || v_ev.corroboracao || ').',
        v_obs
      ),
      'EM_CONFIRMACAO', 'PAGO', v_email, now(), v_valor
    );
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_BAIXA', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('documento', v_titulo.documento, 'valor', v_valor, 'subgrupo', v_dec.subgrupo,
                             'observacao', v_obs, 'evidencia_deteccao', v_dec.evidencia,
                             'evidencia_decisao', v_ev.evidencia));

  if v_titulo.aluno_id is not null then
    perform public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_baixa');
  end if;

  return jsonb_build_object('ja_processado', false, 'titulo_id', p_titulo_id, 'decisao', 'CONFIRMADO',
                            'valor_baixado', v_valor, 'liquidado_em', v_ev.liquidado_em);
end;
$function$;

CREATE OR REPLACE FUNCTION public.conciliacao_liquidar_titulo_por_prime(p_pagamento_id uuid, p_titulos jsonb, p_aplicar boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pag record; v_t record; v_item jsonb;
  v_boleto text; v_pago date;
  v_liquidados jsonb := '[]'::jsonb; v_recusados jsonb := '[]'::jsonb;
  v_n int := 0; v_soma numeric := 0; v_motivo text;
  -- o que a ESCRITA fez -- nunca o que a leitura previu
  v_rows int := 0; v_escrito numeric;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Liquidar titulo pela Prime e da gestao ou da rotina.' using errcode = '42501';
  end if;

  select p.id, p.aluno_id, p.status_conciliacao, p.titulo_numero, p.data_pagamento
    into v_pag
    from public.pagamentos p where p.id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO');
  end if;

  -- Ja resolvido: idempotente, e sem reescrever nada.
  if coalesce(v_pag.status_conciliacao,'') = 'TITULO_ORIGINAL_LIQUIDADO' then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'ja_resolvido', true, 'liquidados', 0);
  end if;

  -- IDENTIDADE PRIMEIRO. Sem aluno resolvido nao ha a quem pertencer o titulo,
  -- e fechar divida no aluno errado e pior do que nao fechar.
  if v_pag.aluno_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_ALUNO_VINCULADO',
      'detalhe', 'a identidade precisa ser resolvida antes de concluir titulo');
  end if;

  -- So age sobre pendencia de acordo. Pagamento ja baixado, em revisao ou sem
  -- vinculo tem outro caminho, e nao e este.
  if coalesce(v_pag.status_conciliacao,'') not in ('AGUARDANDO_ACORDO','ACORDO_CONFIRMADO_SEM_ESTRUTURA') then
    return jsonb_build_object('ok', false, 'motivo', 'ESTADO_NAO_ELEGIVEL',
      'status_conciliacao', v_pag.status_conciliacao);
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_titulos,'[]'::jsonb))
  loop
    v_boleto := nullif(ltrim(regexp_replace(coalesce(v_item->>'boleto',''), '\D', '', 'g'), '0'), '');
    begin
      v_pago := (v_item->>'pago_em')::date;
    exception when others then
      v_pago := null;
    end;

    if coalesce((v_item->>'portador')::int, 0) <> 195 then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_item->>'boleto', 'porque', 'PORTADOR_NAO_E_195');
      continue;
    end if;
    if v_boleto is null or v_pago is null then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_item->>'boleto', 'porque', 'SEM_BOLETO_OU_SEM_DATA');
      continue;
    end if;

    select t.id, t.documento, t.vencimento, t.created_at, t.situacao, t.status,
           t.acordo_id, t.origem_liquidacao,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as saldo
      into v_t
      from public.acordos_titulos t
     where nullif(ltrim(regexp_replace(coalesce(t.documento,''), '\D', '', 'g'), '0'), '') = v_boleto
       and t.aluno_id = v_pag.aluno_id;

    if not found then
      -- Pode ser titulo que nunca veio por bordero. NAO se cria titulo aqui:
      -- o CRM cobra o que recebeu, e inventar linha inflaria a carteira.
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'NAO_EXISTE_NO_CRM_PARA_ESTE_ALUNO');
      continue;
    end if;
    if coalesce(v_t.origem_liquidacao,'') = 'PRIME_LIQUIDACAO_OFICIAL' then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'JA_LIQUIDADO');
      continue;
    end if;
    if coalesce(v_t.situacao,'') <> 'ABERTO' or coalesce(v_t.status,'') <> 'em_aberto' then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'NAO_ESTA_ABERTO',
                                     'situacao', v_t.situacao, 'status', v_t.status);
      continue;
    end if;
    if v_t.acordo_id is not null
       or exists (select 1 from public.acordo_titulo_vinculo v
                   where v.titulo_id = v_t.id and coalesce(v.ativo, true)) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'JA_NEGOCIADO_NO_CRM');
      continue;
    end if;
    if not (v_pago > v_t.vencimento + 30) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PAGAMENTO_DENTRO_DE_30_DIAS_DO_VENCIMENTO');
      continue;
    end if;
    if not (v_pago >= v_t.created_at::date) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PAGAMENTO_ANTERIOR_A_IMPORTACAO');
      continue;
    end if;

    if not p_aplicar then
      -- PREVIA: nada e escrito, entao o que se reporta e o que PASSARIA nas
      -- travas agora. Nao promete a corrida -- so a leitura.
      v_n := v_n + 1;
      v_soma := v_soma + v_t.saldo;
      v_liquidados := v_liquidados || jsonb_build_object('boleto', v_boleto, 'titulo_id', v_t.id,
                        'vencimento', v_t.vencimento, 'pago_em', v_pago, 'saldo', v_t.saldo);
      continue;
    end if;

    -- AQUISICAO ATOMICA. As checagens acima foram feitas com a foto de antes;
    -- entre elas e esta escrita outra execucao pode ter levado o mesmo titulo.
    -- Entao a elegibilidade INTEIRA vai no WHERE do proprio UPDATE: em READ
    -- COMMITTED, duas transacoes que disputam a linha serializam, e a segunda
    -- reavalia o predicado contra a linha ja escrita -- encontra
    -- `origem_liquidacao` preenchida e afeta zero linhas. Compare-and-swap,
    -- sem lock explicito.
    --
    -- E o que conta e o que a ESCRITA fez, nao o que a leitura previu: `v_n`,
    -- `v_soma` e o estado do pagamento so avancam com linha realmente alterada.
    update public.acordos_titulos t
       set situacao = 'PAGO',
           status   = 'quitada',
           -- acordo_id continua NULL de proposito: nao ha acordo no CRM, e
           -- criar um so para ter onde apontar seria inventar estrutura.
           origem_liquidacao     = 'PRIME_LIQUIDACAO_OFICIAL',
           origem_liquidacao_ref = p_pagamento_id::text,
           origem_liquidacao_em  = now(),
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'liquidada na origem: a Prime registra o documento ' || v_boleto
             || ' pago em ' || to_char(v_pago,'DD/MM/YYYY') || ' no portador 195'
             || ', e o Santander pagou o acordo ' || coalesce(nullif(v_pag.titulo_numero,''),'(sem numero)')
             || ' em ' || coalesce(to_char(v_pag.data_pagamento,'DD/MM/YYYY'),'?')
             || '. Nenhum acordo ou parcela foi criado a partir disso.',
           atualizado_em = now()
     where t.id = v_t.id
       and t.aluno_id = v_pag.aluno_id
       and t.origem_liquidacao is null
       and coalesce(t.situacao,'') = 'ABERTO'
       and coalesce(t.status,'')   = 'em_aberto'
       and t.acordo_id is null
       and not exists (select 1 from public.acordo_titulo_vinculo v
                        where v.titulo_id = t.id and coalesce(v.ativo, true))
    returning coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)
      into v_escrito;
    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      -- Perdeu a corrida, ou a linha deixou de ser elegivel entre a leitura e a
      -- escrita. Nao e erro: e o caso em que NAO se conta.
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PERDEU_A_CORRIDA');
      continue;
    end if;

    v_n := v_n + 1;
    v_soma := v_soma + coalesce(v_escrito, 0);
    v_liquidados := v_liquidados || jsonb_build_object('boleto', v_boleto, 'titulo_id', v_t.id,
                      'vencimento', v_t.vencimento, 'pago_em', v_pago, 'saldo', v_escrito);
  end loop;

  if v_n = 0 then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id, 'aplicou', false,
      'liquidados', 0, 'recusados', v_recusados,
      'motivo', 'nenhum titulo passou nas travas -- o pagamento segue como estava');
  end if;

  v_motivo := 'titulo original concluido pela liquidacao oficial na Prime: ' || v_n
    || ' documento(s) do portador 195 fecharam, somando R$ '
    || to_char(v_soma, 'FM999G999G990D00')
    || ' que saem do saldo em aberto. Nenhum acordo ou parcela foi criado, e nenhuma'
    || ' parcela foi baixada -- o caixa continua sendo o do pagamento Santander.';

  if p_aplicar then
    update public.pagamentos
       set status_conciliacao = 'TITULO_ORIGINAL_LIQUIDADO',
           conciliacao_motivo = v_motivo,
           conciliacao_em     = now()
     where id = p_pagamento_id;

    -- `decisao` tem CHECK proprio e nao aceita estado novo: o vocabulario dela
    -- e VINCULADO/DESCARTADO/AGUARDANDO_TERCEIRO/RESOLVIDO_AUTOMATICO/
    -- ENCERRADO_GESTAO. O desfecho especifico mora em `status_conciliacao`,
    -- exatamente como o motor ja faz com BAIXADO.
    update public.fila_pagamento_sem_vinculo
       set decisao = 'RESOLVIDO_AUTOMATICO',
           decidido_por = 'conciliacao@sistema',
           decidido_em = now(),
           status_conciliacao = 'TITULO_ORIGINAL_LIQUIDADO',
           observacao = coalesce(observacao,'')
             || case when coalesce(observacao,'') = '' then '' else ' | ' end
             || 'titulo original concluido pela liquidacao oficial na Prime'
     where pagamento_id = p_pagamento_id and decisao is null;
  end if;

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id, 'aplicou', p_aplicar,
    'status', 'TITULO_ORIGINAL_LIQUIDADO', 'liquidados', v_n,
    'saldo_que_sai', v_soma, 'titulos', v_liquidados, 'recusados', v_recusados,
    'motivo', v_motivo);
end;
$function$;

commit;
