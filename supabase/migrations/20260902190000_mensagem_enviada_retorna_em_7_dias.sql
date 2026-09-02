-- "Mensagem enviada" passa a agendar o retorno em 7 dias uteis (era 2).
--
-- Amanda, 02/09: "mensagem enviada deixe 7 dias".
--
-- A tabulacao MENSAGEM_ENVIADA e o que o operador marca depois de disparar
-- mensagem ao aluno. Com 2 dias uteis o caso voltava para a fila antes de o
-- aluno ter tido tempo de responder.
--
-- Aplicado em prod por UPDATE direto, e nao por `tabulacao_salvar`: aquele RPC
-- exige `auth.jwt()->>'email'` da Amanda e a conexao administrativa nao carrega
-- JWT. O UPDATE repete o que o RPC faria, inclusive `atualizado_por`.
--
-- Isto NAO e a escada de criticidade (8 urgente / 9 critico / 10 perdendo
-- caso) que a Amanda pediu na mesma frase -- aquilo mexe no motor de score em
-- `calibragem_parametros.criticidade_regras` e ficou para decisao separada.

update public.tabulacoes
   set retorno_modo       = 'DIAS_UTEIS',
       retorno_dias_uteis = 7,
       atualizado_em      = now(),
       atualizado_por     = 'amanda.seibel@aelbra.com.br'
 where codigo = 'MENSAGEM_ENVIADA';
