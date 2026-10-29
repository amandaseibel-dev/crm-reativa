-- A caixa-preta do webhook do WhatsApp passa de 90 para 14 dias.
--
-- O QUE ELA É, e o que ela NÃO é. `whatsapp_webhook_eventos` guarda o envelope
-- CRU que chegou do gateway, salvo antes de processar, para auditoria e
-- reprocessamento (ver whatsapp-webhook/index.ts). Não é a conversa: a conversa
-- vive em `whatsapp_mensagens`, com retenção própria de 12 meses, e não é tocada
-- aqui. Nenhuma mensagem, lead ou mídia é afetada.
--
-- MEDIDO EM 02/09/2026:
--   174.685 eventos, entrando 11.809 por dia
--   329 MB, dos quais 44 MB de dados, 11 MB de índice e 274 MB de TOAST -- o
--     payload jsonb é 83% da tabela
--   projeção com 90 dias: 2.001 MB, contra um banco inteiro de 1.400 MB
--
-- E o que esse volume preservava:
--   174.637 processados com sucesso
--        48 com erro (0,027%), TODOS anteriores a 19/08, nenhum reprocessado
--         0 com assinatura inválida
--         0 travados sem conclusão
-- Cento e setenta e quatro mil envelopes intactos para guardar 48 falhas
-- antigas. Os 48 foram para `_backup_webhook_com_erro_20260902` (40 kB) antes
-- do corte, que é o único registro de falha que existia.
--
-- CONEXÃO FICA EM 90 DIAS, DE PROPÓSITO. `whatsapp_conexao_eventos` tem 3,4 MB
-- e 18.965 linhas -- barato -- e é o rastro forense dos incidentes do gateway
-- (ban, logout, badSession). É exatamente o histórico que já foi preciso olhar
-- semanas depois.
create or replace function public.whatsapp_expurgar_eventos()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_qtd integer;
BEGIN
  DELETE FROM public.whatsapp_webhook_eventos WHERE recebido_em < now() - interval '14 days';
  GET DIAGNOSTICS v_qtd = ROW_COUNT;
  DELETE FROM public.whatsapp_conexao_eventos WHERE criado_em < now() - interval '90 days';
  RETURN v_qtd;
END;
$function$;

-- A FREQUÊNCIA PRECISA ACOMPANHAR A RETENÇÃO -- furo que quase passou.
--
-- O expurgo morava dentro do job mensal `whatsapp_retencao_mensal` (dia 1, às
-- 04:10). Retenção de 14 dias com limpeza mensal não entrega 14 dias: no dia 30
-- a tabela estaria com 44 dias de dados, e o teto de ~310 MB viraria ~970 MB.
-- Para 12 meses de mensagem a frequência mensal tanto fazia; para 14 dias, não.
-- Então o envelope ganha job próprio, diário, e o mensal fica só com a retenção
-- de mensagens.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'whatsapp_retencao_mensal'),
  command => 'SELECT public.whatsapp_expurgar_retencao();'
);

select cron.schedule('whatsapp_expurgar_eventos_diario', '25 4 * * *',
                     'select public.whatsapp_expurgar_eventos();');
