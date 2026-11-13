-- ROLLBACK de 20261113100000_acoes_massivas_confirmar_envio.
-- Volta acoes_massivas_exportar ao corpo publicado (c9cc7498..., registro
-- automatico) e remove acoes_massivas_concluir_envio. Nao toca dado: lotes
-- confirmados continuam confirmados; lotes PENDENTE_ENVIO continuam pendentes
-- e podem ser concluidos pelo acoes_massivas_concluir_lote de sempre.

BEGIN;

DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar') IS DISTINCT FROM '3861da11bfb0930fc698ce8e1ca05a35' THEN
    RAISE EXCEPTION 'Rollback abortado: acoes_massivas_exportar nao esta na versao da migration 20261113100000.';
  END IF;
END $g$;

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar',
$a1$    -- 13/11/2026: o lote nasce PENDENTE_ENVIO. Nada e registrado no aluno aqui;
    -- quem registra e acoes_massivas_concluir_envio, depois do disparo externo.$a1$,
$n1$    v_reg := public.registrar_acao_massiva(v_ok, v_canal, p_arquivo, null, null, v_op, v_lote, v_f);

    update public.acoes_massivas_lotes
       set confirmado_em       = now(),
           confirmado_por_email = v_autor,
           registrados         = coalesce((v_reg ->> 'registrados')::int, 0),
           registro_automatico = true,
           resultado           = (v_reg - 'contatos') || jsonb_build_object('lote_id', v_lote)
     where id = v_lote;$n1$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar',
$a2$    'registro_automatico', false,
    'pendente_envio', v_lote is not null,$a2$,
$n2$    'registro_automatico', v_lote is not null,$n2$, 1);

DROP FUNCTION IF EXISTS public.acoes_massivas_concluir_envio(uuid, text, text[]);
DROP FUNCTION IF EXISTS public.acoes_massivas_lote_destinatarios(uuid);

DO $m$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar') IS DISTINCT FROM 'c9cc7498d16ca250e85c4727c8bb05bd' THEN
    RAISE EXCEPTION 'Rollback nao restaurou o corpo publicado (c9cc7498...).';
  END IF;
END $m$;

COMMIT;
