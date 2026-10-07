-- Rollback de supabase/migrations/20261006200000_tv_ranking_semana_valor_no_topo.sql
--
-- Tira `ranking_semana_valor` do TOPO do payload. A chave continua existindo em
-- `payload.dados.ranking_semana_valor` -- este arquivo nao a remove de la.
--
-- EFEITO DE RODAR ISTO: a tela "Destaque da Semana" volta a nao encontrar
-- `snap?.ranking_semana_valor`, cai no fallback `dados.ranking_semana` (que tem
-- `pagos`, nao `valor`) e volta a exibir "Mais pagamentos unicos da semana" --
-- com a janela de calendario, que nao e desfeita aqui.
--
-- Mesma tecnica: patch ancorado, idempotente pelo texto NOVO, ocorrencia unica.

do $$
declare
  v_def text;
  v_n   int;
  c_com_topo constant text := '''dados'', v_dados, ''ranking_semana_valor'', v_dados->''ranking_semana_valor'',';
  c_sem_topo constant text := '''dados'', v_dados,';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';

  if v_def is null then
    raise exception 'tv_snapshot_calcular nao encontrada em public';
  end if;

  if position(c_com_topo in v_def) = 0 then
    raise notice 'ranking_semana_valor nao esta no topo; nada a desfazer';
    return;
  end if;

  v_n := (length(v_def) - length(replace(v_def, c_com_topo, ''))) / length(c_com_topo);
  if v_n <> 1 then
    raise exception 'esperava 1 ocorrencia de "%", encontrei %.', c_com_topo, v_n;
  end if;

  execute replace(v_def, c_com_topo, c_sem_topo);
end $$;
