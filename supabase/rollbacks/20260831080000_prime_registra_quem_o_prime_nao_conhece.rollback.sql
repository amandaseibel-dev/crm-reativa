-- DESFAZER 20260831080000_prime_registra_quem_o_prime_nao_conhece.sql
--
-- ATENCAO -- desfazer sozinho QUEBRA a coleta. A fila (migration 20260831090000)
-- consulta esta tabela. Apagar a tabela sem antes voltar a fila faz
-- prime_cadastro_pendentes falhar com "relation does not exist", e a Edge
-- Function volta a responder PENDENTES_FALHOU -- a coleta para de novo.
--
-- ORDEM CORRETA para desfazer:
--   1) aplicar supabase/rollbacks/20260831070000_prime_coleta_100_por_cento.rollback.sql
--      (volta a fila ao formato que nao conhece esta tabela)
--   2) so entao aplicar este arquivo
--   3) republicar a Edge Function `prime-cadastro` na versao 10, que nao chama
--      prime_cadastro_registrar_tentativa
--
-- Guarde o conteudo antes de apagar -- e o unico registro de quem o Prime nao
-- conhece, e refaze-lo custa uma varredura inteira na Ulbra.

-- create table public._backup_prime_sem_retorno_20260831 as
--   select * from public.prime_cadastro_sem_retorno;
-- alter table public._backup_prime_sem_retorno_20260831 enable row level security;

drop function if exists public.prime_cadastro_registrar_tentativa(text[], text[], text);
drop table if exists public.prime_cadastro_sem_retorno;
