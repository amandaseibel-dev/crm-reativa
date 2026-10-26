-- ROLLBACK: encerramento sem saldo volta a aceitar o texto sem conferencia.
--
-- Devolve `caso_encerrado_operacional(5 args)` ao texto EXATO de producao de
-- 26/10/2026 (md5 adc514c7a018018d866096d8e420d7b3) e derruba o que a migration
-- criou para ESCREVER.
--
-- A TRILHA NAO E APAGADA. `caso_encerramento_sem_saldo` continua de pe, com o
-- gatilho de imutabilidade e a funcao de leitura: reverter codigo nao apaga
-- historico de decisao ja produzido. PITR nao esta habilitado neste projeto,
-- entao historico perdido nao volta.
--
-- CONSEQUENCIA A ENTENDER ANTES DE RODAR: com a funcao antiga de volta, os dois
-- textos voltam a valer sozinhos. Como a funcao antiga NAO consulta o
-- congelamento, os casos que tinham registro vigente continuam encerrados pelo
-- proprio texto -- ou seja, o rollback nao devolve ninguem a cobranca.

begin;

-- 1. A funcao de 5 argumentos volta ao texto de producao.
create or replace function public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- status_acionamento fala do ACIONAMENTO. 'CANCELADO' aqui e acordo
  -- cancelado, nao cobranca cancelada -- e nao tira ninguem da fila.
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- + ANTECIPACAO SEMESTRE (07/10/2026). Entra pelo ramo condicional de propo-
  -- sito: `normalizar_status_acionamento` troca '_' por ' ', por isso sem under-
  -- score aqui.
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO','ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- 2. Sai o que escreve.
drop function if exists public.caso_encerramento_resolver(uuid,text,text);
drop function if exists public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text);
drop function if exists public._caso_sem_saldo_conferido(uuid,text);
drop function if exists public.caso_encerramento_congelado(uuid);

-- 3. FICA: a tabela, o gatilho de imutabilidade e a leitura.
--    `caso_encerramento_sem_saldo`, `_caso_encerramento_sem_saldo_imutavel`,
--    `caso_encerramento_pendentes`.
--
--    Para apagar a trilha -- o que NAO faz parte deste rollback -- e preciso
--    exportar antes e rodar, de proposito e em separado:
--
--      drop trigger trg_caso_encerramento_sem_saldo_imutavel on public.caso_encerramento_sem_saldo;
--      drop function public._caso_encerramento_sem_saldo_imutavel();
--      drop function public.caso_encerramento_pendentes(integer);
--      drop table public.caso_encerramento_sem_saldo;

commit;
