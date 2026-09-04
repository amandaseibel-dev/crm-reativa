-- Volta "Mensagem enviada" para 7 dias uteis (valor da 20260902190000).
-- Nao mexe em nenhum data_retorno ja gravado: a regua so vale na proxima
-- tabulacao.
update public.tabulacoes
   set retorno_modo       = 'DIAS_UTEIS',
       retorno_dias_uteis = 7,
       atualizado_em      = now(),
       atualizado_por     = 'amanda.seibel@aelbra.com.br'
 where codigo = 'MENSAGEM_ENVIADA';
