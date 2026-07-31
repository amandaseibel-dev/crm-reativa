-- Trava fisica: acordo de importacao unico por (aluno, valor, qtd, lote).
-- Torna a duplicacao IMPOSSIVEL. importar_acordos ganha advisory lock por lote
-- (serializa chunks) + ON CONFLICT DO NOTHING na criacao de acordos.
-- (Corpo completo de importar_acordos aplicado via apply_migration em prod:
--  ver guard_unico_acordos_importacao.)
create unique index if not exists ux_acordos_import_dedupe
on public.acordos (aluno_id, round(valor_total,2), qtd_parcelas, (substring(observacao from 'lote ([0-9a-f-]{36})')))
where criado_por_email='importacao@sistema' and substring(observacao from 'lote ([0-9a-f-]{36})') is not null;
