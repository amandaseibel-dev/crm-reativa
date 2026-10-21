-- ROLLBACK de 20261021215000_fluxo_incremental_espera_nao_exclui.sql
--
-- O QUE REVERTER REINTRODUZ, EM LETRAS MAIÚSCULAS:
--
--   A ESPERA VOLTA A SER EXCLUSÃO, E COM ELA O RISCO DE INANIÇÃO. Medido em
--   21/10/2026: 365 de 386 pendentes ficariam FORA da fila da automação, e a
--   retenção não expirava de forma confiável, porque o gatilho
--   `trg_fila_pagamento_tentativa` reescreve `ultima_tentativa_em := now()` em
--   QUALQUER update da linha pendente -- inclusive os de um lote de importação,
--   que tocou 385 linhas no mesmo instante.
--
--   Reverter, portanto, devolve o estado em que a gestão importar um arquivo
--   por dia bastava para a janela de 24h nunca abrir.
--
-- COMO REVERTER: este rollback NÃO é um script -- é uma instrução, porque
-- reverter significa voltar a função ao corpo anterior, e esse corpo é o
-- arquivo da migration que o criou.
--
--   Reaplique, na íntegra e sem editar:
--     supabase/migrations/20261021210416_fluxo_incremental_previa_sem_escrita.sql
--
--   Aquele arquivo é `create or replace` da MESMA função, com a MESMA
--   assinatura, e tem igualdade byte a byte provada com o que foi aplicado
--   (md5 492ef3472700092f307297b5ef90b181, 11.703 bytes).
--
-- NÃO use `drop function`: removeria a rodada inteira em vez de reverter esta
-- mudança, e quebraria os jobs de cron caso já estejam agendados.
--
-- ZERO DML nos dois sentidos.

do $$
begin
  raise exception
    'ROLLBACK MANUAL: reaplique supabase/migrations/20261021210416_fluxo_incremental_previa_sem_escrita.sql na integra. Ler o cabecalho deste arquivo antes -- reverter reintroduz a inanicao de 365 de 386 pendentes.';
end $$;
