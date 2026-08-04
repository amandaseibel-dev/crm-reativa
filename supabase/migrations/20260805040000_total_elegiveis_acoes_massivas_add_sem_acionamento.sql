-- Adiciona contagem "sem_acionamento" (nunca acionados) ao painel de Ações
-- Massivas, para visão à vista sem precisar rodar a busca. statement_timeout
-- próprio (a RPC chama aluno_em_confirmacao_pagamento por linha).
CREATE OR REPLACE FUNCTION public.total_elegiveis_acoes_massivas(p_canal text DEFAULT 'WHATSAPP'::text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
  SELECT jsonb_build_object(
    'total_elegivel', count(*) FILTER (
      WHERE (p_canal = 'WHATSAPP' AND a.telefone IS NOT NULL) OR (p_canal = 'EMAIL' AND a.email IS NOT NULL)
    ),
    'ja_acionado', count(*) FILTER (
      WHERE ((p_canal = 'WHATSAPP' AND a.telefone IS NOT NULL) OR (p_canal = 'EMAIL' AND a.email IS NOT NULL))
        AND a.data_retorno IS NOT NULL AND a.data_retorno > current_date
    ),
    'sem_acionamento', count(*) FILTER (
      WHERE ((p_canal = 'WHATSAPP' AND a.telefone IS NOT NULL) OR (p_canal = 'EMAIL' AND a.email IS NOT NULL))
        AND a.data_ultimo_acionamento IS NULL
    )
  )
  FROM public.alunos a
  JOIN public.casos c ON c.aluno_id = a.id
  WHERE a.responsavel_atual_email IS NULL
    AND c.operador_email IS NULL
    AND c.total_em_aberto >= 100
    AND public.aluno_em_confirmacao_pagamento(a.id::text) IS NULL
    AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
    AND NOT EXISTS (
      SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO'
    );
$function$;
