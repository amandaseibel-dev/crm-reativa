-- Fidelização de 10 dias ao assumir uma matrícula.
--
-- Regra: quando uma matrícula é assumida, alunos.responsavel_atual_em recebe
-- now(). Durante 10 dias corridos a partir dessa data a matrícula NÃO pode ser
-- movida por nivelamento, distribuição, redistribuição nem retirada pelo
-- gatilho de teto.
--
-- Identificação da matrícula (nesta ordem, SEM CPF):
--   1) aluno_id válido (casos.aluno_id = alunos.id, ambos uuid); ou
--   2) quando aluno_id é NULL, matrícula EXATA e ÚNICA (exatamente 1 aluno com
--      a mesma matrícula). Matrícula ausente, sem correspondência ou ambígua
--      (>1 aluno) NÃO é protegida e NÃO é vinculada.
-- Nunca mistura matrículas diferentes do mesmo aluno. Não faz backfill nem
-- altera dados históricos.
--
-- Ações massivas já respeitam a fidelização: buscar_candidatos_acoes_massivas e
-- total_elegiveis_acoes_massivas filtram alunos.responsavel_atual_email IS NULL.
--
-- Hygiene: idempotente (CREATE OR REPLACE); preserva SECURITY DEFINER,
-- search_path, owner e grants das funções (CREATE OR REPLACE não altera
-- owner nem revoga grants); não altera assinaturas usadas por frontend/jobs;
-- não altera dados/constraints/RLS. Rollback em
-- 20260724120000_fidelizacao_assumir_matricula_down.sql.
--
-- NÃO altera: quantidade limite da carteira, regra numérica do teto (500),
-- reposição, metas ou critérios gerais da carteira. No teto, apenas impede que
-- o caso ESCOLHIDO para sair seja uma matrícula fidelizada.

BEGIN;

-- 1) Predicado central de fidelização.
--    Protege por aluno_id; na ausência dele, por matrícula EXATA e ÚNICA.
--    p_aluno_id NULL + matrícula ausente/ambígua/sem match -> false.
CREATE OR REPLACE FUNCTION internal.matricula_em_fidelizacao(p_aluno_id uuid, p_matricula text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH alvo AS (
    -- vínculo principal: aluno_id
    SELECT p_aluno_id AS aid
    WHERE p_aluno_id IS NOT NULL
    UNION ALL
    -- alternativa: SOMENTE matrícula exata e única (quando não há aluno_id)
    SELECT a.id
    FROM public.alunos a
    WHERE p_aluno_id IS NULL
      AND nullif(btrim(p_matricula),'') IS NOT NULL
      AND btrim(a.matricula) = btrim(p_matricula)
      AND (SELECT count(*) FROM public.alunos a2
           WHERE btrim(a2.matricula) = btrim(p_matricula)) = 1
  )
  SELECT EXISTS (
    SELECT 1
    FROM alvo
    JOIN public.alunos a ON a.id = alvo.aid
    WHERE a.responsavel_atual_email IS NOT NULL
      AND a.responsavel_atual_em IS NOT NULL
      AND a.responsavel_atual_em > now() - interval '10 days'
  );
$function$;

-- 2) Nivelamento diário: não solta nem puxa da pool matrículas fidelizadas.
CREATE OR REPLACE FUNCTION public.nivelar_medias_progressivo()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_media_alvo numeric;
  v_op RECORD;
  v_caso RECORD;
  v_pool_id uuid;
  v_margem numeric := 500;
  v_max_trocas_por_operador int := 5;
  v_total INT := 0;
BEGIN
  SELECT round(avg(coalesce(total_em_aberto,0))::numeric,2) INTO v_media_alvo
  FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br';
  IF v_media_alvo IS NULL THEN RETURN 0; END IF;

  FOR v_op IN
    SELECT operador_email, round(avg(coalesce(total_em_aberto,0))::numeric,2) AS media
    FROM public.casos
    WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br'
    GROUP BY operador_email
  LOOP
    IF v_op.media > v_media_alvo + v_margem THEN
      FOR v_caso IN
        SELECT id FROM public.casos
        WHERE operador_email = v_op.operador_email AND quitado_em IS NULL
          AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%'
          AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%'
          AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%'
          AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula)
        ORDER BY total_em_aberto DESC NULLS LAST
        LIMIT v_max_trocas_por_operador
      LOOP
        SELECT id INTO v_pool_id FROM public.casos
        WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL
          AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%'
          AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%'
          AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula)
        ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL,
            caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email,
            caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    ELSIF v_op.media < v_media_alvo - v_margem THEN
      FOR v_caso IN
        SELECT id FROM public.casos
        WHERE operador_email = v_op.operador_email AND quitado_em IS NULL
          AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%'
          AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%'
          AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%'
          AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula)
        ORDER BY total_em_aberto ASC NULLS FIRST
        LIMIT v_max_trocas_por_operador
      LOOP
        SELECT id INTO v_pool_id FROM public.casos
        WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL
          AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%'
          AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%'
          AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula)
        ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL,
            caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email,
            caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_total;
END;
$function$;

-- 3) Redistribuição geral: não solta nem redistribui matrículas fidelizadas.
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
  if not exists (select 1 from public.usuarios u where lower(u.email)=lower(p_executado_por_email) and u.ativo=true and u.perfil in ('gerencia','administrativo')) then
    raise exception 'Usuário % não tem permissão para redistribuir a fila operacional.', p_executado_por_email;
  end if;

  perform pg_advisory_xact_lock(hashtext('redistribuir_casos_operadores'));

  select array_agg(u.email order by u.nome), array_agg(coalesce(u.operador_nome,u.nome) order by u.nome), array_agg(upper(coalesce(u.operador,u.nome)) order by u.nome)
    into v_operadores, v_nomes, v_nomes_upper
    from public.usuarios u where u.perfil='operador' and u.ativo=true;
  v_qtd_operadores := coalesce(array_length(v_operadores,1),0);
  if v_qtd_operadores = 0 then raise exception 'Nenhum operador ativo encontrado em usuarios (perfil=operador, ativo=true).'; end if;

  totais := array_fill(0::numeric, array[v_qtd_operadores]);
  qtds := array_fill(0, array[v_qtd_operadores]);

  insert into public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em)
  select c.chave_unificacao, c.nome, c.cpf, 'REDISTRIBUICAO_AUTOMATICA_SOLTURA', c.operador_nome, c.operador_email, 'Redistribuição executada por '||p_executado_por_nome, now()
  from public.casos c where c.operador_email = any(v_operadores)
    and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula);

  update public.casos set operador_email=null, operador_nome=null, operador=null
  where casos.operador_email = any(v_operadores)
    and not internal.matricula_em_fidelizacao(casos.aluno_id, casos.matricula);

  for caso_rec in
    with pool as (
      select c.id, public.saldo_titulos_aberto(c.cpf_limpo) as saldo_orig, c.status_acionamento
      from public.casos c
      where c.operador_email is null
        and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
        and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
        and not public.caso_reservado_administrativo(c.chave_unificacao)
        and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
    )
    select pool.id, pool.saldo_orig from pool
    where pool.saldo_orig > 0
    order by (pool.status_acionamento is null) desc, pool.saldo_orig desc nulls last
  loop
    min_idx := null; min_val := null;
    for idx in 1..v_qtd_operadores loop
      if qtds[idx] < p_meta_por_operador then
        if min_idx is null or totais[idx] < min_val then min_idx := idx; min_val := totais[idx]; end if;
      end if;
    end loop;
    exit when min_idx is null;

    update public.casos
      set operador_email=v_operadores[min_idx], operador_nome=v_nomes[min_idx], operador=v_nomes_upper[min_idx],
          caso_atualizado_por=p_executado_por_email, caso_atualizado_em=now()
      where casos.id = caso_rec.id;

    totais[min_idx] := totais[min_idx] + coalesce(caso_rec.saldo_orig,0);
    qtds[min_idx] := qtds[min_idx] + 1;
    v_total_distribuido := v_total_distribuido + 1;
    v_valor_distribuido := v_valor_distribuido + coalesce(caso_rec.saldo_orig,0);
  end loop;

  insert into public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
  select c.chave_unificacao, c.nome, c.cpf, 'REDISTRIBUICAO_AUTOMATICA_ENTRADA', c.operador_nome, c.operador_email, 'Redistribuição executada por '||p_executado_por_nome, now()
  from public.casos c
  where c.caso_atualizado_por = p_executado_por_email and c.caso_atualizado_em >= now() - interval '1 minute';

  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes, created_at)
  values (p_executado_por_email, 'REDISTRIBUIU_CASOS', 'casos',
    jsonb_build_object('executado_por_nome',p_executado_por_nome,'meta_por_operador',p_meta_por_operador,'total_casos_distribuidos',v_total_distribuido,'valor_total_distribuido',v_valor_distribuido,'operadores',v_operadores), now());

  return query select v_operadores[i], v_nomes[i], qtds[i], totais[i]
  from generate_series(1, v_qtd_operadores) i order by v_nomes[i];
end;
$function$;

-- 4) Redistribuição por faixas: matrícula fidelizada é tratada como caso
--    protegido (não é solta nem entra na pool), igual ao já existente para
--    caso_protegido_redistribuicao. Os invariantes de 500 contam apenas
--    atribuições vindas da pool, então casos fidelizados permanecem anexados
--    ao operador atual sem quebrar as verificações.
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
  if not exists (select 1 from public.usuarios u where lower(u.email)=lower(p_exec_email) and u.ativo=true and u.perfil in ('gerencia','administrativo')) then
    raise exception 'Usuario % sem permissao para redistribuir.', p_exec_email; end if;
  perform pg_advisory_xact_lock(hashtext('redistribuir_casos_operadores_faixas'));
  select array_agg(u.email order by u.nome), array_agg(coalesce(u.operador_nome,u.nome) order by u.nome), array_agg(upper(coalesce(u.operador,u.nome)) order by u.nome)
    into v_ops, v_nomes, v_upper from public.usuarios u where u.perfil='operador' and u.ativo=true;
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
    and public.saldo_titulos_aberto(c.cpf_limpo) > 0;

  -- CANCELA agendamentos de retorno dos casos que serao soltos
  update public.operador_agenda oa set status='CANCELADO_REDISTRIBUICAO', atualizado_em=now()
  from public.casos c
  where c.operador_email is not null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
    and public.saldo_titulos_aberto(c.cpf_limpo) > 0
    and oa.aluno_id::text = c.aluno_id::text and lower(oa.operador_email)=lower(c.operador_email)
    and coalesce(oa.status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_REDISTRIBUICAO');

  -- SOLTURA: zera responsavel + LIMPA retorno na ficha do caso
  update public.casos c set operador_email=null, operador_nome=null, operador=null,
    data_retorno=null, data_retorno_nova=null, hora_retorno=null, proxima_acao_automatica=null
  where c.operador_email is not null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    and not internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
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
end;
$function$;

-- 5) Gatilho de teto: apenas impede que o caso ESCOLHIDO para sair seja uma
--    matrícula fidelizada. Não altera a meta (500), a contagem do teto
--    (v_qtd_ativa/v_excedente) nem qualquer regra numérica/carteira.
CREATE OR REPLACE FUNCTION public.trg_impor_teto_operador()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_meta int := 500;
  v_email text := NEW.operador_email;
  v_qtd_ativa int;
  v_excedente int;
  caso_rec record;
BEGIN
  -- Só age se o caso ACABOU de ser atribuído/trocado pra um operador do pool
  IF v_email IS NULL OR v_email IS NOT DISTINCT FROM OLD.operador_email THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.email = v_email AND u.perfil = 'operador' AND u.ativo = true) THEN
    RETURN NEW;
  END IF;

  -- Se o próprio caso recém-atribuído já está protegido (pago/negociação/etc),
  -- não conta pro teto -- não faz sentido soltar outro caso por causa dele.
  IF public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_qtd_ativa
  FROM public.casos c
  WHERE c.operador_email = v_email
    AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  v_excedente := v_qtd_ativa - v_meta;
  IF v_excedente <= 0 THEN
    RETURN NEW;
  END IF;

  -- Solta o(s) caso(s) de menor valor pra voltar ao teto (normalmente 1,
  -- mas cobre o caso raro de excesso maior por edição em lote).
  -- Guarda de elegibilidade: matrícula fidelizada NUNCA é escolhida para sair.
  FOR caso_rec IN
    SELECT id, chave_unificacao, nome, cpf
    FROM public.casos c
    WHERE c.operador_email = v_email
      AND c.id <> NEW.id
      AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
      AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
    ORDER BY total_em_aberto ASC NULLS FIRST
    LIMIT v_excedente
  LOOP
    UPDATE public.casos
    SET operador_email = NULL, operador_nome = NULL, operador = NULL
    WHERE id = caso_rec.id;

    INSERT INTO public.historico_operadores_alunos (
      chave_unificacao, nome_aluno, cpf_referencia, acao,
      operador_anterior_nome, operador_anterior_email, observacao, criado_em
    ) VALUES (
      caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'LIBERACAO_AUTOMATICA_TETO_EXCEDIDO',
      NEW.operador_nome, v_email,
      'Teto de ' || v_meta || ' casos excedido após atribuição manual -- liberado automaticamente (menor valor)', now()
    );
  END LOOP;

  RETURN NEW;
END;
$function$;

COMMIT;
