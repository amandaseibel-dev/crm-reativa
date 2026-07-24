-- ROLLBACK de 20260724180000_retirar_zerados_reais.sql
-- Restaura caso_encerrado_operacional/redistribuir/nivelar/teto para as versoes
-- anteriores (com fidelizacao, sem SEM_SALDO), remove a funcao de retirada e
-- reverte os casos/alunos marcados como SEM_SALDO_EM_ABERTO de volta a fila
-- ativa. NAO mexe em valores/parcelas (nunca foram alterados). Transacional.

BEGIN;

-- caso_encerrado_operacional (sem SEM SALDO)
CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'public'
AS $function$
declare
  bloq  text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  quit  text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- redistribuir_casos_operadores (versao com fidelizacao, sem checagem de encerrado na soltura)
CREATE OR REPLACE FUNCTION public.redistribuir_casos_operadores(p_executado_por_nome text, p_executado_por_email text, p_meta_por_operador integer DEFAULT 500)
 RETURNS TABLE(operador_email text, operador_nome text, casos_atribuidos integer, valor_total numeric)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_operadores text[]; v_nomes text[]; v_nomes_upper text[]; v_qtd_operadores int;
  totais numeric[]; qtds int[]; caso_rec record; idx int; min_val numeric; min_idx int;
  v_total_distribuido int := 0; v_valor_distribuido numeric := 0;
begin
  if not exists (select 1 from public.usuarios u where lower(u.email)=lower(p_executado_por_email) and u.ativo=true and u.perfil in ('gerencia','administrativo')) then raise exception 'Usuário % não tem permissão para redistribuir a fila operacional.', p_executado_por_email; end if;
  perform pg_advisory_xact_lock(hashtext('redistribuir_casos_operadores'));
  select array_agg(u.email order by u.nome), array_agg(coalesce(u.operador_nome,u.nome) order by u.nome), array_agg(upper(coalesce(u.operador,u.nome)) order by u.nome) into v_operadores, v_nomes, v_nomes_upper from public.usuarios u where u.perfil='operador' and u.ativo=true;
  v_qtd_operadores := coalesce(array_length(v_operadores,1),0);
  if v_qtd_operadores = 0 then raise exception 'Nenhum operador ativo encontrado em usuarios (perfil=operador, ativo=true).'; end if;
  totais := array_fill(0::numeric, array[v_qtd_operadores]); qtds := array_fill(0, array[v_qtd_operadores]);
  insert into public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em)
  select c.chave_unificacao, c.nome, c.cpf, 'REDISTRIBUICAO_AUTOMATICA_SOLTURA', c.operador_nome, c.operador_email, 'Redistribuição executada por '||p_executado_por_nome, now() from public.casos c where c.operador_email = any(v_operadores) and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula);
  update public.casos set operador_email=null, operador_nome=null, operador=null where casos.operador_email = any(v_operadores) and not internal.matricula_em_fidelizacao(casos.aluno_id, casos.matricula);
  for caso_rec in
    with pool as (select c.id, public.saldo_titulos_aberto(c.cpf_limpo) as saldo_orig, c.status_acionamento from public.casos c where c.operador_email is null and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada) and not public.caso_reservado_administrativo(c.chave_unificacao) and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula))
    select pool.id, pool.saldo_orig from pool where pool.saldo_orig > 0 order by (pool.status_acionamento is null) desc, pool.saldo_orig desc nulls last
  loop
    min_idx := null; min_val := null;
    for idx in 1..v_qtd_operadores loop if qtds[idx] < p_meta_por_operador then if min_idx is null or totais[idx] < min_val then min_idx := idx; min_val := totais[idx]; end if; end if; end loop;
    exit when min_idx is null;
    update public.casos set operador_email=v_operadores[min_idx], operador_nome=v_nomes[min_idx], operador=v_nomes_upper[min_idx], caso_atualizado_por=p_executado_por_email, caso_atualizado_em=now() where casos.id = caso_rec.id;
    totais[min_idx] := totais[min_idx] + coalesce(caso_rec.saldo_orig,0); qtds[min_idx] := qtds[min_idx] + 1; v_total_distribuido := v_total_distribuido + 1;
  end loop;
  return query select v_operadores[i], v_nomes[i], qtds[i], totais[i] from generate_series(1, v_qtd_operadores) i order by v_nomes[i];
end; $function$;

-- nivelar_medias_progressivo (versao com fidelizacao, sem encerrado)
CREATE OR REPLACE FUNCTION public.nivelar_medias_progressivo()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_media_alvo numeric; v_op RECORD; v_caso RECORD; v_pool_id uuid; v_margem numeric := 500; v_max_trocas_por_operador int := 5; v_total INT := 0;
BEGIN
  SELECT round(avg(coalesce(total_em_aberto,0))::numeric,2) INTO v_media_alvo FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br';
  IF v_media_alvo IS NULL THEN RETURN 0; END IF;
  FOR v_op IN SELECT operador_email, round(avg(coalesce(total_em_aberto,0))::numeric,2) AS media FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br' GROUP BY operador_email LOOP
    IF v_op.media > v_media_alvo + v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) ORDER BY total_em_aberto DESC NULLS LAST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    ELSIF v_op.media < v_media_alvo - v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_total;
END; $function$;

-- trg_impor_teto_operador (versao com fidelizacao, sem encerrado)
CREATE OR REPLACE FUNCTION public.trg_impor_teto_operador()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_meta int := 500; v_email text := NEW.operador_email; v_qtd_ativa int; v_excedente int; caso_rec record;
BEGIN
  IF v_email IS NULL OR v_email IS NOT DISTINCT FROM OLD.operador_email THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.email = v_email AND u.perfil = 'operador' AND u.ativo = true) THEN RETURN NEW; END IF;
  IF public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) THEN RETURN NEW; END IF;
  SELECT count(*) INTO v_qtd_ativa FROM public.casos c WHERE c.operador_email = v_email AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);
  v_excedente := v_qtd_ativa - v_meta;
  IF v_excedente <= 0 THEN RETURN NEW; END IF;
  FOR caso_rec IN SELECT id, chave_unificacao, nome, cpf FROM public.casos c WHERE c.operador_email = v_email AND c.id <> NEW.id AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula) ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_excedente LOOP
    UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL WHERE id = caso_rec.id;
    INSERT INTO public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em) VALUES (caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'LIBERACAO_AUTOMATICA_TETO_EXCEDIDO', NEW.operador_nome, v_email, 'Teto de ' || v_meta || ' casos excedido após atribuição manual -- liberado automaticamente (menor valor)', now());
  END LOOP;
  RETURN NEW;
END; $function$;

-- Reverte os dados: volta os casos/alunos marcados SEM_SALDO_EM_ABERTO para
-- ativos. Casos usam o status anterior gravado no historico; alunos voltam para
-- EM_ATENDIMENTO (reentram na fila; nova avaliacao re-marcaria se ainda zerado).
UPDATE public.casos c
   SET status_acionamento = COALESCE(
         (SELECT m.status_anterior FROM public.aluno_movimentacoes m
           WHERE m.aluno_id = c.aluno_id::text AND m.tipo = 'ZERADO_REAL_SEM_SALDO'
           ORDER BY m.registrado_em DESC LIMIT 1), NULL),
       caso_atualizado_por = 'rollback_zerado_real', caso_atualizado_em = now()
 WHERE public.normalizar_status_acionamento(c.status_acionamento) = 'SEM SALDO EM ABERTO';

UPDATE public.alunos
   SET status_jornada = 'EM_ATENDIMENTO', status_atual = 'EM_ATENDIMENTO', status_acionamento = 'EM_ATENDIMENTO'
 WHERE public.normalizar_status_acionamento(status_jornada) = 'SEM SALDO EM ABERTO';

-- Restaura avaliar_quitacao_aluno (original: quita quando saldo zero)
CREATE OR REPLACE FUNCTION public.avaliar_quitacao_aluno(p_aluno_id uuid, p_acordo_id uuid DEFAULT NULL::uuid, p_ignorar_confirmacao_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_det jsonb; v_agora timestamptz := now();
begin
  if p_acordo_id is not null then
    if not exists (select 1 from public.parcelas p where p.acordo_id = p_acordo_id and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO'))
       and exists (select 1 from public.parcelas where acordo_id = p_acordo_id) then
      update public.acordos set status = 'QUITADO', saldo = 0, atualizado_em = v_agora where id = p_acordo_id and upper(coalesce(status,'')) <> 'CANCELADO';
      update public.acordos_titulos set status = 'quitada', atualizado_em = v_agora where id in (select titulo_id from public.acordo_titulo_vinculo where acordo_id = p_acordo_id and coalesce(ativo,true));
    end if;
  end if;
  v_det := public.aluno_saldo_pendente_detalhe(p_aluno_id, p_ignorar_confirmacao_id);
  if (v_det ->> 'tem_pendencia')::boolean then
    insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe) values (p_aluno_id, 'BAIXA_PARCELA', (v_det ->> 'total')::numeric, v_det);
    return jsonb_build_object('quitou_aluno', false, 'motivo', 'SALDO_PENDENTE', 'detalhe', v_det);
  end if;
  update public.alunos set status_jornada = 'QUITADO', status_atual = 'QUITADO', status_acionamento = 'QUITADO', valor_em_aberto = 0
   where id = p_aluno_id and coalesce(status_jornada,'') not in ('QUITADO','QUITADO_MANUAL','JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA');
  update public.carteira_operador set status = 'quitado_saiu', saiu_em = v_agora where aluno_id = p_aluno_id::text and status = 'ativo';
  return jsonb_build_object('quitou_aluno', true, 'detalhe', v_det);
end;
$function$;

-- Restaura liberar_caso_por_evento (original, sem hook de reconciliacao)
CREATE OR REPLACE FUNCTION public.liberar_caso_por_evento(p_aluno_id uuid, p_evento text, p_valor_pago numeric DEFAULT NULL::numeric, p_data_pagamento date DEFAULT CURRENT_DATE)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_det jsonb;
begin
  IF p_evento = 'LINK_PAGO' THEN
    v_det := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);
    IF (v_det ->> 'tem_pendencia')::boolean THEN
      insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe) values (p_aluno_id, 'LINK_PAGAMENTO', (v_det ->> 'total')::numeric, v_det);
      RETURN;
    END IF;
    UPDATE public.casos SET status_financeiro = 'QUITADO_LINK_PAGAMENTO', quitado_em = p_data_pagamento, valor_quitado = COALESCE(p_valor_pago, 0), origem_quitacao = 'LINK_PAGAMENTO', caso_atualizado_por = 'sistema_link_pagamento', caso_atualizado_em = now() WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'CANCELADO' THEN
    UPDATE public.casos SET status_acionamento = 'CANCELADO', caso_atualizado_por = 'sistema_cancelamento_acordo', caso_atualizado_em = now() WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'JURIDICO' THEN
    UPDATE public.casos SET status_acionamento = 'JURIDICO', caso_atualizado_por = 'sistema_juridico', caso_atualizado_em = now() WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'ACORDO_MENSALIDADE_LIBERADA' THEN
    UPDATE public.casos SET status_acionamento = 'ACORDO FECHADO', caso_atualizado_por = 'sistema_acordo_fechado', caso_atualizado_em = now() WHERE aluno_id = p_aluno_id;
  END IF;
end;
$function$;

DROP FUNCTION IF EXISTS public.retirar_zerados_reais_sem_saldo(uuid, int);

COMMIT;
