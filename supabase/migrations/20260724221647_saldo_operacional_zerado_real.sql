-- Saldo operacional e definição de "zerado real" por matrícula.
--
-- Causa raiz: a fila/card decidem "zerado" por casos.total_em_aberto, um
-- snapshot que reflete só as mensalidades originais e fica defasado. Uma vez
-- que os títulos entram num acordo, esse valor zera, mas as PARCELAS do acordo
-- seguem em aberto -> o caso aparece zerado sem estar.
--
-- Fonte única de saldo: public.aluno_saldo_pendente_detalhe(aluno_id), que já
-- soma SEPARADAMENTE, por aluno_id:
--   - mensalidades originais em aberto (acordos_titulos não vinculados a acordo
--     ativo);
--   - parcelas de acordos não cancelados em aberto;
--   - confirmações de pagamento aguardando (solicitacoes_confirmacao_pagamento).
--
-- Esta migration NÃO altera dados, NÃO remove casos da fila e NÃO é destrutiva:
-- adiciona apenas um predicado puro (STABLE) e uma view de diagnóstico. A
-- retirada dos zerados reais da fila é uma etapa separada, a validar em staging
-- antes de aplicar (ver PR).
--
-- Regras obrigatórias:
--   - vínculo SEMPRE por aluno_id; na ausência dele, por matrícula EXATA e
--     ÚNICA; NUNCA por CPF; nunca mistura matrículas diferentes do mesmo aluno;
--   - só é "zerado real" quando não há mensalidade, parcela de acordo,
--     confirmação pendente NEM baixa financeira pendente;
--   - divergência/ausência de vínculo => NÃO é zerado real (marca para revisão).

BEGIN;

-- Resolve o aluno de um caso: aluno_id direto, ou matrícula exata e única.
-- Retorna NULL quando não há vínculo seguro (não classificável).
CREATE OR REPLACE FUNCTION internal.resolver_aluno_por_matricula(p_aluno_id uuid, p_matricula text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    p_aluno_id,
    (SELECT a.id FROM public.alunos a
      WHERE p_aluno_id IS NULL
        AND nullif(btrim(p_matricula),'') IS NOT NULL
        AND btrim(a.matricula) = btrim(p_matricula)
        AND (SELECT count(*) FROM public.alunos a2 WHERE btrim(a2.matricula) = btrim(p_matricula)) = 1)
  );
$function$;

-- Retorna o estado de saldo de um caso como jsonb, com a classificação:
--   classificacao ∈ ('ZERADO_REAL','COM_SALDO','REVISAO_SEM_VINCULO')
-- REVISAO_SEM_VINCULO: aluno_id nulo e matrícula ausente/ambígua -> revisar,
-- manter visível, nunca finalizar automaticamente.
CREATE OR REPLACE FUNCTION public.caso_saldo_operacional(p_aluno_id uuid, p_matricula text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_aid uuid;
  v_det jsonb;
  v_baixas_pendentes int := 0;
begin
  v_aid := internal.resolver_aluno_por_matricula(p_aluno_id, p_matricula);
  if v_aid is null then
    return jsonb_build_object('classificacao','REVISAO_SEM_VINCULO','tem_saldo', true);
  end if;

  v_det := public.aluno_saldo_pendente_detalhe(v_aid, null);

  -- Baixa financeira pendente (aguardando baixa) também impede "zerado real".
  select count(*) into v_baixas_pendentes
  from public.baixas_pagamento b
  where b.aluno_id = v_aid::text
    and upper(coalesce(b.status_baixa,'')) in ('AGUARDANDO_BAIXA','PENDENTE');

  return jsonb_build_object(
    'aluno_id', v_aid,
    'mensalidades_abertas', (v_det->>'titulos_abertos')::numeric,
    'titulos_negociados_orfaos', (v_det->>'titulos_negociados_orfaos')::numeric,
    'parcelas_abertas_qtd', (v_det->>'parcelas_abertas_qtd')::int,
    'parcelas_abertas_valor', (v_det->>'parcelas_abertas_valor')::numeric,
    'confirmacoes_pendentes', (v_det->>'confirmacoes_pendentes')::int,
    'baixas_pendentes', v_baixas_pendentes,
    'total', (v_det->>'total')::numeric,
    'tem_saldo', ((v_det->>'tem_pendencia')::boolean OR v_baixas_pendentes > 0),
    'classificacao', CASE
      WHEN ((v_det->>'tem_pendencia')::boolean OR v_baixas_pendentes > 0) THEN 'COM_SALDO'
      ELSE 'ZERADO_REAL'
    END
  );
end;
$function$;

-- Predicado puro: TRUE somente para "zerado real" (sem nenhuma pendência e com
-- vínculo seguro). Casos sem vínculo => FALSE (nunca zerado real).
CREATE OR REPLACE FUNCTION public.caso_saldo_zerado_real(p_aluno_id uuid, p_matricula text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT (public.caso_saldo_operacional(p_aluno_id, p_matricula) ->> 'classificacao') = 'ZERADO_REAL';
$function$;

-- View de diagnóstico (leitura) sobre casos atualmente na fila ativa.
CREATE OR REPLACE VIEW public.vw_diagnostico_saldo_casos AS
SELECT
  c.id AS caso_id,
  c.aluno_id,
  c.matricula,
  c.operador_email,
  coalesce(c.total_em_aberto,0) AS valor_snapshot_casos,
  s.classificacao,
  (s.valor->>'total')::numeric AS saldo_operacional_total,
  (s.valor->>'parcelas_abertas_qtd')::int AS parcelas_abertas_qtd,
  (s.valor->>'confirmacoes_pendentes')::int AS confirmacoes_pendentes,
  (s.valor->>'baixas_pendentes')::int AS baixas_pendentes
FROM public.casos c
CROSS JOIN LATERAL (SELECT public.caso_saldo_operacional(c.aluno_id, c.matricula) AS valor) sv
CROSS JOIN LATERAL (SELECT sv.valor->>'classificacao' AS classificacao, sv.valor) s
WHERE c.operador_email IS NOT NULL
  AND c.quitado_em IS NULL
  AND coalesce(c.status_acionamento,'') NOT ILIKE '%CANCEL%'
  AND coalesce(c.status_acionamento,'') NOT ILIKE '%JURIDIC%';

COMMIT;
