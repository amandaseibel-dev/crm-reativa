-- ============================================================================
-- Proteger o prazo de fidelizacao (10 dias) nos caminhos que sobraram:
-- teto de 500 casos e as RPCs antigas de redistribuicao.
--
-- REGRA (Amanda, 24/08/2026): quem esta DENTRO do prazo de 10 dias contados do
-- ultimo acionamento NAO pode ser retirado do operador -- por nenhum caminho.
-- A migration 20260824210000 fechou o nivelamento/calibragem. Auditando o
-- restante do banco sobraram QUATRO caminhos que tiram o caso do operador e
-- nunca olharam a janela dos 10 dias:
--
--   1. trg_impor_teto_operador (TRIGGER VIVO em public.casos) -- FURO REAL:
--      quando o operador passa de 500 casos ativos, solta o excedente pelos
--      de menor valor. Olhava caso_protegido_redistribuicao e
--      internal.matricula_em_fidelizacao, mas essa ultima ancora em
--      alunos.responsavel_atual_em (regra ANTIGA, de antes de 03/08/2026) e
--      nao em data_ultimo_acionamento -- entao um caso acionado ontem, cujo
--      vinculo com o operador e antigo, era solto. Nos ultimos 45 dias houve
--      720 soltura por teto, das quais ~318 estavam dentro dos 10 dias.
--   2. reforcar_teto_operadores -- mesma logica do teto, sem cron e sem uso no
--      front, mas ainda com EXECUTE para authenticated e SEM nenhum guard
--      (nem protegido, nem fidelizacao). Ganha os guards e perde o grant,
--      alinhando com o congelamento de 20260730220000.
--   3. redistribuir_casos_operadores / _faixas -- congeladas (sem EXECUTE para
--      authenticated/anon, sem cron), mas se forem descongeladas soltam a
--      carteira inteira sem olhar a janela. Guard adicionado agora.
--   4. nivelar_medias_progressivo -- idem (congelada), troca casos do operador
--      por casos do pool sem olhar a janela.
--
-- Efeito colateral aceito: o teto de 500 passa a ser um teto "quando da" -- se
-- todo o excedente estiver dentro dos 10 dias, o operador fica acima de 500 ate
-- a janela vencer. Protecao do prazo vence o teto (decisao da Amanda).
--
-- APLICADA EM PROD (ahattpqrjmhkzsmnbdzs) em 2026-08-25, em tres partes pelo
-- MCP: proteger_prazo_fidelizacao_teto_parte1 / _parte2_nivelar /
-- _parte3_redistribuir. O conteudo e o deste arquivo (o corte foi so de
-- transporte; os acentos dos comentarios foram removidos no transporte).
-- Backfill junto: supabase/recovery/20260825_devolver_teto_dentro_do_prazo.sql
-- Rollback: supabase/rollbacks/20260825233000_*.rollback.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Teto por trigger: nao soltar quem esta dentro dos 10 dias.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_impor_teto_operador()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_meta int := 500; v_email text := NEW.operador_email; v_qtd_ativa int; v_excedente int; caso_rec record;
BEGIN
  -- Bypass durante a execução do nivelamento (flag de sessão, sem lock de tabela)
  IF coalesce(current_setting('calibragem.bypass_teto', true), 'off') = 'on' THEN RETURN NEW; END IF;
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
      -- Dentro dos 10 dias do ultimo acionamento o caso e do operador: o teto espera.
      AND NOT public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
      AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
      ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_excedente LOOP
    UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL WHERE id = caso_rec.id;
    INSERT INTO public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em) VALUES (caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'LIBERACAO_AUTOMATICA_TETO_EXCEDIDO', NEW.operador_nome, v_email, 'Teto de ' || v_meta || ' casos excedido após atribuição manual -- liberado automaticamente (menor valor, fora dos 10 dias de fidelização)', now());
  END LOOP;
  RETURN NEW;
END; $function$;

-- ---------------------------------------------------------------------------
-- 2. Teto por RPC: mesmos guards + congelamento (sem uso no front).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reforcar_teto_operadores()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op RECORD;
  v_caso RECORD;
  v_total INT := 0;
BEGIN
  FOR v_op IN
    SELECT operador_email, count(*) AS qtd
    FROM public.casos
    WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br'
    GROUP BY operador_email HAVING count(*) > 500
  LOOP
    FOR v_caso IN
      SELECT c.id FROM public.casos c
      JOIN public.alunos a ON a.id = c.aluno_id
      WHERE c.operador_email = v_op.operador_email
        AND c.quitado_em IS NULL
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%CANCEL%'
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%JURIDIC%'
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%ACORDO%'
        AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
        AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
        -- Dentro dos 10 dias do ultimo acionamento o caso e do operador.
        AND NOT public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
      ORDER BY a.data_ultimo_acionamento ASC NULLS FIRST
      LIMIT (v_op.qtd - 500)
    LOOP
      UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL,
        caso_atualizado_por = 'job_reforco_teto', caso_atualizado_em = now()
      WHERE id = v_caso.id;
      v_total := v_total + 1;
    END LOOP;
  END LOOP;
  RETURN v_total;
END;
$function$;

revoke execute on function public.reforcar_teto_operadores() from public;
revoke execute on function public.reforcar_teto_operadores() from anon;
revoke execute on function public.reforcar_teto_operadores() from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Nivelamento progressivo (congelado): nao tirar de quem esta no prazo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nivelar_medias_progressivo()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_media_alvo numeric; v_op RECORD; v_caso RECORD; v_pool_id uuid;
  v_margem numeric := 500; v_max_trocas_por_operador int := 5; v_total INT := 0;
BEGIN
  SELECT round(avg(coalesce(total_em_aberto,0))::numeric,2) INTO v_media_alvo FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br';
  IF v_media_alvo IS NULL THEN RETURN 0; END IF;
  FOR v_op IN SELECT operador_email, round(avg(coalesce(total_em_aberto,0))::numeric,2) AS media FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br' GROUP BY operador_email LOOP
    IF v_op.media > v_media_alvo + v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto DESC NULLS LAST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    ELSIF v_op.media < v_media_alvo - v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_max_trocas_por_operador LOOP
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

commit;

-- ---------------------------------------------------------------------------
-- 4. Redistribuicao geral e por faixas (ambas congeladas desde 20260730220000,
--    sem EXECUTE para authenticated/anon e sem cron). O guard entra agora para
--    que um eventual descongelamento nao reabra o furo.
--    OBS (faixas): com casos retidos pela fidelizacao, o operador termina com
--    500 novos + os retidos. A conferencia final continua olhando so o que foi
--    distribuido nesta execucao; se a funcao voltar a ser usada, o teto tem de
--    ser recalculado descontando os retidos.
-- ---------------------------------------------------------------------------
begin;

CREATE OR REPLACE FUNCTION public.redistribuir_casos_operadores(p_executado_por_nome text, p_executado_por_email text, p_meta_por_operador integer DEFAULT 500)
 RETURNS TABLE(operador_email text, operador_nome text, casos_atribuidos integer, valor_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
    -- Dentro dos 10 dias do ultimo acionamento o caso e do operador: nao solta.
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);
  update public.casos set operador_email=null, operador_nome=null, operador=null
  where casos.operador_email = any(v_operadores)
    and not internal.matricula_em_fidelizacao(casos.aluno_id, casos.matricula)
    and not public.caso_dentro_prazo_fidelizacao(casos.data_ultimo_acionamento)
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

CREATE OR REPLACE FUNCTION public.redistribuir_casos_operadores_faixas(p_exec_nome text, p_exec_email text)
 RETURNS TABLE(operador_email text, operador_nome text, casos integer, saldo numeric, q_alto integer, q_medio integer, q_inter integer, q_baixo integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ops text[]; v_nomes text[]; v_upper text[]; n int; idx int;
  totais numeric[]; qtd int[]; qa int[]; qm int[]; qi int[]; qb int[];
  rec record; best int; bestval numeric;
  cap_alto int; cap_medio int; cap_inter int := 150;
  v_total int := 0; v_valor numeric := 0;
begin
  if not exists (select 1 from public.usuarios u where lower(u.email)=lower(p_exec_email) and u.ativo=true and u.perfil in ('gerencia','administrativo')) then raise exception 'Usuario % sem permissao para redistribuir.', p_exec_email; end if;
  perform pg_advisory_xact_lock(hashtext('redistribuir_casos_operadores_faixas'));
  select array_agg(u.email order by u.nome), array_agg(coalesce(u.operador_nome,u.nome) order by u.nome), array_agg(upper(coalesce(u.operador,u.nome)) order by u.nome) into v_ops, v_nomes, v_upper from public.usuarios u where u.perfil='operador' and u.ativo=true;
  n := coalesce(array_length(v_ops,1),0);
  if n=0 then raise exception 'Nenhum operador ativo.'; end if;
  totais := array_fill(0::numeric, array[n]); qtd := array_fill(0, array[n]);
  qa := array_fill(0, array[n]); qm := array_fill(0, array[n]); qi := array_fill(0, array[n]); qb := array_fill(0, array[n]);
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_anterior_nome,operador_anterior_email,observacao,criado_em)
  select c.chave_unificacao,c.nome,c.cpf,'REDISTRIBUICAO_FAIXAS_SOLTURA',c.operador_nome,c.operador_email,'Redistribuicao por faixas executada por '||p_exec_nome,now()
  from public.casos c where c.operador_email is not null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    and public.saldo_titulos_aberto(c.cpf_limpo) > 0;
  update public.operador_agenda oa set status='CANCELADO_REDISTRIBUICAO', atualizado_em=now()
  from public.casos c
  where c.operador_email is not null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    and public.saldo_titulos_aberto(c.cpf_limpo) > 0
    and oa.aluno_id::text = c.aluno_id::text and lower(oa.operador_email)=lower(c.operador_email)
    and coalesce(oa.status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_REDISTRIBUICAO');
  update public.casos c set operador_email=null, operador_nome=null, operador=null,
    data_retorno=null, data_retorno_nova=null, hora_retorno=null, proxima_acao_automatica=null
  where c.operador_email is not null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    and public.saldo_titulos_aberto(c.cpf_limpo) > 0;
  create temp table _pool on commit drop as
  select c.id, x.s, case when x.s>10000 then 1 when x.s>5000 then 2 when x.s>3000 then 3 else 4 end as faixa
  from public.casos c cross join lateral (select public.saldo_titulos_aberto(c.cpf_limpo) as s) x
  where c.operador_email is null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
    and x.s > 0;
  cap_alto := ceil((select count(*) from _pool where faixa=1)::numeric / n);
  cap_medio := ceil((select count(*) from _pool where faixa=2)::numeric / n);
  for rec in select id,s from _pool where faixa=1 order by s desc loop
    best:=null;bestval:=null;
    for idx in 1..n loop if qtd[idx]<500 and qa[idx]<cap_alto then if best is null or totais[idx]<bestval then best:=idx;bestval:=totais[idx];end if;end if;end loop;
    exit when best is null;
    update public.casos set operador_email=v_ops[best],operador_nome=v_nomes[best],operador=v_upper[best],caso_atualizado_por=p_exec_email,caso_atualizado_em=now() where casos.id=rec.id;
    totais[best]:=totais[best]+coalesce(rec.s,0);qtd[best]:=qtd[best]+1;qa[best]:=qa[best]+1;v_total:=v_total+1;v_valor:=v_valor+coalesce(rec.s,0);
  end loop;
  for rec in select id,s from _pool where faixa=2 order by s desc loop
    best:=null;bestval:=null;
    for idx in 1..n loop if qtd[idx]<500 and qm[idx]<cap_medio then if best is null or totais[idx]<bestval then best:=idx;bestval:=totais[idx];end if;end if;end loop;
    exit when best is null;
    update public.casos set operador_email=v_ops[best],operador_nome=v_nomes[best],operador=v_upper[best],caso_atualizado_por=p_exec_email,caso_atualizado_em=now() where casos.id=rec.id;
    totais[best]:=totais[best]+coalesce(rec.s,0);qtd[best]:=qtd[best]+1;qm[best]:=qm[best]+1;v_total:=v_total+1;v_valor:=v_valor+coalesce(rec.s,0);
  end loop;
  for rec in select id,s from _pool where faixa=3 order by s desc loop
    best:=null;bestval:=null;
    for idx in 1..n loop if qtd[idx]<500 and qi[idx]<cap_inter then if best is null or totais[idx]<bestval then best:=idx;bestval:=totais[idx];end if;end if;end loop;
    exit when best is null;
    update public.casos set operador_email=v_ops[best],operador_nome=v_nomes[best],operador=v_upper[best],caso_atualizado_por=p_exec_email,caso_atualizado_em=now() where casos.id=rec.id;
    totais[best]:=totais[best]+coalesce(rec.s,0);qtd[best]:=qtd[best]+1;qi[best]:=qi[best]+1;v_total:=v_total+1;v_valor:=v_valor+coalesce(rec.s,0);
  end loop;
  for rec in select id,s from _pool where faixa=4 order by s desc loop
    best:=null;bestval:=null;
    for idx in 1..n loop if qtd[idx]<500 then if best is null or totais[idx]<bestval then best:=idx;bestval:=totais[idx];end if;end if;end loop;
    exit when best is null;
    update public.casos set operador_email=v_ops[best],operador_nome=v_nomes[best],operador=v_upper[best],caso_atualizado_por=p_exec_email,caso_atualizado_em=now() where casos.id=rec.id;
    totais[best]:=totais[best]+coalesce(rec.s,0);qtd[best]:=qtd[best]+1;qb[best]:=qb[best]+1;v_total:=v_total+1;v_valor:=v_valor+coalesce(rec.s,0);
  end loop;
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_nome,operador_email,observacao,criado_em)
  select c.chave_unificacao,c.nome,c.cpf,'REDISTRIBUICAO_FAIXAS_ENTRADA',c.operador_nome,c.operador_email,'Redistribuicao por faixas executada por '||p_exec_nome,now()
  from public.casos c where c.caso_atualizado_por=p_exec_email and c.caso_atualizado_em >= now() - interval '2 minutes';
  insert into public.auditoria (usuario,acao,tabela_afetada,detalhes,created_at)
  values (p_exec_email,'REDISTRIBUIU_CASOS_FAIXAS','casos', jsonb_build_object('executor',p_exec_nome,'total',v_total,'valor',v_valor,'operadores',v_ops), now());
  for idx in 1..n loop if qtd[idx]<>500 then raise exception 'ROLLBACK: operador % com % casos (esperado 500).', v_ops[idx], qtd[idx]; end if; end loop;
  if exists (select 1 from public.casos c where c.operador_email = any(v_ops)
      and (public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
        or public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)))
  then raise exception 'ROLLBACK: protegido/encerrado atribuido.'; end if;
  if v_total <> n*500 then raise exception 'ROLLBACK: total % (esperado %).', v_total, n*500; end if;
  return query select v_ops[gs.k],v_nomes[gs.k],qtd[gs.k],round(totais[gs.k],2),qa[gs.k],qm[gs.k],qi[gs.k],qb[gs.k]
  from generate_series(1,n) as gs(k) order by v_nomes[gs.k];
end; $function$;

-- As duas seguem congeladas (sem EXECUTE para authenticated/anon).
revoke execute on function public.redistribuir_casos_operadores(text,text,integer) from public;
revoke execute on function public.redistribuir_casos_operadores(text,text,integer) from anon;
revoke execute on function public.redistribuir_casos_operadores(text,text,integer) from authenticated;
revoke execute on function public.redistribuir_casos_operadores_faixas(text,text) from public;
revoke execute on function public.redistribuir_casos_operadores_faixas(text,text) from anon;
revoke execute on function public.redistribuir_casos_operadores_faixas(text,text) from authenticated;

commit;
