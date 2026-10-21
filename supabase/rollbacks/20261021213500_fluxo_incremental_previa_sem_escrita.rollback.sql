-- ROLLBACK de 20261021213500_fluxo_incremental_previa_sem_escrita.sql
--
-- O QUE REVERTER REINTRODUZ, EM LETRAS MAIÚSCULAS:
--
--   A PRÉVIA VOLTA A DEPENDER DE O MOTOR NÃO ESCREVER, em vez de o banco
--   desfazer. `pagamento_conciliar_um` tem CINCO caminhos de escrita; o quinto
--   (`insert into public.fila_pagamento_sem_vinculo`) NÃO foi provado estar
--   atrás da guarda de `p_aplicar`, e gatilhos podem escrever por efeito
--   indireto sem que nenhuma leitura de corpo de função perceba.
--
--   Reverter, portanto, devolve o risco de uma prévia escrever no banco.
--
-- COMO REVERTER: este rollback NÃO é um script -- é uma instrução, porque
-- reverter significa voltar a função ao corpo anterior, e esse corpo é o
-- arquivo da migration que a criou.
--
--   Reaplique, na íntegra e sem editar:
--     supabase/migrations/20261021195950_fluxo_pagamentos_incremental.sql
--
--   Aquele arquivo é `create or replace` da MESMA função, com a MESMA
--   assinatura, e tem igualdade byte a byte provada com o que está em produção
--   (md5 eceb1fcf3697607541b6ec4eae8496f1, 15.569 bytes). Reaplicá-lo devolve
--   exatamente o comportamento anterior, inclusive o campo de retorno
--   `previa_revertida`, que deixa de existir.
--
-- NÃO use `drop function`: isso removeria a rodada inteira em vez de reverter
-- esta mudança, e quebraria o cron caso ele já esteja agendado.
--
-- ZERO DML nos dois sentidos: nenhuma linha de dado a reverter.

do $$
begin
  raise exception
    'ROLLBACK MANUAL: reaplique supabase/migrations/20261021195950_fluxo_pagamentos_incremental.sql na integra para voltar a funcao ao corpo anterior. Ler o cabecalho deste arquivo antes.';
end $$;
