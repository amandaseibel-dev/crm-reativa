-- Rollback de 20260826070000_movimento_entrada_nao_conta_renegociacao.sql
--
-- Reaplique 20260826060000 para voltar a versao que somava TODO acordo
-- importado como entrada. NAO E RECOMENDADO: aquela versao inflava o "entrou"
-- de agosto em quase o dobro (R$ 2,16 mi de renegociacao contados como divida
-- nova) e entregava um resultado falsamente preciso.
--
-- Se o problema for so a faixa incomodar quem le, prefira ajustar a TELA para
-- mostrar o `resultado_max` em destaque e o minimo como nota -- em vez de
-- voltar a um numero unico que esta errado.

\echo 'Reaplique supabase/migrations/20260826060000_saude_carteira_movimento_periodo.sql'
