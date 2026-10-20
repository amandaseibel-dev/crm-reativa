-- Liberacao extra pontual: +10 abordagens novas para a Fernanda
-- (cobranca04@aelbra.com.br) no numero Comercial, somente em 23/09/2026.
--
-- Por que INSERT e nao a RPC whatsapp_cadencia_liberar_extra: a RPC exige
-- usuario_e_gestao(), que le auth.jwt()->>'email'. Fora da sessao do app nao ha
-- JWT e ela recusa com 42501. O INSERT abaixo grava exatamente o que a RPC
-- gravaria, com concedido_por explicito.
--
-- O limite geral do canal (limite_abordagens_operador = 2) NAO e tocado: a regra
-- continua valendo para todos, so a linha do dia soma o extra para uma pessoa.
-- O teto do canal tambem nao e afetado (o Comercial nem tem um).
--
-- O dia e FIXO, nao now(): se esta migration rodar de novo, ou rodar numa base
-- nova, ela grava um dia passado e nao libera nada no futuro. O canal e buscado
-- por sessao_chave para nao fixar um id gerado.

INSERT INTO public.whatsapp_cadencia_liberacoes
  (canal_id, operador_email, dia, extra, concedido_por, motivo)
SELECT k.id,
       'cobranca04@aelbra.com.br',
       DATE '2026-09-23',
       10,
       'amanda.seibel@aelbra.com.br',
       'Liberacao controlada autorizada por Amanda: +10 abordagens novas no numero Comercial, somente 23/09'
  FROM public.whatsapp_canais k
 WHERE k.sessao_chave = 'comercial'
ON CONFLICT (canal_id, operador_email, dia)
DO UPDATE SET extra         = 10,
              concedido_por = EXCLUDED.concedido_por,
              motivo        = EXCLUDED.motivo;
