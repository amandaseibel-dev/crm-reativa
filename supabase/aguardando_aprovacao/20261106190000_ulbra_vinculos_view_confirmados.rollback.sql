-- ============================================================================
-- ROLLBACK da view ulbra_vinculos_confirmados (20261106190000)
--
-- NAO EXECUTADO. A propria view tambem NAO foi aplicada -- este par existe
-- desde o inicio, nao depois do susto.
--
-- O que se perde ao reverter: NADA de dado. A view e derivada; nenhuma linha
-- mora nela. O que volta a valer e a situacao anterior: quem precisar de
-- vinculo confirmado filtra `confianca = 'alta_cpf'` no codigo, como
-- supabase/functions/ulbra-atendimento/atendimento.ts ja faz desde a #819.
--
-- O que este arquivo NAO desfaz, de proposito: nada da version 20261106151254
-- (CHECKs, indice unico de cliente, gatilho, REVOKEs, tabelas de snapshot). A
-- reversa daquela versao e outro arquivo:
-- 20261104200000_ulbra_vinculos_confianca_e_unicidade.rollback.sql.
-- ============================================================================

begin;

set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Guarda: se alguma funcao do banco tiver passado a depender da view, derrubar
-- a view em silencio quebraria essa funcao na proxima chamada. `restrict` (o
-- padrao) recusa justamente nesse caso -- e a recusa aqui e o comportamento
-- desejado, nao um obstaculo. NUNCA trocar por `cascade`.
drop view if exists public.ulbra_vinculos_confirmados restrict;

-- ----------------------------------------------------------------------------
-- PROVA DA REVERSA
-- ----------------------------------------------------------------------------
do $prova$
begin
  if to_regclass('public.ulbra_vinculos_confirmados') is not null then
    raise exception 'ROLLBACK: a view ainda existe';
  end if;

  -- A tabela base tem de sair ILESA: a reversa da view nao e a reversa da
  -- 20261106151254.
  if to_regclass('public.ulbra_vinculos') is null then
    raise exception 'ROLLBACK: a tabela base desapareceu -- isto nunca deveria acontecer';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ulbra_vinculos'::regclass
       and conname = 'ulbra_vinculos_alta_cpf_exige_origem_forte'
  ) then
    raise exception 'ROLLBACK: levou um CHECK da 20261106151254 junto';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_ulbra_vinculo_protege_historico' and not tgisinternal
  ) then
    raise exception 'ROLLBACK: levou o gatilho de protecao junto';
  end if;
  if has_table_privilege('authenticated','public.ulbra_vinculos','DELETE')
     or has_table_privilege('authenticated','public.ulbra_vinculos','TRUNCATE') then
    raise exception 'ROLLBACK: desfez os REVOKE da 20261106151254';
  end if;
  if (select count(*) from pg_policies
       where schemaname='public' and tablename='ulbra_vinculos') <> 3 then
    raise exception 'ROLLBACK: o numero de policies de ulbra_vinculos mudou (eram 3)';
  end if;
end $prova$;

commit;
