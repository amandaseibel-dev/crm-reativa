-- ROLLBACK de 20261106120000_tabulacao_retorno_financeiro
--
-- DESATIVAR, NUNCA DELETE. Regra da casa desde 17/08/2026: excluir tabulação
-- é `ativa = false`. `aluno_movimentacoes.status_novo` guarda o histórico por
-- CÓDIGO, e a ficha do aluno pode já estar com `RETORNO_FINANCEIRO` gravado --
-- um DELETE apagaria a chave que explica o histórico, e o <select> trocaria a
-- tabulação do aluno sozinho.
--
-- O DELETE abaixo fica comentado de propósito, e só vale se NINGUÉM tiver
-- tabulado o código ainda. O comando que o vigia libera é o UPDATE.

begin;

update public.tabulacoes
   set ativa = false,
       desativada_em = now(),
       desativada_por = 'rollback 20261106120000'
 where codigo = 'RETORNO_FINANCEIRO';

-- Só se quiser remover a linha de vez, E só com zero uso. Confira primeiro:
--
--   select count(*) from public.aluno_movimentacoes where status_novo = 'RETORNO_FINANCEIRO';
--   select count(*) from public.alunos where status_jornada = 'RETORNO_FINANCEIRO';
--
-- Com as duas contagens em zero:
--
-- delete from public.tabulacoes where codigo = 'RETORNO_FINANCEIRO';

commit;
