-- REABERTURA CONTROLADA. Roda a funcao ja corrigida e registra o resultado.
do $$
declare v_antes int; v_n int; v_depois int;
begin
  select count(*) into v_antes from public.casos where encerrado_operacional = false;
  v_n := public.casos_reabrir_com_divida();
  select count(*) into v_depois from public.casos where encerrado_operacional = false;
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('migracao_20260918000000', 'REABERTURA_CONTROLADA_ACORDO_CANCELADO', 'casos',
          jsonb_build_object('casos_ativos_antes', v_antes, 'reabertos', v_n,
                             'casos_ativos_depois', v_depois, 'em', now()));
  raise notice 'antes=% reabertos=% depois=%', v_antes, v_n, v_depois;
end $$;
