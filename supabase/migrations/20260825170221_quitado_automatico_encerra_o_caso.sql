-- Quitação automática também encerra o caso.
--
-- Medido em prod 2026-08-25. A função `caso_encerrado_operacional` decide se um
-- caso sai da carteira e das filas. Ela tem uma lista fechada de status que
-- contam como quitação:
--
--   PAGO · QUITADO · QUITACAO · QUITADO MANUAL · SEM SALDO EM ABERTO
--
-- `QUITADO_AUTOMATICO` não está nela. `normalizar_status_acionamento` devolve
-- 'QUITADO AUTOMATICO' e nenhum item da lista casa. Resultado: o caso quitado
-- pela rotina automática só sai da operação se ALGUM OUTRO campo (status_atual,
-- status_acionamento ou status_jornada) carregar, por acaso, um status de
-- encerramento. Quando nenhum carrega, o caso fica preso.
--
-- Na base: 9 casos com status_financeiro = 'QUITADO_AUTOMATICO'. 6 escaparam
-- por outro campo; 3 continuam na carteira com saldo zero e dívida real zero.
-- Um deles aparece como "MENSAGEM ENVIADA" na fila do cobranca11 -- ou seja,
-- alguém sendo cobrado por uma dívida que não existe mais. O volume é pequeno
-- hoje, mas cresce sozinho a cada rodada da quitação automática.
--
-- A proteção de saldo continua a mesma dos outros status: só encerra se
-- `saldo_titulos_aberto(cpf) = 0`. Quitação automática com saldo em aberto NÃO
-- tira o caso da operação -- exatamente como já vale para PAGO e QUITADO.
--
-- Alcance simulado antes de aplicar: 3 casos passam a sair, 0 voltam a entrar,
-- R$ 0,00 de saldo deixa a carteira. Nenhum caso com dívida é afetado.
--
-- Rollback: supabase/rollbacks/20260826010000_quitado_automatico_encerra_o_caso.rollback.sql

create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text,
  p_status_financeiro text, p_status_jornada text
)
returns boolean language plpgsql stable set search_path to 'public' as $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  -- 'QUITADO AUTOMATICO' entra aqui: mesma família de PAGO/QUITADO, mesma
  -- exigência de saldo zero logo abaixo.
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

comment on function public.caso_encerrado_operacional(text, text, text, text, text) is
  'Caso encerrado para a operação: status de bloqueio, saldo zero confirmado, ou status de quitação COM saldo de títulos zerado. Inclui QUITADO AUTOMATICO desde 2026-08-26.';
