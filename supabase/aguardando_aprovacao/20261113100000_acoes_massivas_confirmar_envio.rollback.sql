-- ROLLBACK de 20261113100000_acoes_massivas_confirmar_envio.
-- Volta acoes_massivas_exportar ao corpo publicado (c9cc7498..., registro
-- automatico) e remove acoes_massivas_concluir_envio. Nao toca dado: lotes
-- confirmados continuam confirmados; lotes PENDENTE_ENVIO continuam pendentes
-- e podem ser concluidos pelo acoes_massivas_concluir_lote de sempre.

BEGIN;

-- lock_timeout restrito a ESTA transacao (SET LOCAL). Se a trava de lotes nao
-- for obtida em 5 s, o LOCK falha e a transacao inteira aborta sem alterar nada.
-- Justificativa operacional: a janela de reversao deve ser curta; a espera longa
-- atras de transacao aberta e recusada, e a reversao repete em outra janela.
SET LOCAL lock_timeout = '5s';

DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar') IS DISTINCT FROM '3861da11bfb0930fc698ce8e1ca05a35' THEN
    RAISE EXCEPTION 'Rollback abortado: acoes_massivas_exportar nao esta na versao da migration 20261113100000.';
  END IF;
  -- Condicao de reversao: zero lotes pendentes (estado efetivo, nao marca).
  -- Trava de tabela ANTES da checagem: serializa com a exportacao (que insere lote).
  LOCK TABLE public.acoes_massivas_lotes IN SHARE ROW EXCLUSIVE MODE;
  -- Sessao em andamento que executa as funcoes de exportacao (ativa ou
  -- ociosa dentro de transacao) recusa a reversao: ela pode inserir lote apos a
  -- checagem. Verificado no estado efetivo (pg_stat_activity), na mesma transacao.
  IF EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND state IS DISTINCT FROM 'idle'
                AND query ILIKE '%acoes_massivas_exportar%') THEN
    RAISE EXCEPTION 'Rollback recusado: ha sessao em andamento executando a exportacao de acao massiva. Pausar chamadas e aguardar o termino. Nada alterado.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.acoes_massivas_lotes WHERE confirmado_em IS NULL AND descartado_em IS NULL) THEN
    RAISE EXCEPTION 'Rollback recusado: ha lotes de WhatsApp/e-mail pendentes de envio. Nada alterado.';
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
