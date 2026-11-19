-- BASELINE: definicoes vigentes de prime_liquidacao_suspender e prime_liquidacao_reavaliar_pendentes,
-- copiadas literalmente de supabase/migrations/20260918230000_prime_liquidacao_regra_entrada.sql
-- (linhas 275-343 e 503-578).
-- Uso: (1) o teste carrega este arquivo e DEVE FALHAR nos casos de autoria humana;
--      (2) e o rollback executavel: reaplicar este arquivo restaura a versao anterior.

create or replace function public.prime_liquidacao_suspender(
  p_titulo_id uuid, p_subgrupo text, p_classificacao text, p_nivel text, p_motivo text,
  p_evidencia jsonb, p_pagamento_id uuid, p_acordo_id uuid, p_quem text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_t record; v_op text; v_num text; v_valor numeric; v_rev boolean;
begin
  select t.*, coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v
    into v_t from public.acordos_titulos t where t.id = p_titulo_id for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'TITULO_NAO_ENCONTRADO'); end if;
  if upper(coalesce(v_t.situacao,'')) not in ('ABERTO','EM_CONFIRMACAO') then
    return jsonb_build_object('ok', false, 'erro', 'NAO_ESTA_ABERTO', 'situacao', v_t.situacao);
  end if;
  v_valor := round(v_t.v, 2);
  v_rev := coalesce((p_evidencia->>'acordo_cancelado_no_historico')::boolean, false)
        or not coalesce((p_evidencia->'prime'->>'cpf_confere')::boolean, true)
        or p_subgrupo = 'C_SEM_PROVA' and p_motivo like 'ACORDO_QUITADO_SEM_PAGAMENTO_REAL%';
  select k.operador_email into v_op from public.casos k
   where k.aluno_id = v_t.aluno_id and not coalesce(k.encerrado_operacional, false)
   order by k.caso_atualizado_em desc nulls last limit 1;
  if p_acordo_id is not null then
    select coalesce(numero_acordo::text,'') into v_num from public.acordos where id = p_acordo_id;
  end if;

  insert into public.prime_conferencia_decisao
    (titulo_id, decisao, motivo, decidido_por, decidido_em, motivo_entrada, aluno_id, cpf, documento, valor,
     evidencia, evidencia_chave, corroboracao, subgrupo, acordo_id, acordo_numero, revisao_obrigatoria,
     operador_no_momento, detectado_em, situacao_anterior, status_anterior)
  values (p_titulo_id, 'PENDENTE', null, null, null, 'PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA', v_t.aluno_id, v_t.cpf,
          v_t.documento, v_valor,
          p_evidencia || jsonb_build_object('classificacao', p_classificacao, 'nivel_evidencia', p_nivel, 'motivo', p_motivo,
                                            'pagamento_id', p_pagamento_id),
          p_evidencia->>'evidencia_chave', 'NENHUMA', p_subgrupo, p_acordo_id, v_num, v_rev,
          v_op, now(), v_t.situacao, v_t.status)
  on conflict (titulo_id) do update
    set decisao = 'PENDENTE', motivo = null, decidido_por = null, decidido_em = null,
        motivo_entrada = excluded.motivo_entrada, aluno_id = excluded.aluno_id, cpf = excluded.cpf,
        documento = excluded.documento, valor = excluded.valor, evidencia = excluded.evidencia,
        evidencia_chave = excluded.evidencia_chave, corroboracao = excluded.corroboracao,
        subgrupo = excluded.subgrupo, acordo_id = excluded.acordo_id, acordo_numero = excluded.acordo_numero,
        revisao_obrigatoria = excluded.revisao_obrigatoria, operador_no_momento = excluded.operador_no_momento,
        detectado_em = excluded.detectado_em, situacao_anterior = excluded.situacao_anterior,
        status_anterior = excluded.status_anterior;

  if upper(coalesce(v_t.situacao,'')) <> 'EM_CONFIRMACAO' then
    perform set_config('conferencia_prime.decisao', 'on', true);
    update public.acordos_titulos set situacao = 'EM_CONFIRMACAO', atualizado_em = now() where id = p_titulo_id;
    perform set_config('conferencia_prime.decisao', 'off', true);

    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email,
       registrado_em, valor_movimentacao)
    values (v_t.aluno_id::text, 'TITULO_EM_CONFIRMACAO_PRIME',
            'Titulo ' || coalesce(v_t.documento,'?') || ' (venc. ' || to_char(v_t.vencimento,'DD/MM/YYYY')
              || ') saiu da cobranca: a Prime liquidou em ' || coalesce(p_evidencia->'prime'->>'liquidado_em','?')
              || ' e a origem nao esta comprovada (' || p_classificacao || '). Nada foi baixado; o valor foi mantido.',
            coalesce(v_t.situacao,'(sem)'), 'EM_CONFIRMACAO', 'Sistema', p_quem, now(), v_valor);
  end if;

  if v_t.aluno_id is not null then
    perform public.recalcular_situacao_aluno(v_t.aluno_id, 'prime_liquidacao_suspensao');
  end if;
  return jsonb_build_object('ok', true, 'titulo_id', p_titulo_id, 'subgrupo', p_subgrupo, 'valor', v_valor);
end;
$function$;

create or replace function public.prime_liquidacao_reavaliar_pendentes(p_quem text default 'prime_liquidacao@rotina')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  d record; v_ev jsonb; v_liq date; v_valor numeric; v_mudou int := 0; v_rev int := 0; v_sug int := 0;
begin
  for d in select x.* from public.prime_conferencia_decisao x
            where x.decisao = 'PENDENTE' and x.subgrupo in ('C_SEM_PROVA','B_ACORDO_COMPROVADO','A_PAGAMENTO_COMPROVADO')
            order by x.detectado_em
  loop
    v_ev := public.prime_liquidacao_evidencias(d.titulo_id);
    if v_ev is null then continue; end if;
    v_liq := (v_ev->'prime'->>'liquidado_em')::date;

    -- (a) reversao explicita: a linha da Prime existe e nao esta mais liquidada
    if (v_ev ? 'prime') and v_liq is null then
      select round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2)
        into v_valor from public.acordos_titulos t where t.id = d.titulo_id;
      perform set_config('conferencia_prime.decisao', 'on', true);
      update public.acordos_titulos set situacao = 'ABERTO', status = 'em_aberto', atualizado_em = now()
       where id = d.titulo_id and upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';
      perform set_config('conferencia_prime.decisao', 'off', true);
      update public.prime_conferencia_decisao
         set decisao = 'REJEITADO', motivo = 'PRIME_REVERTEU_LIQUIDACAO: o boleto voltou a aparecer em aberto na Prime',
             decidido_por = p_quem, decidido_em = now()
       where titulo_id = d.titulo_id;
      insert into public.prime_liquidacao_classificacao
        (titulo_id, aluno_id, documento, evidencia_chave, data_liquidacao_prime, portador, classificacao, nivel_evidencia,
         motivo, evidencia, origem_decisao, decidido_por, resultado_titulo)
      values (d.titulo_id, d.aluno_id, d.documento, v_ev->>'evidencia_chave', null, (v_ev->'prime'->>'portador')::int,
              'PRIME_REVERTEU_LIQUIDACAO', 'NENHUMA', 'a Prime deixou de mostrar o boleto liquidado; o titulo voltou para a cobranca',
              v_ev, 'ROTINA', p_quem, 'ABERTO')
      on conflict do nothing;
      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
      values (d.aluno_id::text, 'TITULO_CONFIRMACAO_REJEITADA',
              'Titulo ' || coalesce(d.documento,'?') || ' voltou para a cobranca: a Prime deixou de mostra-lo liquidado.',
              'EM_CONFIRMACAO', 'ABERTO', 'Sistema', p_quem, now(), v_valor);
      if d.aluno_id is not null then
        perform public.recalcular_situacao_aluno(d.aluno_id, 'prime_liquidacao_reversao');
      end if;
      v_rev := v_rev + 1; v_mudou := v_mudou + 1;
      continue;
    end if;

    -- (b)/(c): a evidencia mudou de nivel -> atualiza a sugestao da fila
    if d.subgrupo = 'C_SEM_PROVA' and (v_ev ? 'acordo_composicao')
       and (v_ev->'acordo_composicao'->>'status' = 'ATIVO'
            or coalesce((v_ev->'acordo_composicao'->'pago_de_verdade'->>'suficiente')::boolean,false)) then
      update public.prime_conferencia_decisao
         set subgrupo = case when v_ev->'acordo_composicao'->>'status' = 'QUITADO' then 'A_PAGAMENTO_COMPROVADO' else 'B_ACORDO_COMPROVADO' end,
             acordo_id = (v_ev->'acordo_composicao'->>'acordo_id')::uuid,
             acordo_numero = v_ev->'acordo_composicao'->>'numero',
             evidencia = v_ev || jsonb_build_object('classificacao',
               case when v_ev->'acordo_composicao'->>'status' = 'QUITADO' then 'PAGAMENTO_COMPROVADO' else 'ACORDO_COMPROVADO' end,
               'nivel_evidencia', case when v_ev->'acordo_composicao'->>'status' = 'QUITADO' then 'FINANCEIRA' else 'DOCUMENTAL' end,
               'motivo', 'reavaliado: surgiu composicao documental de acordo'),
             detectado_em = now()
       where titulo_id = d.titulo_id;
      v_sug := v_sug + 1; v_mudou := v_mudou + 1;
    elsif d.subgrupo = 'C_SEM_PROVA'
          and coalesce(d.evidencia->>'pagamento_candidato_id','') is distinct from coalesce(v_ev->>'pagamento_candidato_id','') then
      update public.prime_conferencia_decisao
         set evidencia = d.evidencia || jsonb_build_object('pagamentos_proximos', v_ev->'pagamentos_proximos',
               'pagamento_candidato_id', v_ev->'pagamento_candidato_id', 'pagamento_candidato_status', v_ev->'pagamento_candidato_status',
               'pagamento_cobre_o_titulo', v_ev->'pagamento_cobre_o_titulo', 'reavaliado_em', now())
       where titulo_id = d.titulo_id;
      v_sug := v_sug + 1; v_mudou := v_mudou + 1;
    end if;
  end loop;
  return jsonb_build_object('mudou', v_mudou, 'revertidas_pela_prime', v_rev, 'sugestao_atualizada', v_sug);
end;
$function$;
