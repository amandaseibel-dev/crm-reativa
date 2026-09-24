-- `prime_portador_membro` passa a aceitar o portador 202 (REATIVA COBRANCA
-- JUDICIAL), alem de 166 e 195.
--
-- POR QUE. A coleta do 202 foi disparada em 24/09/2026 e a Edge FUNCIONOU --
-- consultou a API e trouxe alunos -- mas a gravacao morreu em
-- `prime_portador_membro_nosso`, um CHECK que so admitia [166, 195]:
--   500 GRAVACAO_FALHOU: new row violates check constraint
--       "prime_portador_membro_nosso"
-- A tabela nasceu para as duas carteiras da Reativa; o judicial nunca foi
-- coletado, entao nunca precisou caber aqui.
--
-- A LISTA CONTINUA FECHADA, de proposito: [166, 195, 202] e nao "qualquer
-- portador". Sao 124 portadores na Prime e a tabela existe para os que o CRM
-- sabe interpretar.
--
-- O nome `_nosso` ficou impreciso (o 202 e judicial, nao e carteira da
-- Reativa); preservado para nao quebrar referencias -- o que vale e a lista.
--
-- Nao altera dado: a tabela nao tinha linha de 202. Nao toca titulos, saldos,
-- acordos nem filas.

alter table public.prime_portador_membro
  drop constraint if exists prime_portador_membro_nosso;

alter table public.prime_portador_membro
  add constraint prime_portador_membro_nosso
  check (portador = any (array[166, 195, 202]));
