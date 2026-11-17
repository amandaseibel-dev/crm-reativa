-- ROLLBACK de 20261113100100_acoes_massivas_email_so_apos_tabulacao.
-- ORDEM DE REVERSAO: este rollback so depois do rollback de 20261113100000, e
-- so com zero lotes de WhatsApp pendentes. Com lote pendente, reverter esta
-- migration reabre o B1 (exportacao de e-mail sem a checagem de confirmacao).
-- Remove a guarda de lote pendente e devolve o lote de origem a leitura sem FOR
-- SHARE, reconstruindo o corpo publicado (md5 00d3370a...). Nao toca dado.
--
-- A segunda alteracao e removida por substituicao exata do bloco de guarda na
-- definicao viva (o helper de patch recusa remover texto que e pedaco da ancora).

BEGIN;

-- lock_timeout restrito a ESTA transacao (SET LOCAL). Se a trava de lotes nao
-- for obtida em 5 s, o LOCK falha e a transacao inteira aborta sem alterar nada.
-- Justificativa operacional: a janela de reversao deve ser curta; a espera longa
-- atras de transacao aberta e recusada, e a reversao repete em outra janela.
SET LOCAL lock_timeout = '5s';

DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar_emails_do_lote') IS DISTINCT FROM '1881bd1d0f362be586233264a396fcfd' THEN
    RAISE EXCEPTION 'Rollback abortado: acoes_massivas_exportar_emails_do_lote nao esta na versao da migration 20261113100100.';
  END IF;
  -- A confirmacao (20261113100000) depende desta protecao: se a funcao nova existe, recusa.
  IF to_regprocedure('public.acoes_massivas_concluir_envio(uuid,text,text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback recusado: acoes_massivas_concluir_envio depende desta protecao. Reverta 20261113100000 antes. Nada alterado.';
  END IF;
  -- Condicao de reversao: zero lotes pendentes (estado efetivo).
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

-- 2. remove o bloco de guarda (substituicao exata, uma ocorrencia)
DO $r2$
DECLARE
  v_src text;
  v_guarda text := $guarda$  -- 16/11/2026: lote de WhatsApp ainda PENDENTE de envio nao deriva e-mail.
  -- Vale para qualquer chamador. Quem confirma e acoes_massivas_concluir_envio.
  if v_origem.confirmado_em is null then
    raise exception 'Este lote de WhatsApp ainda esta pendente de envio. Tabule o envio antes de exportar os e-mails.'
      using errcode = '55000';
  end if;

$guarda$;
  v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar_emails_do_lote' LIMIT 1;
  v_n := (length(v_src) - length(replace(v_src, v_guarda, ''))) / length(v_guarda);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Rollback abortado: bloco de guarda encontrado % vez(es), esperado 1.', v_n;
  END IF;
  EXECUTE replace(v_src, v_guarda, '');
END $r2$;

-- 1. volta o FOR SHARE da leitura do lote de origem
SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$n1$  select * into v_origem from public.acoes_massivas_lotes where id = p_lote_id for share;$n1$,
$a1$  select * into v_origem from public.acoes_massivas_lotes where id = p_lote_id;$a1$, 1);

DO $f$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar_emails_do_lote') IS DISTINCT FROM '00d3370a7800bd334292808e1573a57d' THEN
    RAISE EXCEPTION 'Rollback: acoes_massivas_exportar_emails_do_lote nao voltou ao corpo publicado.';
  END IF;
END $f$;

COMMIT;
