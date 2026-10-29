-- A Prime devolve o HISTÓRICO DE VERSÕES do contrato: a mesma janela aparece
-- várias vezes, quase sempre com N "Anulado" e um "Confirmado" ou "Aberto".
-- Medido em 400 alunos: 2.751 registros para 977 janelas reais.
--
-- Sem uma regra de força, o upsert deixa valer o ÚLTIMO que chegou -- e a ficha
-- passaria a dizer "Anulado" para quem está matriculado. Foi o que aconteceu na
-- primeira coleta.
--
-- Ordem de força:
--   Confirmado (matrícula fechada) > Aberto (iniciada, não confirmada)
--   > Cancelado (houve e caiu) > Anulado (versão descartada do contrato)
--
-- APLICADA EM PROD em 2026-08-25.

create or replace function public.prime_contrato_prioridade(p_status text)
returns integer
language sql
immutable
as $function$
  select case p_status
    when 'Confirmado' then 4
    when 'Aberto'     then 3
    when 'Cancelado'  then 2
    when 'Anulado'    then 1
    else 0
  end;
$function$;

-- `prime_cadastro_aplicar` passa a ordenar os contratos do mais fraco para o
-- mais forte e a só sobrescrever quando o novo status é ao menos tão forte
-- quanto o gravado. Corpo completo aplicado em prod na migration de mesmo nome;
-- a definição vigente está no banco.
