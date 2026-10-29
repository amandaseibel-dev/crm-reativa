-- Relatorio 2026/1 sem negociacao -- HISTORICO DE AGOSTO (04 a 16/08) no CRM.
--
-- Contexto: a curva so ganhava ponto por clique manual em "Atualizar". Em PROD havia
-- 29/07, 30/07, 01/08, 03/08 e 17/08 -- o miolo de agosto ficou vazio.
--
-- Reconstrucao (auditavel, NAO e medicao): para cada titulo 2026/1 que saiu do relatorio
-- entre 04 e 17/08 tomou-se a data do evento que o tirou (vinculo/acordo criado, baixa do
-- titulo, entrada na fila de confirmacao do import Santander) e, para os que voltaram, a
-- data em que a solicitacao de confirmacao deixou de estar AGUARDANDO. Isso da o movimento
-- liquido por dia. A serie foi entao ANCORADA nos dois pontos reais medidos
-- (03/08 = 11.344 mens / R$ 14.515.325,93 e 17/08 = 9.944 / R$ 12.530.753,48), de modo que
-- os extremos batem exatamente com o capturado e o miolo respeita a data real dos eventos.
-- Coerencia observada: 08, 09, 15 e 16/08 (fins de semana) praticamente sem movimento.
-- alunos/cpfs seguem a mesma proporcao da queda de mensalidades (nao ha contagem distinta
-- historica por titulo). Valores fixos abaixo -- calculados em 2026-08-17 -- para que a
-- migration seja deterministica.
--
-- origem = 'reconstruido' marca esses pontos; a tela os exibe tracejados e rotulados como
-- estimados. NUNCA sobrescreve dia capturado de verdade (ON CONFLICT DO NOTHING).

BEGIN;

ALTER TABLE public.relatorio_mens_2026_1_snapshot
  ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'captura';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relatorio_mens_2026_1_snapshot_origem_chk') THEN
    ALTER TABLE public.relatorio_mens_2026_1_snapshot
      ADD CONSTRAINT relatorio_mens_2026_1_snapshot_origem_chk
      CHECK (origem IN ('captura','reconstruido'));
  END IF;
END $$;

COMMENT ON COLUMN public.relatorio_mens_2026_1_snapshot.origem IS
  'captura = medido no dia pela RPC; reconstruido = estimado a partir da data dos eventos e ancorado nos pontos medidos.';

INSERT INTO public.relatorio_mens_2026_1_snapshot
  (dia, cpfs, alunos, mensalidades, saldo, capturado_em, capturado_por, origem)
VALUES
  ('2026-08-04', 3856, 3844, 11224, 14393430.61, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-05', 3752, 3740, 10944, 14064853.86, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-06', 3677, 3665, 10742, 13706418.88, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-07', 3616, 3604, 10579, 13436791.84, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-08', 3620, 3608, 10589, 13515644.94, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-09', 3620, 3608, 10589, 13515644.94, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-10', 3560, 3548, 10429, 13286140.03, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-11', 3523, 3511, 10331, 13164079.43, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-12', 3488, 3476, 10235, 12988311.98, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-13', 3450, 3438, 10136, 12798515.64, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-14', 3421, 3409, 10057, 12714282.72, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-15', 3421, 3409, 10057, 12714282.72, now(), 'reconstrucao_eventos', 'reconstruido'),
  ('2026-08-16', 3421, 3409, 10057, 12714282.72, now(), 'reconstrucao_eventos', 'reconstruido')
ON CONFLICT (dia) DO NOTHING;

-- Leitura: passa a devolver 'origem' em cada ponto da evolucao diaria (resto inalterado).
CREATE OR REPLACE FUNCTION public.relatorio_mensalidades_2026_1_sem_negociacao()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br');
  v_out jsonb;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT v_gestao THEN
    RAISE EXCEPTION 'Acesso negado: relatorio restrito a gestao.' USING ERRCODE='42501';
  END IF;

  WITH eleg AS (SELECT * FROM public._relatorio_2026_1_eleg()),
  por_mes AS (
    SELECT g.mes AS mes_numero,
      (array['Janeiro','Fevereiro','Março','Abril','Maio','Junho'])[g.mes] AS mes_nome,
      count(distinct e.cpf) AS cpfs, count(distinct e.aluno_id) AS alunos_unicos,
      count(e.id) AS mensalidades_sem_negociacao, round(coalesce(sum(e.saldo),0),2) AS saldo_sem_negociacao
    FROM generate_series(1,6) g(mes) LEFT JOIN eleg e ON e.mes = g.mes GROUP BY g.mes
  ),
  por_curso AS (SELECT curso, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY curso),
  por_unidade AS (SELECT unidade, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY unidade),
  por_faixa AS (SELECT faixa, faixa_ordem, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY faixa, faixa_ordem),
  tot AS (SELECT count(distinct cpf) AS cpfs, count(distinct aluno_id) AS alunos, count(*) AS mens, round(coalesce(sum(saldo),0),2) AS saldo FROM eleg),
  conf AS (SELECT count(distinct s.aluno_id) AS n FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status='AGUARDANDO_CONFIRMACAO' AND s.motivo ILIKE 'Gerado do import de pagamentos Santander%')
  SELECT jsonb_build_object(
    'meses', (SELECT coalesce(jsonb_agg(p ORDER BY p.mes_numero),'[]'::jsonb) FROM por_mes p),
    'por_curso', (SELECT coalesce(jsonb_agg(c ORDER BY c.saldo DESC),'[]'::jsonb) FROM por_curso c),
    'por_unidade', (SELECT coalesce(jsonb_agg(u ORDER BY u.saldo DESC),'[]'::jsonb) FROM por_unidade u),
    'por_faixa', (SELECT coalesce(jsonb_agg(f ORDER BY f.faixa_ordem DESC),'[]'::jsonb) FROM por_faixa f),
    'destaques', jsonb_build_object(
      'curso_maior_inadimplencia',   (SELECT to_jsonb(c) FROM por_curso c ORDER BY c.saldo DESC LIMIT 1),
      'unidade_maior_inadimplencia', (SELECT to_jsonb(u) FROM por_unidade u ORDER BY u.saldo DESC LIMIT 1),
      'unidade_maior_volume',        (SELECT to_jsonb(u) FROM por_unidade u ORDER BY u.mensalidades DESC LIMIT 1),
      'faixa_maior_saldo',           (SELECT to_jsonb(f) FROM por_faixa f ORDER BY f.saldo DESC LIMIT 1),
      'faixa_maior_volume',          (SELECT to_jsonb(f) FROM por_faixa f ORDER BY f.mensalidades DESC LIMIT 1),
      'mes_maior_inadimplencia',     (SELECT to_jsonb(p) FROM por_mes p ORDER BY p.saldo_sem_negociacao DESC LIMIT 1),
      'mes_maior_volume',            (SELECT to_jsonb(p) FROM por_mes p ORDER BY p.mensalidades_sem_negociacao DESC LIMIT 1)
    ),
    'evolucao_diaria', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'dia', s.dia, 'cpfs', s.cpfs, 'alunos', s.alunos, 'mensalidades', s.mensalidades,
        'saldo', s.saldo, 'origem', s.origem
      ) ORDER BY s.dia),'[]'::jsonb) FROM public.relatorio_mens_2026_1_snapshot s),
    'alunos_unicos_semestre', (SELECT alunos FROM tot),
    'cpfs_semestre', (SELECT cpfs FROM tot),
    'mensalidades_total', (SELECT mens FROM tot),
    'saldo_total', (SELECT saldo FROM tot),
    'casos_em_confirmacao', (SELECT n FROM conf),
    'casos_em_revisao_manual', 0,
    'atualizado_em', now()
  ) INTO v_out;
  RETURN v_out;
END;
$function$;

COMMIT;
