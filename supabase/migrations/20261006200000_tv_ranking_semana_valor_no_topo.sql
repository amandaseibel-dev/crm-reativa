-- `ranking_semana_valor` PRECISA ESTAR NO TOPO DO PAYLOAD.
--
-- DEFEITO DA MIGRATION ANTERIOR (20261006110000, aplicada em producao como
-- 20261006192635). Ela inseriu o indicador usando a ancora `'ranking_mes',` --
-- e esse `ranking_mes` vive DENTRO do sub-objeto `v_dados`. Resultado: a chave
-- nasceu em `payload.dados.ranking_semana_valor`.
--
-- So que a tela le o TOPO:
--
--   const semana = snap?.ranking_semana_valor || snap?.dados?.ranking_semana || [];
--
-- Com a chave so em `dados`, `snap?.ranking_semana_valor` e undefined, a tela
-- cai no fallback `dados.ranking_semana` (que tem `pagos`, nao `valor`) e
-- continua exibindo "Mais pagamentos unicos da semana". Ou seja: o indicador
-- passou a ser calculado, com a janela certa, e mesmo assim nao chega na tela.
--
-- O CALCULO ESTA CORRETO e nao se mexe nele. Conferido em producao logo apos a
-- aplicacao: 8 operadores, semana de calendario, maior JOAO com 18.690. O que
-- falta e so a POSICAO da chave.
--
-- CORRECAO MINIMA: promover ao topo a chave que `v_dados` ja carrega, sem
-- recalcular nada:
--
--   'dados', v_dados,  ->  'dados', v_dados, 'ranking_semana_valor', v_dados->'ranking_semana_valor',
--
-- A chave segue existindo em `dados` tambem -- nao removo de la para nao mudar
-- nada que ja leia por aquele caminho.
--
-- NAO TOCA em janela, operadores, limite, ordenacao nem em qualquer outro
-- indicador. Uma unica insercao no `jsonb_build_object` do `return`.
--
-- PATCH ANCORADO, idempotente pelo texto NOVO, exigindo ocorrencia unica --
-- mesma tecnica da anterior, agora com a ancora no nivel certo.
--
-- Rollback: supabase/rollbacks/20261006200000_tv_ranking_semana_valor_no_topo.rollback.sql

do $$
declare
  v_def text;
  v_n   int;
  c_ancora constant text := '''dados'', v_dados,';
  c_troca  constant text := '''dados'', v_dados, ''ranking_semana_valor'', v_dados->''ranking_semana_valor'',';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';

  if v_def is null then
    raise exception 'tv_snapshot_calcular nao encontrada em public';
  end if;

  -- A chave tem de existir em `dados` para haver o que promover.
  if position('''ranking_semana_valor''' in v_def) = 0 then
    raise exception
      'ranking_semana_valor nao existe na funcao -- aplique antes a migration '
      '20261006110000_tv_maior_valor_semana_calendario.sql';
  end if;

  -- IDEMPOTENCIA PELO TEXTO NOVO.
  if position(c_troca in v_def) > 0 then
    raise notice 'ranking_semana_valor ja esta no topo; nada a fazer';
    return;
  end if;

  v_n := (length(v_def) - length(replace(v_def, c_ancora, ''))) / length(c_ancora);
  if v_n <> 1 then
    raise exception 'esperava 1 ocorrencia de "%", encontrei %. O corpo mudou.', c_ancora, v_n;
  end if;

  execute replace(v_def, c_ancora, c_troca);
end $$;
