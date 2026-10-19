-- ROLLBACK de 20261019201558_acoes_massivas_painel_registro.
--
-- Remove a funcao de leitura que alimenta o painel "Registro das acoes
-- massivas". Nao desfaz dado: a funcao nunca escreveu nada -- ela so le
-- `acoes_massivas_lotes`, que segue intacta, com todos os lotes e resultados.
--
-- A tela sobrevive a este rollback: `carregarLotesRegistro` cai em
-- `acoes_massivas_lotes_pendentes` quando esta funcao nao responde, e o painel
-- volta a mostrar so os pendentes -- exatamente o comportamento anterior.
--
-- Quem registra acao massiva NAO e tocado aqui: segue
-- `acoes_massivas_exportar` (automatico, desde 20261002094233) e
-- `acoes_massivas_concluir_lote` (manual).

drop function if exists public.acoes_massivas_lotes_registro(integer);
