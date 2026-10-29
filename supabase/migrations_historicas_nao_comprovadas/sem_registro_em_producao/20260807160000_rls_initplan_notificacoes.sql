-- Performance (auth_rls_initplan): nas políticas RLS de public.notificacoes,
-- as chamadas auth.email()/auth.jwt() eram reavaliadas UMA VEZ POR LINHA.
-- Envolvendo em (select ...), o Postgres avalia UMA VEZ POR QUERY (InitPlan).
--
-- IMPORTANTE: a SEMÂNTICA é idêntica — mesmas linhas visíveis, MESMA PERMISSÃO.
-- Só muda quantas vezes a função de auth roda. notificacoes é acessada por
-- realtime/badge, então o ganho por-query importa.
--
-- Guardado: só altera se a policy existir (não quebra em ambiente novo onde o
-- schema base ainda não criou as políticas).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notificacoes' AND policyname='notif_select_proprias') THEN
    ALTER POLICY notif_select_proprias ON public.notificacoes
      USING (lower(usuario_destino_email) = lower((select auth.email())));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notificacoes' AND policyname='notif_update_proprias') THEN
    ALTER POLICY notif_update_proprias ON public.notificacoes
      USING (lower(usuario_destino_email) = lower((select auth.email())))
      WITH CHECK (lower(usuario_destino_email) = lower((select auth.email())));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notificacoes' AND policyname='notificacoes_select') THEN
    ALTER POLICY notificacoes_select ON public.notificacoes
      USING (usuario_e_gestao_fila() OR (lower(usuario_destino_email) = lower(COALESCE(((select auth.jwt()) ->> 'email'::text), ''::text))));
  END IF;
END $$;
