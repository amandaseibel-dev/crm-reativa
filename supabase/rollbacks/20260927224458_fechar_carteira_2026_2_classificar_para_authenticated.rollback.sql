-- ROLLBACK de 20260927224458.
--
-- REABRE A EXPOSICAO. Devolve a `authenticated` o EXECUTE em
-- carteira_2026_2_classificar(), que e SECURITY DEFINER, nao tem portao de
-- permissao e devolve CPF SEM MASCARA -- qualquer usuario logado volta a poder
-- ler a carteira inteira de 2026/2 pelo PostgREST.
--
-- NAO EXECUTAR sem motivo escrito e aprovado. Nenhuma tela depende deste
-- grant: as duas RPCs publicas chamam o classificador como `postgres`, pela
-- cadeia SECURITY DEFINER. Foi VALIDADO em producao em 27/09/2026, depois da
-- revogacao, que painel e detalhe seguem respondendo 200 com os mesmos totais.
--
-- Se o objetivo for dar acesso de leitura a mais alguem, o caminho certo e o
-- portao carteira_2026_1_pode_ler(), nao reabrir o classificador.

grant execute on function public.carteira_2026_2_classificar() to authenticated;
