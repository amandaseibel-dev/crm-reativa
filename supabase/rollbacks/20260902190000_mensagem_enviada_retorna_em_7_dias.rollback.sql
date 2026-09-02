-- Desfaz 20260902190000_mensagem_enviada_retorna_em_7_dias.sql
-- Volta "Mensagem enviada" para 2 dias uteis, como estava desde o seed de 17/08.

update public.tabulacoes
   set retorno_modo       = 'DIAS_UTEIS',
       retorno_dias_uteis = 2,
       atualizado_em      = now(),
       atualizado_por     = 'rollback'
 where codigo = 'MENSAGEM_ENVIADA';
