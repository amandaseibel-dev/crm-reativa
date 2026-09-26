-- ============================================================================
-- TV: "Superar o mes passado" so vai ao telao quando crescer for o plano
-- ----------------------------------------------------------------------------
-- Amanda, 03/09/2026: "superar agosto e impossivel".
--
-- A TV mostrava tres metas. A segunda, id 'magic', tinha como alvo o REALIZADO
-- do mes anterior:
--     public._tv_meta_obj('magic','Superar o mes passado',
--                         coalesce(nullif(v_hon_ant,0),500000), ...)
-- Sempre que a meta do mes fica ABAIXO do mes anterior, isso poe no mural um
-- objetivo maior que a propria meta da empresa, marcado "Abaixo do ritmo"
-- desde o dia 1 e o mes inteiro. Em setembro: meta R$ 280.000 contra R$ 314.165
-- de agosto, pedindo R$ 16.227/dia util quando a meta pede R$ 14.429.
-- Nao e um numero errado -- e a regra: o telao cobrava crescimento que a gestao
-- nao pediu.
--
-- Passa a aparecer so quando meta_honorario do mes >= realizado do mes anterior,
-- ou seja, quando a gestao decidiu crescer. Nos outros meses a TV mostra "Meta
-- da empresa" e "Marco historico". O fallback de R$ 500.000 sai junto: ele era
-- um alvo arbitrario para quando nao havia mes anterior.
--
-- Aplicada por substituicao cirurgica sobre pg_get_functiondef, e nao
-- reescrevendo tv_snapshot_calcular() inteira: producao ja divergiu do
-- repositorio nesta funcao (o repo ainda registra 'Magic Number', 500000, em
-- 20260811200000). Reescrever pelo texto do repo apagaria a versao de producao.
-- A migration ABORTA se nao achar a linha exata -- nunca aplica no escuro.
-- Reversivel: supabase/rollbacks/20260903500000_*.rollback.sql
-- ============================================================================

do $mig$
declare v_def text; v_old text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='tv_snapshot_calcular';

  v_old := $x$union all select 2, public._tv_meta_obj('magic','Superar o mês passado', coalesce(nullif(v_hon_ant,0),500000), v_hon, 'mensal', v_proj_hon, v_du_rest)$x$;
  v_new := $x$union all select 2, public._tv_meta_obj('magic','Superar o mês passado', v_hon_ant, v_hon, 'mensal', v_proj_hon, v_du_rest)
      where coalesce(v_hon_ant,0) > 0 and v_meta_emp >= v_hon_ant$x$;

  if position(v_old in v_def) = 0 then
    raise exception 'linha alvo nao encontrada em tv_snapshot_calcular -- producao mudou, abortar';
  end if;

  execute replace(v_def, v_old, v_new);
end $mig$;
