-- ROLLBACK de 20261006160000_acoes_massivas_email_do_lote_whatsapp.
--
-- Derruba SO o que aquela migration criou de novo:
--   * as tres funcoes novas;
--   * a coluna `lote_origem_id` (e a FK/indice dela).
--
-- O QUE NAO E DESFEITO, DE PROPOSITO:
--   * `registrados` e `registro_automatico` -- sao colunas da regra de 02/10,
--     a migration so as garantia com `if not exists`; derrubar aqui apagaria
--     dado de outra regra;
--   * o indice `ux_aluno_mov_lote_aluno` -- e a trava de idempotencia do
--     registro por lote, usada pelo fluxo normal de exportacao;
--   * os LOTES de e-mail e as MOVIMENTACOES ja gravados. Aquilo e historico de
--     acao realizada: nao se apaga em rollback de codigo. Os lotes derivados
--     ficam com `lote_origem_id` perdido na queda da coluna -- o vinculo
--     continua legivel em `filtros->>'lote_origem_id'`, que e gravado junto.

drop function if exists public.acoes_massivas_exportar_emails_do_lote(uuid, text);
drop function if exists public.acoes_massivas_lotes_whatsapp(integer);
drop function if exists public.email_valido_para_acao_massiva(text);

drop index if exists public.ix_amlotes_origem;

alter table public.acoes_massivas_lotes
  drop constraint if exists acoes_massivas_lotes_origem_fk;

alter table public.acoes_massivas_lotes
  drop column if exists lote_origem_id;
