-- Performance (auth_rls_initplan) — schema inteiro. Envolve auth.jwt()/email()/
-- uid()/role() em (select ...) em TODAS as políticas RLS de public, para o
-- Postgres avaliar a função UMA VEZ POR QUERY (InitPlan) em vez de por linha.
--
-- Lê a definição do próprio catálogo e aplica só o wrap via regex nas funções
-- argless de auth -> SEM reescrita manual (zero risco de transcrição).
-- Semântica IDÊNTICA: mesmas linhas, MESMA PERMISSÃO. Verificado em prod:
-- 0 políticas com chamada crua após a execução; spot-check RH/DRE/usuarios ok.
--
-- Idempotente: pula políticas já wrapadas (guard 'select auth.').

DO $$
DECLARE
  r record; nq text; nc text; sql text;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname='public'
      AND (coalesce(qual,'')||coalesce(with_check,'')) ~ 'auth\.(jwt|email|uid|role)\(\)'
      AND lower(coalesce(qual,'')||coalesce(with_check,'')) NOT LIKE '%select auth.%'
  LOOP
    nq := r.qual; nc := r.with_check;
    IF nq IS NOT NULL THEN
      nq := regexp_replace(nq, 'auth\.(jwt|email|uid|role)\(\)', '(select auth.\1())', 'g');
    END IF;
    IF nc IS NOT NULL THEN
      nc := regexp_replace(nc, 'auth\.(jwt|email|uid|role)\(\)', '(select auth.\1())', 'g');
    END IF;
    sql := format('ALTER POLICY %I ON public.%I', r.policyname, r.tablename);
    IF nq IS NOT NULL THEN sql := sql || format(' USING (%s)', nq); END IF;
    IF nc IS NOT NULL THEN sql := sql || format(' WITH CHECK (%s)', nc); END IF;
    EXECUTE sql;
  END LOOP;
END $$;
