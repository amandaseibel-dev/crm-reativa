-- Retirada efetiva dos zerados reais da fila ativa (status SEM_SALDO_EM_ABERTO).
--
-- Depende de 20260724170000_saldo_operacional_zerado_real.sql (predicado
-- caso_saldo_zerado_real / caso_saldo_operacional).
--
-- Nao existe status previo nao-pago equivalente a "sem saldo" (os finalizados
-- eram QUITADO/QUITADO_MANUAL/AGUARDANDO_BAIXA/BAIXA_REALIZADA, todos implicam
-- pagamento/baixa). Introduzimos SEM_SALDO_EM_ABERTO como status final SEM
-- pagamento. NAO quita, NAO baixa, NAO altera parcelas, NAO apaga.
--
-- Total financeiro considera SOMENTE mensalidades em aberto + parcelas de
-- acordo em aberto (aluno_saldo_pendente_detalhe.total ja NAO soma confirmacoes;
-- confirmacao/baixa pendente sao apenas BLOQUEIO para nao finalizar como zerado).
--
-- Transacional e reversivel (ver *_down.sql). Idempotente.

BEGIN;

-- 1) caso_encerrado_operacional passa a reconhecer SEM SALDO EM ABERTO como
--    encerrado operacional (exclui de redistribuicao/faixas/pool/acoes massivas).
CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'public'
AS $function$
declare
  bloq  text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  quit  text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','SEM SALDO EM ABERTO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  -- SEM SALDO EM ABERTO encerra operacionalmente independentemente de saldo de
  -- titulos (o saldo ja foi avaliado como zero pela fonte unica ao marcar).
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- 2) Redistribuicao geral: nao solta casos encerrados (inclui SEM_SALDO).
--    (mantem a guarda de fidelizacao ja existente)
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
  select c.chave_unificacao, c.nome, c.cpf, 'REDISTRIBUICAO_AUTOMATICA_SOLTURA', c.operador_nome, c.operador_email, 'Redistribuição executada por '||p_executado_por_nome, now()
  from public.casos c where c.operador_email = any(v_operadores)
    and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);
  update public.casos set operador_email=null, operador_nome=null, operador=null
  where casos.operador_email = any(v_operadores)
    and not internal.matricula_em_fidelizacao(casos.aluno_id, casos.matricula)
    and not public.caso_encerrado_operacional(casos.cpf_limpo, casos.status_atual, casos.status_acionamento, casos.status_financeiro, casos.status_jornada);
  for caso_rec in
    with pool as (select c.id, public.saldo_titulos_aberto(c.cpf_limpo) as saldo_orig, c.status_acionamento from public.casos c where c.operador_email is null and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada) and not public.caso_reservado_administrativo(c.chave_unificacao) and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula))
    select pool.id, pool.saldo_orig from pool where pool.saldo_orig > 0 order by (pool.status_acionamento is null) desc, pool.saldo_orig desc nulls last
  loop
    min_idx := null; min_val := null;
    for idx in 1..v_qtd_operadores loop if qtds[idx] < p_meta_por_operador then if min_idx is null or totais[idx] < min_val then min_idx := idx; min_val := totais[idx]; end if; end if; end loop;
    exit when min_idx is null;
    update public.casos set operador_email=v_operadores[min_idx], operador_nome=v_nomes[min_idx], operador=v_nomes_upper[min_idx], caso_atualizado_por=p_executado_por_email, caso_atualizado_em=now() where casos.id = caso_rec.id;
    totais[min_idx] := totais[min_idx] + coalesce(caso_rec.saldo_orig,0); qtds[min_idx] := qtds[min_idx] + 1; v_total_distribuido := v_total_distribuido + 1; v_valor_distribuido := v_valor_distribuido + coalesce(caso_rec.saldo_orig,0);
  end loop;
  insert into public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
  select c.chave_unificacao, c.nome, c.cpf, 'REDISTRIBUICAO_AUTOMATICA_ENTRADA', c.operador_nome, c.operador_email, 'Redistribuição executada por '||p_executado_por_nome, now() from public.casos c where c.caso_atualizado_por = p_executado_por_email and c.caso_atualizado_em >= now() - interval '1 minute';
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes, created_at) values (p_executado_por_email, 'REDISTRIBUIU_CASOS', 'casos', jsonb_build_object('executado_por_nome',p_executado_por_nome,'meta_por_operador',p_meta_por_operador,'total_casos_distribuidos',v_total_distribuido,'valor_total_distribuido',v_valor_distribuido,'operadores',v_operadores), now());
  return query select v_operadores[i], v_nomes[i], qtds[i], totais[i] from generate_series(1, v_qtd_operadores) i order by v_nomes[i];
end; $function$;

-- 3) Nivelamento: exclui casos encerrados (inclui SEM_SALDO) da soltura e da pool.
CREATE OR REPLACE FUNCTION public.nivelar_medias_progressivo()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_media_alvo numeric; v_op RECORD; v_caso RECORD; v_pool_id uuid;
  v_margem numeric := 500; v_max_trocas_por_operador int := 5; v_total INT := 0;
BEGIN
  SELECT round(avg(coalesce(total_em_aberto,0))::numeric,2) INTO v_media_alvo FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br';
  IF v_media_alvo IS NULL THEN RETURN 0; END IF;
  FOR v_op IN SELECT operador_email, round(avg(coalesce(total_em_aberto,0))::numeric,2) AS media FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br' GROUP BY operador_email LOOP
    IF v_op.media > v_media_alvo + v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto DESC NULLS LAST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    ELSIF v_op.media < v_media_alvo - v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
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

-- 4) Teto: nao conta nem libera casos encerrados (inclui SEM_SALDO).
CREATE OR REPLACE FUNCTION public.trg_impor_teto_operador()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_meta int := 500; v_email text := NEW.operador_email; v_qtd_ativa int; v_excedente int; caso_rec record;
BEGIN
  IF v_email IS NULL OR v_email IS NOT DISTINCT FROM OLD.operador_email THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.email = v_email AND u.perfil = 'operador' AND u.ativo = true) THEN RETURN NEW; END IF;
  IF public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) THEN RETURN NEW; END IF;
  SELECT count(*) INTO v_qtd_ativa FROM public.casos c WHERE c.operador_email = v_email
    AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);
  v_excedente := v_qtd_ativa - v_meta;
  IF v_excedente <= 0 THEN RETURN NEW; END IF;
  FOR caso_rec IN SELECT id, chave_unificacao, nome, cpf FROM public.casos c WHERE c.operador_email = v_email AND c.id <> NEW.id
      AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
      AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
      AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
      ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_excedente LOOP
    UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL WHERE id = caso_rec.id;
    INSERT INTO public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em) VALUES (caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'LIBERACAO_AUTOMATICA_TETO_EXCEDIDO', NEW.operador_nome, v_email, 'Teto de ' || v_meta || ' casos excedido após atribuição manual -- liberado automaticamente (menor valor)', now());
  END LOOP;
  RETURN NEW;
END; $function$;

-- 5) Retirada dos zerados reais: marca SEM_SALDO_EM_ABERTO, preserva responsavel,
--    matricula e historico; NAO quita, NAO baixa, NAO altera parcelas, NAO apaga.
--    Aplica-se aos casos atuais e (via agendamento/chamada) aos novos.
CREATE OR REPLACE FUNCTION public.retirar_zerados_reais_sem_saldo(p_limite int DEFAULT NULL)
RETURNS TABLE(caso_id uuid, aluno_id uuid, matricula text, status_anterior text, status_novo text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare r record; v_novo text := 'SEM_SALDO_EM_ABERTO'; v_n int := 0;
begin
  for r in
    select c.id, c.aluno_id, c.matricula, c.status_acionamento AS st_ant,
           internal.resolver_aluno_por_matricula(c.aluno_id, c.matricula) AS aid
    from public.casos c
    where c.operador_email is not null
      and c.quitado_em is null
      and coalesce(c.status_acionamento,'') not ilike '%CANCEL%'
      and coalesce(c.status_acionamento,'') not ilike '%JURIDIC%'
      and public.normalizar_status_acionamento(c.status_acionamento) <> 'SEM SALDO EM ABERTO'
      and public.caso_saldo_zerado_real(c.aluno_id, c.matricula)  -- so zerado real, com vinculo seguro
  loop
    exit when p_limite is not null and v_n >= p_limite;

    -- Caso: status operacional final (encerra p/ distribuicao/teto/nivelamento).
    update public.casos
       set status_acionamento = v_novo,
           caso_atualizado_por = 'sistema_zerado_real', caso_atualizado_em = now()
     where id = r.id;

    -- Aluno: sai da fila ativa (mantendo responsavel). NAO mexe em valores.
    if r.aid is not null then
      update public.alunos
         set status_jornada = v_novo, status_atual = v_novo, status_acionamento = v_novo,
             registrado_por_email = 'sistema_zerado_real', registrado_em = now()
       where id = r.aid;
    end if;

    -- Historico (aluno_movimentacoes): origem ZERADO_REAL_SEM_SALDO, anterior/novo.
    insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values (coalesce(r.aid, r.aluno_id)::text, 'ZERADO_REAL_SEM_SALDO',
            'Sem saldo em aberto (fonte unica): retirado da fila ativa. Matricula '||coalesce(r.matricula,'-')||'. Sem baixa/quitacao.',
            coalesce(r.st_ant,'(sem)'), v_novo, 'Sistema', 'sistema_zerado_real', now());

    -- Historico (historico_operadores_alunos): preserva responsavel atual do caso.
    insert into public.historico_operadores_alunos (aluno_id, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
    select r.aid, c.nome, c.cpf, 'ZERADO_REAL_SEM_SALDO', c.operador_nome, c.operador_email,
           'Retirado da fila por saldo zero real. Responsavel preservado.', now()
    from public.casos c where c.id = r.id;

    caso_id := r.id; aluno_id := r.aid; matricula := r.matricula; status_anterior := coalesce(r.st_ant,'(sem)'); status_novo := v_novo;
    v_n := v_n + 1;
    return next;
  end loop;
end;
$function$;

-- Backfill inicial (aplica aos casos atuais). Descomente para rodar na aplicacao:
-- SELECT count(*) FROM public.retirar_zerados_reais_sem_saldo();

COMMIT;
