-- Rollback de 20260908120000_acoes_massivas_varios_status_academicos.
--
-- Desfaz a mesma troca de linha, lendo a definicao viva: o filtro de status
-- academico volta a comparar por igualdade (um status por vez). A assinatura
-- nao muda, entao o front continua chamando normalmente; se dois status
-- estiverem marcados, a tela mandara "A|B" e o banco nao achara ninguem --
-- reverter tambem o front (AcoesMassivas.jsx) para a lista suspensa de um
-- status.

do $rollback$
declare
  v_def    text;
  v_ancora text := '(p_situacao_academica IS NULL OR nullif(btrim(a.situacao_academica),'''') = ANY(string_to_array(p_situacao_academica, ''|'')))';
  v_antiga text := '(p_situacao_academica IS NULL OR nullif(btrim(a.situacao_academica),'''') = p_situacao_academica)';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'acoes_massivas_previa';
  if (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora) <> 1 then
    raise exception 'ancora nao encontrada exatamente uma vez; nada revertido';
  end if;
  execute replace(v_def, v_ancora, v_antiga);
end $rollback$;
