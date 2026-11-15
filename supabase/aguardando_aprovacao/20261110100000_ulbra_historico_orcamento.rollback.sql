-- ROLLBACK da 20261110100000_ulbra_historico_orcamento
-- ATENÇÃO: a Edge Function ulbra-historico v1 publicada em produção (docs/integracoes/rollback-ulbra-historico-v1/)
-- chama ulbra_historico_reservar e lê ulbra_historico_uso. Executar este arquivo com a v1 no ar quebra a função (RESERVA_FALHOU).
-- Por isso ele é recusado por padrão. Ordem obrigatória:
--   1) retirar a v1 do projeto (supabase functions delete ulbra-historico) ou publicar versão que não chame o orçamento;
--   2) executar dentro de uma transação com a confirmação explícita:
--        begin; set local app.confirma_retirada_ulbra_historico = 'sim'; \i <este arquivo>; commit;
-- Sem a confirmação, o bloco abaixo levanta exceção e nada é removido.
do $$
begin
  if coalesce(current_setting('app.confirma_retirada_ulbra_historico', true), '') <> 'sim' then
    raise exception 'ROLLBACK_BLOQUEADO: retire a Edge Function ulbra-historico antes e confirme com set local app.confirma_retirada_ulbra_historico';
  end if;
end $$;
drop function if exists public.ulbra_historico_reservar(text, date, integer, integer, integer);
drop table if exists public.ulbra_historico_uso;
