CREATE OR REPLACE FUNCTION public.acoes_massivas_motivo_texto(p_motivo text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case p_motivo
    when 'quitado'               then 'Quitado'
    when 'liquidado_prime'       then 'Já consta liquidado no Prime'
    when 'giro_fidelizado' then 'Fidelizado pelo giro de carteira (até 26/10/2026)'
    when 'encerrado_operacional' then 'Caso encerrado operacionalmente'
    when 'confirmacao_pendente'  then 'Aguardando confirmação financeira'
    when 'fora_tipo_cobranca'    then 'Não corresponde ao tipo de cobrança selecionado'
    when 'retorno_futuro'        then 'Retorno agendado para data futura'
    when 'outro_responsavel'     then 'Fora do responsável selecionado'
    when 'acao_massiva_recente'  then 'Recebeu ação massiva neste canal dentro da recência'
    when 'contato_indisponivel'  then 'Sem contato válido para o canal / filtro de contato'
    when 'contato_compartilhado' then 'Outra pessoa com dívida usa o mesmo contato — em revisão cadastral'
    when 'contato_invalidado'    then 'Contato marcado como incorreto — liberação pelo Administrativo'
    when 'valor_fora_da_faixa'   then 'Valor em aberto fora da faixa selecionada'
    else p_motivo end;
$function$;

CREATE OR REPLACE FUNCTION public.usuario_e_gestao()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$function$;
