-- ROLLBACK de 20261112235000_acao_massiva_status_na_movimentacao.
-- Desfaz os quatro patches, na ordem inversa, e so age se as duas funcoes ainda
-- tiverem o MD5 final desta migration; senao aborta sem tocar. Ao final exige
-- os MD5 publicados antes dela. Executar em UMA transacao (BEGIN; ... COMMIT;).
-- Movimentacoes ja gravadas com status_novo NAO sao alteradas.

DO $r$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'registrar_acao_massiva') <> 'a7309034dd1e07e27b4164b7c11d91b3' THEN
    RAISE EXCEPTION 'Rollback abortado: registrar_acao_massiva mudou desde a migration. Nada alterado.';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar_emails_do_lote') <> 'a8ca35582ae84e7038417d622e54b693' THEN
    RAISE EXCEPTION 'Rollback abortado: acoes_massivas_exportar_emails_do_lote mudou desde a migration. Nada alterado.';
  END IF;
END $r$;

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$n4$    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, lote_id, status_novo)
  select x.id_txt, 'ACAO_MASSIVA_EXTERNA_EMAIL', v_desc, v_autor_nome, v_autor_email, v_agora, v_lote,
         'Ação massiva externa enviada — aguardando retorno'$n4$,
$a4$    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, lote_id)
  select x.id_txt, 'ACAO_MASSIVA_EXTERNA_EMAIL', v_desc, v_autor_nome, v_autor_email, v_agora, v_lote$a4$, 1);

SELECT internal.patch_funcao_ancorada('public', 'registrar_acao_massiva',
$n3$      values (v_id, v_tipo, v_desc, v_autor_nome, v_autor_email, v_agora, p_lote_id,
              'Ação massiva externa enviada — aguardando retorno')$n3$,
$a3$      values (v_id, v_tipo, v_desc, v_autor_nome, v_autor_email, v_agora, p_lote_id)$a3$, 1);

SELECT internal.patch_funcao_ancorada('public', 'registrar_acao_massiva',
$n2$      values (v_id, v_tipo, v_desc, v_autor_nome, v_autor_email, v_agora, null,
              'Ação massiva externa enviada — aguardando retorno');$n2$,
$a2$      values (v_id, v_tipo, v_desc, v_autor_nome, v_autor_email, v_agora, null);$a2$, 1);

SELECT internal.patch_funcao_ancorada('public', 'registrar_acao_massiva',
$n1$        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, lote_id, status_novo)$n1$,
$a1$        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, lote_id)$a1$, 2);

DO $v$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'registrar_acao_massiva') <> '6eb41bf1dd68fcfb4eb44b9022b43e44' THEN
    RAISE EXCEPTION 'Rollback: registrar_acao_massiva nao voltou ao MD5 publicado (6eb41bf1...).';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'acoes_massivas_exportar_emails_do_lote') <> '00d3370a7800bd334292808e1573a57d' THEN
    RAISE EXCEPTION 'Rollback: acoes_massivas_exportar_emails_do_lote nao voltou ao MD5 publicado (00d3370a...).';
  END IF;
END $v$;
