-- DESFAZER 20260831190000_quitar_encerrar_recalcula_por_ultimo.sql
--
-- ATENCAO: desfazer faz o aluno voltar a aparecer QUITADO DEVENDO depois de uma
-- quitacao -- o recalculo volta a acontecer no meio do processo, gravando saldo
-- velho. Foi a queixa da Amanda em 31/08.

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='quitar_e_encerrar_caso';

  v_novo := regexp_replace(v_def,
    E'\\n[^\\n]*-- RECALCULO POR ULTIMO[^\\n]*\\n[^\\n]*recalcular_situacao_aluno[^\\n]*\\n\\n', E'\\n', 'n');

  if v_novo = v_def then
    raise exception 'nada a desfazer -- a funcao nao esta na versao corrigida';
  end if;
  execute v_novo;
end $do$;
