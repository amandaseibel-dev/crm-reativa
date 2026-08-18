-- Fila operacional: alunos com confirmação de pagamento PENDENTE devem sair de
-- TODAS as filas operacionais, independentemente de quem filtrou o pagamento.
--
-- Problema: o frontend (PainelCarteira) lia solicitacoes_confirmacao_pagamento
-- direto, mas a policy de SELECT só deixa o operador ver as PRÓPRIAS solicitações
-- (operador_email = ele) ou gestão de fila. Quando o pagamento foi filtrado por
-- um operador e o caso hoje pertence a OUTRO (remanejamento, filtro por
-- supervisor etc.), o dono atual não enxerga a solicitação -> o pago continua na
-- carteira dele. Em prod: 97 de 223 casos acionáveis pendentes divergiam.
--
-- Solução: RPC SECURITY DEFINER que devolve APENAS os aluno_id (UUID, sem PII)
-- em confirmação pendente. O frontend passa a usar esta lista canônica para tirar
-- os pagos da fila, sem depender da visibilidade limitada do RLS por operador.
-- Não expõe operador, nome, CPF, valor nem qualquer PII -- só o identificador do
-- aluno, que o operador já tem na própria carteira.

CREATE OR REPLACE FUNCTION public.alunos_em_confirmacao_pendente()
RETURNS TABLE (aluno_id text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT s.aluno_id::text
  FROM public.solicitacoes_confirmacao_pagamento s
  WHERE s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
    AND s.aluno_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.alunos_em_confirmacao_pendente() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alunos_em_confirmacao_pendente() TO authenticated;

COMMENT ON FUNCTION public.alunos_em_confirmacao_pendente() IS
  'Lista canônica de aluno_id (UUID, sem PII) com confirmação de pagamento pendente. Usada pela fila operacional para tirar os pagos de TODAS as carteiras, independentemente de quem filtrou o pagamento. Gated: só authenticated.';
