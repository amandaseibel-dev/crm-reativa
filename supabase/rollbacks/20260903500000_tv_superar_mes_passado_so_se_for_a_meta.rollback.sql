-- ROLLBACK: "Superar o mes passado" volta a aparecer sempre, com o realizado do
-- mes anterior como alvo (e R$ 500.000 quando nao houver mes anterior).
-- ATENCAO: com isto o telao volta a cobrar crescimento que a gestao nao pediu
-- nos meses em que a meta e menor que a do mes anterior.
do $mig$
declare v_def text; v_old text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='tv_snapshot_calcular';

  v_new := $x$union all select 2, public._tv_meta_obj('magic','Superar o mês passado', coalesce(nullif(v_hon_ant,0),500000), v_hon, 'mensal', v_proj_hon, v_du_rest)$x$;
  v_old := $x$union all select 2, public._tv_meta_obj('magic','Superar o mês passado', v_hon_ant, v_hon, 'mensal', v_proj_hon, v_du_rest)
      where coalesce(v_hon_ant,0) > 0 and v_meta_emp >= v_hon_ant$x$;

  if position(v_old in v_def) = 0 then
    raise exception 'linha alvo nao encontrada -- nada a reverter';
  end if;

  execute replace(v_def, v_old, v_new);
end $mig$;
