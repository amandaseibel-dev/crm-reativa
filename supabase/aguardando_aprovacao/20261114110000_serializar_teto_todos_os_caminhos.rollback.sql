-- ROLLBACK da serializacao do teto. Remove exatamente as linhas de lock, com contagem exata
-- (falha se nao achar exatamente uma ocorrencia). O patch_funcao_ancorada nao serve aqui: recusa
-- substituir quando o texto novo contem a ancora.
do $rb$
declare
  v_def text;
  v_lock_assumir text := '  perform pg_advisory_xact_lock(hashtext(''assumir_teto:'' || v_email));' || E'\n';
  v_lock_trig text := '  PERFORM pg_advisory_xact_lock(hashtext(''assumir_teto:'' || lower(v_email)));' || E'\n';
begin
  v_def := pg_get_functiondef('public.assumir_caso_livre(uuid)'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_lock_assumir, ''))) / length(v_lock_assumir) <> 1 then
    raise exception 'rollback: lock de assumir_caso_livre nao encontrado exatamente uma vez';
  end if;
  execute replace(v_def, v_lock_assumir, '');

  v_def := pg_get_functiondef('public.trg_impor_teto_operador()'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_lock_trig, ''))) / length(v_lock_trig) <> 1 then
    raise exception 'rollback: lock de trg_impor_teto_operador nao encontrado exatamente uma vez';
  end if;
  execute replace(v_def, v_lock_trig, '');
end
$rb$;
