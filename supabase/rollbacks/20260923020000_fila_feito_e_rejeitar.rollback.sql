-- ROLLBACK de 20260923020000_fila_feito_e_rejeitar
--
-- Remove as duas acoes e volta a fila ao estado de 23/09/2026, quando havia so
-- `conciliacao_encerrar`.
--
-- NADA FINANCEIRO E DESFEITO, porque nada financeiro foi feito: as duas RPCs so
-- escrevem a decisao da fila e a auditoria. Pagamento, parcela, acordo e saldo
-- nunca foram tocados por elas.
--
-- ATENCAO -- ORDEM E PERDA DE DADO. Linhas ja decididas como FEITO/REJEITADO
-- violariam a restricao antiga de `decisao`. Este rollback NAO as apaga e NAO
-- as reabre: converte-as para `ENCERRADO_GESTAO`, que e o encerramento
-- equivalente que existia antes, preservando quem decidiu, quando e a
-- observacao (que ja carrega a conclusao/motivo por extenso).
--
-- O que se perde e a CATEGORIA estruturada (`conclusao` / `motivo_rejeicao`),
-- porque as colunas somem. O texto continua na `observacao` e o registro
-- completo continua na `auditoria` (`CONCILIACAO_FEITO_PELA_GESTAO` e
-- `CONCILIACAO_REJEITADA_PELA_GESTAO`), que este rollback nao toca. Para ter a
-- categoria em coluna, exporte antes:
--
--   select pagamento_id, decisao, conclusao, motivo_rejeicao, decidido_por,
--          decidido_em, observacao
--     from public.fila_pagamento_sem_vinculo
--    where decisao in ('FEITO','REJEITADO');

drop function if exists public.conciliacao_feito(uuid, text, text);
drop function if exists public.conciliacao_rejeitar(uuid, text, text);

-- a coerencia sai primeiro: ela referencia as colunas que serao removidas
alter table public.fila_pagamento_sem_vinculo
  drop constraint if exists fila_pag_decisao_coerente;

update public.fila_pagamento_sem_vinculo
   set decisao = 'ENCERRADO_GESTAO'
 where decisao in ('FEITO','REJEITADO');

alter table public.fila_pagamento_sem_vinculo
  drop constraint if exists fila_pag_conclusao_valida,
  drop constraint if exists fila_pag_motivo_rejeicao_valido,
  drop column if exists conclusao,
  drop column if exists motivo_rejeicao;

alter table public.fila_pagamento_sem_vinculo
  drop constraint if exists fila_pagamento_sem_vinculo_decisao_check;
alter table public.fila_pagamento_sem_vinculo
  add constraint fila_pagamento_sem_vinculo_decisao_check check (
    decisao is null or decisao = any (array[
      'VINCULADO','DESCARTADO','AGUARDANDO_TERCEIRO',
      'RESOLVIDO_AUTOMATICO','ENCERRADO_GESTAO']));
