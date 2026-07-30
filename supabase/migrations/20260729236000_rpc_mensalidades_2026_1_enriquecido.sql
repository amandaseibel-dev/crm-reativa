-- Relatorio 2026/1 sem negociacao -- ENRIQUECIDO + EVOLUCAO DIARIA (ao vivo/diario).
-- Acrescenta cpfs por mes, por_curso, por_unidade, por_faixa, destaques e a evolucao
-- diaria (via tabela de snapshot). A UNICA escrita e na tabela de snapshot (capturar),
-- nunca em pagamentos/acordos/saldos/titulos. Restrito a gestao. Read RPC e STABLE.

BEGIN;

-- 1) Snapshot diario (historico p/ a curva de evolucao). Uma linha por dia (BRT).
CREATE TABLE IF NOT EXISTS public.relatorio_mens_2026_1_snapshot (
  dia date PRIMARY KEY,
  cpfs integer NOT NULL,
  alunos integer NOT NULL,
  mensalidades integer NOT NULL,
  saldo numeric NOT NULL,
  capturado_em timestamptz NOT NULL DEFAULT now(),
  capturado_por text
);
COMMENT ON TABLE public.relatorio_mens_2026_1_snapshot IS
  'Snapshot diario dos totais do relatorio 2026/1 sem negociacao (curva de evolucao). Escrita so via relatorio_mensalidades_2026_1_capturar().';

-- 2) Bloco reutilizavel: conjunto elegivel (mesma regra do relatorio). Definido como
--    funcao STABLE que retorna as linhas elegiveis, p/ nao duplicar a regra.
CREATE OR REPLACE FUNCTION public._relatorio_2026_1_eleg()
RETURNS TABLE(id uuid, aluno_id uuid, cpf text, mes int, saldo numeric, curso text, unidade text, faixa text, faixa_ordem int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT t.id, t.aluno_id,
         lpad(regexp_replace(coalesce(t.cpf,''),'\D','','g'),11,'0'),
         extract(month from t.vencimento)::int,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),
         CASE
           WHEN t.tipo_boleto ILIKE 'Cursos de Gradua%Presencial' THEN 'Graduação Presencial'
           WHEN t.tipo_boleto ILIKE 'Cursos de Gradua%Online'     THEN 'Graduação Online'
           WHEN t.tipo_boleto ILIKE 'Cursos de Gradua%Híbrido' OR t.tipo_boleto ILIKE 'Cursos de Gradua%brido' THEN 'Graduação Híbrido'
           WHEN t.tipo_boleto ILIKE 'Cursos de Pós%'             THEN 'Pós-Graduação (Lato Sensu)'
           WHEN t.tipo_boleto ILIKE 'Extens%'                    THEN 'Extensão'
           ELSE coalesce(nullif(trim(t.tipo_boleto),''),'(não informado)')
         END,
         coalesce(nullif(upper(regexp_replace(public.unaccent(coalesce(al.unidade,'')),'\s+',' ','g')),''),'(NÃO INFORMADO)'),
         CASE
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 2000 THEN 'Acima de R$ 2.000'
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 1000 THEN 'R$ 1.000 a R$ 2.000'
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 500  THEN 'R$ 500 a R$ 1.000'
           ELSE 'Até R$ 500'
         END,
         CASE
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 2000 THEN 4
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 1000 THEN 3
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 500  THEN 2
           ELSE 1
         END
  FROM public.acordos_titulos t
  LEFT JOIN public.alunos al ON al.id = t.aluno_id
  WHERE t.vencimento between date '2026-01-01' and date '2026-06-30'
    AND upper(coalesce(t.situacao,'')) = 'ABERTO'
    AND lower(coalesce(t.status,'')) = 'em_aberto'
    AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
    AND t.acordo_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.acordo_titulo_vinculo v WHERE v.titulo_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM public.casos c WHERE c.aluno_id = t.aluno_id
        AND public.normalizar_status_acionamento(coalesce(c.status_atual,c.status_acionamento,c.status_jornada)) = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO']))
    AND NOT EXISTS (SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
        WHERE s.aluno_id = t.aluno_id::text AND s.status='AGUARDANDO_CONFIRMACAO' AND s.motivo ILIKE 'Gerado do import de pagamentos Santander%');
$$;

-- 3) Captura do snapshot do dia (UNICA escrita; so na tabela de snapshot). Gestao.
CREATE OR REPLACE FUNCTION public.relatorio_mensalidades_2026_1_capturar()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br');
  v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_cpfs int; v_alunos int; v_mens int; v_saldo numeric;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT v_gestao THEN
    RAISE EXCEPTION 'Acesso negado: restrito a gestao.' USING ERRCODE='42501';
  END IF;
  SELECT count(distinct cpf), count(distinct aluno_id), count(*), round(coalesce(sum(saldo),0),2)
    INTO v_cpfs, v_alunos, v_mens, v_saldo FROM public._relatorio_2026_1_eleg();
  INSERT INTO public.relatorio_mens_2026_1_snapshot (dia, cpfs, alunos, mensalidades, saldo, capturado_em, capturado_por)
  VALUES (v_dia, v_cpfs, v_alunos, v_mens, v_saldo, now(), v_email)
  ON CONFLICT (dia) DO UPDATE SET
    cpfs=excluded.cpfs, alunos=excluded.alunos, mensalidades=excluded.mensalidades,
    saldo=excluded.saldo, capturado_em=now(), capturado_por=excluded.capturado_por;
  RETURN jsonb_build_object('dia',v_dia,'cpfs',v_cpfs,'alunos',v_alunos,'mensalidades',v_mens,'saldo',v_saldo);
END;
$function$;

-- 4) Leitura enriquecida (ao vivo) + recortes + evolucao diaria (snapshot).
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
        'dia', s.dia, 'cpfs', s.cpfs, 'alunos', s.alunos, 'mensalidades', s.mensalidades, 'saldo', s.saldo
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

COMMENT ON FUNCTION public.relatorio_mensalidades_2026_1_sem_negociacao() IS
  'Read-only, ao vivo. Mensalidades 2026/1 sem negociacao + recortes (mes/cpf, curso, unidade, faixa, destaques) + evolucao diaria (snapshot). Restrito a gestao.';

COMMIT;
