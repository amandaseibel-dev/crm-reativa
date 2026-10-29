-- "Mensagem enviada" agenda o retorno em 5 dias uteis (uma semana corrida),
-- e nao mais em 7.
--
-- Amanda, 04/09/2026: "o botao funcionar e os prazos serem justificados" --
-- uma regra so para o botao rapido, o modal da Carteira, a ficha e o e-mail,
-- e um prazo que fecha com o resto do sistema:
--   * a fidelizacao solta o caso para o pool quando o ultimo acionamento tem
--     mais de 10 dias corridos (cron fidelizacao_liberar_vencidos, todo dia
--     as 05:20). Com 7 dias UTEIS, quem tabula na quinta ou na sexta tem o
--     retorno caindo no 11o dia: o caso ja foi embora antes de o operador
--     voltar nele;
--   * 5 dias uteis = a mesma data da semana seguinte = 7 dias corridos, sempre
--     em dia util, dentro da janela dos 10 dias e do rotulo "Dentro do prazo"
--     (ate 7 dias) da carteira. E o "deixe 7 dias" de 02/09, contado do jeito
--     que a operacao conta.
--
-- Ate esta entrega NENHUMA tela lia o catalogo: o modal usava 2 dias uteis
-- fixos no codigo e o botao rapido nao agendava retorno (o caso voltava no
-- dia seguinte). O valor so passa a valer com o frontend desta mesma entrega
-- (src/utils/tabulacoes.js). Mesmo caminho da 20260902190000: UPDATE direto,
-- porque `tabulacao_salvar` exige o JWT da Amanda.

update public.tabulacoes
   set retorno_modo       = 'DIAS_UTEIS',
       retorno_dias_uteis = 5,
       atualizado_em      = now(),
       atualizado_por     = 'amanda.seibel@aelbra.com.br'
 where codigo = 'MENSAGEM_ENVIADA';
