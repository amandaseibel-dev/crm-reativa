-- Rollback de 20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.
--
-- DECISÃO (opção A, registrada no pacote): este rollback NÃO remove nada. Recusa sempre.
-- Motivo: as duas linhas do catálogo são lidas pela barreira de estado em alunos
-- (_encerramento_so_gestao, em produção). Removê-las reabriria a gravação de TERMO_* no
-- estado do aluno pelo operador. Reverter é correção para frente, com decisão e migração próprias.
BEGIN;
do $$
begin
  raise exception 'rollback recusado por decisão registrada: as linhas do catálogo são lidas pela barreira de estado em alunos. Nada foi alterado nem removido. Reverter é correção para frente, com decisão e migração próprias.';
end $$;
COMMIT;
