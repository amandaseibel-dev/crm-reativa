BEGIN;
-- ACOES MASSIVAS: migration COMBINADA (substitui, sem aplicar em sequencia, duas propostas):
--   (a) supabase/migrations/20261029183847_acoes_massivas_universo_consolidado_v2.sql
--       -- recorte por responsavel pelo CASO (v_rc / f_outro). Esta migration a contem.
--   (b) docs/acoes-massivas/proposta-fidelizacao-e-fuso-20261106.md (PR #835)
--       -- fidelizacao ate o 10o dia em todos os filtros, dia de referencia em
--          America/Sao_Paulo, e exportacao por e-mail a partir de lote de WhatsApp.
-- NAO aplique a v2 nem a proposta da #835 separadamente: ambas ancoram no mesmo
-- MD5 publicado (88ec923f40294febcd4376491102b37d) e a segunda aplicacao falharia
-- pela guarda. Esta migration parte da DEFINICAO PUBLICADA e leva as duas.
--
-- Regras aplicadas (ja confirmadas):
--   * massivas so a partir do 11o dia sem interacao valida, em America/Sao_Paulo;
--   * fidelizacao protege ate o 10o dia inclusive (dua_brt + 10 >= hoje_brt);
--   * TODOS e CASO respeitam a mesma protecao: selecionar TODOS nao contorna.
--   * a protecao usa SOMENTE data_ultimo_acionamento e responsavel; nao usa marca
--     antiga de fidelizacao (fidelizacao_ativa vem da mesma data, nao de flag).
--
-- Guardas: MD5 da definicao publicada de cada funcao. Qualquer divergencia aborta
-- tudo (transacao). Rollback: supabase/rollbacks/20261112120000_..._rollback.sql.

-- 0. GUARDAS --------------------------------------------------------------------
DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo') <> '88ec923f40294febcd4376491102b37d' THEN
    RAISE EXCEPTION 'Universo publicado mudou desde a validacao (esperado 88ec...). Nada aplicado.';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar_emails_do_lote') <> '9c4c8486b2436a573c0ba589428c172c' THEN
    RAISE EXCEPTION 'Exportacao por e-mail publicada mudou desde a validacao (esperado 9c4c...). Nada aplicado.';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar') <> '2f867f7da9f33b28868f70416c685727' THEN
    RAISE EXCEPTION 'Exportacao publicada mudou desde a validacao (esperado 2f867f...). Nada aplicado.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_fidelizacao_protege') THEN
    RAISE EXCEPTION 'Funcao acoes_massivas_fidelizacao_protege ja existe. Nada aplicado.';
  END IF;
END $g$;

-- 1. FUNCAO AUXILIAR PURA (regra de 10 dias em Brasilia) ------------------------
CREATE FUNCTION public.acoes_massivas_fidelizacao_protege(p_dua timestamptz, p_agora timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $f$
  SELECT p_dua IS NOT NULL
     AND (p_dua AT TIME ZONE 'America/Sao_Paulo')::date + 10 >= (p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
$f$;

-- 2. UNIVERSO: declara v_rc, trata caso (v2) e protege fidelizacao (#835) -------
SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$a1$  v_op text := coalesce(lower(nullif(btrim(f->>'operador'), '')), 'livres');$a1$,
$n1$  v_op text := coalesce(lower(nullif(btrim(f->>'operador'), '')), 'livres');
  v_rc text[] := case when jsonb_typeof(f->'responsaveis_caso') = 'array'
                      then nullif(array(select lower(btrim(x))
                                          from jsonb_array_elements_text(f->'responsaveis_caso') x
                                         where nullif(btrim(x),'') is not null), '{}'::text[]) end;$n1$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$a4$           case when v_op = 'todos' then false
                when v_op = 'livres' then k.resp is not null
                else k.resp is distinct from v_op end as f_outro,$a4$,
$n4$           case
                when v_rc is not null then not (
                  lower(coalesce(k.resp,'')) = any(v_rc)
                  or (nullif(btrim(coalesce(k.resp,'')),'') is null
                      and 'sem_responsavel' = any(v_rc)))
                when v_op = 'todos' then false
                when v_op = 'livres' then k.resp is not null
                else k.resp is distinct from v_op end as f_outro,$n4$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$u1$           (k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,$u1$,
$u1$           (k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,
           (k.resp is not null and public.acoes_massivas_fidelizacao_protege(k.dua)) as f_fid,$u1$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$u2$                when e.f_ret then 'retorno_futuro'
                when e.f_outro then 'outro_responsavel'$u2$,
$u2$                when e.f_ret then 'retorno_futuro'
                when e.f_fid then 'fidelizacao_ativa'
                when e.f_outro then 'outro_responsavel'$u2$, 2);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$u3$         (cl.resp is not null and cl.dua is not null and public.caso_dentro_prazo_fidelizacao(cl.dua::date)),$u3$,
$u3$         (cl.resp is not null and public.acoes_massivas_fidelizacao_protege(cl.dua)),$u3$, 1);

-- 3. EXPORTACAO POR E-MAIL (lote de WhatsApp): mesma protecao (#835) -------------
SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$e1$    from (select x.id_txt as aluno_id, x.ord, a.nome, btrim(a.email) as email,
                 public.email_valido_para_acao_massiva(a.email) as tem_email$e1$,
$e1$    from (select x.id_txt as aluno_id, x.ord, a.nome, btrim(a.email) as email,
                 (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento)) as fid,
                 (public.email_valido_para_acao_massiva(a.email) and not (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento))) as tem_email$e1$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$e2$   where public.email_valido_para_acao_massiva(a.email);$e2$,
$e2$   where public.email_valido_para_acao_massiva(a.email)
     and not (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento));$e2$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$e3$'aluno_id', d.aluno_id, 'motivo_codigo', 'sem_email_valido',$e3$,
$e3$'aluno_id', d.aluno_id, 'motivo_codigo', case when d.fid then 'fidelizacao_ativa' else 'sem_email_valido' end,$e3$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$e4$'motivo', 'Sem e-mail válido no cadastro')$e4$,
$e4$'motivo', case when d.fid then 'Protegido pela fidelização até o 10º dia' else 'Sem e-mail válido no cadastro' end)$e4$, 1);

-- 3b. EXPORTACAO (recorte da previa autorizada) ----------------------------------
-- Com previa, o operador e o tipo vem da PREVIA. p_operador_email nao substitui o
-- recorte: se divergir da previa, recusa. Sem previa, 'caso:' e recusado.
SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar',
$x1$  v_op := coalesce(lower(nullif(btrim(p_operador_email), '')),
                   lower(nullif(btrim(v_pf ->> 'operador'), '')), 'livres');$x1$,
$x1$  if p_previa_id is not null and nullif(btrim(p_operador_email), '') is not null
     and lower(btrim(p_operador_email)) is distinct from lower(nullif(btrim(v_pf ->> 'operador'), '')) then
    raise exception 'Selecao diverge da previa autorizada. Gere a previa de novo.' using errcode = '22023';
  end if;
  if p_previa_id is null and lower(btrim(coalesce(p_operador_email, ''))) like 'caso:%' then
    raise exception 'Exportacao por responsavel do caso exige a previa autorizada.' using errcode = '22023';
  end if;
  v_op := coalesce(lower(nullif(btrim(v_pf ->> 'operador'), '')),
                   lower(nullif(btrim(p_operador_email), '')), 'livres');$x1$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar',
$x2$  v_tipo := coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), v_pf ->> 'tipo_cobranca', 'MENSALIDADES_E_ACORDOS');$x2$,
$x2$  v_tipo := coalesce(v_pf ->> 'tipo_cobranca', upper(nullif(btrim(p_tipo_cobranca), '')), 'MENSALIDADES_E_ACORDOS');$x2$, 1);

-- 4. VERIFICACOES FINAIS --------------------------------------------------------
-- O MD5 final de cada funcao e gravado em 20261112120000_..._md5.txt pelo teste de
-- migracao (ver tests). Aqui so confere que as duas funcoes existem e que a protecao
-- responde 'protegido' e 'liberado' nos horarios de referencia de Brasilia.
DO $t$
BEGIN
  IF NOT public.acoes_massivas_fidelizacao_protege(timestamptz '2026-10-27 10:00:00-03', timestamptz '2026-11-06 22:00:00-03') THEN
    RAISE EXCEPTION 'Teste 10o dia a noite: deveria estar protegido.';
  END IF;
  IF public.acoes_massivas_fidelizacao_protege(timestamptz '2026-10-26 10:00:00-03', timestamptz '2026-11-06 10:00:00-03') THEN
    RAISE EXCEPTION 'Teste 11o dia: deveria estar liberado.';
  END IF;
  IF public.acoes_massivas_fidelizacao_protege(timestamptz '2026-10-26 22:00:00-03', timestamptz '2026-11-06 10:00:00-03') THEN
    RAISE EXCEPTION 'Teste acionamento a noite: deveria estar liberado no 11o dia BRT.';
  END IF;
END $t$;

-- 5. MD5 FINAL (guarda de conferencia do resultado; aborta se a composicao divergir)
DO $m$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_universo') <> 'cefd206824186d4da8e6f1e35c14beb8' THEN
    RAISE EXCEPTION 'MD5 final do universo diferente do validado (esperado cefd2068...).';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar_emails_do_lote') <> '00d3370a7800bd334292808e1573a57d' THEN
    RAISE EXCEPTION 'MD5 final da exportacao por e-mail diferente do validado (esperado 00d3370a...).';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar') <> 'c9cc7498d16ca250e85c4727c8bb05bd' THEN
    RAISE EXCEPTION 'MD5 final da exportacao diferente do validado (esperado c9cc7498...).';
  END IF;
END $m$;

COMMIT;
