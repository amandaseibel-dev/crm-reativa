-- Relatório 2026/2 sem negociação: implementação de 2026/2 com estrutura separada.
--
-- Objetivo: apresentar mensalidades de 2026/2 (julho–dezembro) com as mesmas seções
-- que 2026/1 (janeiro–junho). RPCs separadas, sem duplicação de lógica operacional.
--
-- Estrutura:
-- 1. Tabela snapshot: relatorio_mens_2026_2_snapshot (histórico diário)
-- 2. Função elegibilidade: _relatorio_2026_2_eleg() (mesma lógica que 2026/1, datas mudadas)
-- 3. RPC leitura: relatorio_mensalidades_2026_2_sem_negociacao() (retorna mesmo JSON)
-- 4. RPC captura: relatorio_mensalidades_2026_2_capturar() (snapshot diário)
--
-- Permissões: gestão (amanda.seibel@, cobranca04@, cobranca07@)
-- Read-only: nenhuma alteração de acordos, títulos, pagamentos ou confirmações.

BEGIN;

-- 1) Tabela de snapshot diário para 2026/2 (mesma estrutura que 2026/1)
CREATE TABLE IF NOT EXISTS public.relatorio_mens_2026_2_snapshot (
  dia date PRIMARY KEY,
  cpfs integer NOT NULL,
  alunos integer NOT NULL,
  mensalidades integer NOT NULL,
  saldo numeric NOT NULL,
  capturado_em timestamptz NOT NULL DEFAULT now(),
  capturado_por text,
  origem text NOT NULL DEFAULT 'captura' CHECK (origem IN ('captura', 'reconstruido'))
);

COMMENT ON TABLE public.relatorio_mens_2026_2_snapshot IS
  'Snapshot diário dos totais do relatório 2026/2 sem negociação (curva de evolução). Escrita somente via relatorio_mensalidades_2026_2_capturar().';

COMMENT ON COLUMN public.relatorio_mens_2026_2_snapshot.origem IS
  'captura = medido no dia pela RPC; reconstruido = estimado a partir da data dos eventos e ancorado nos pontos medidos.';

-- 2) Conjunto elegível para 2026/2 (mesma regra de 2026/1, mas com datas julho–dezembro)
CREATE OR REPLACE FUNCTION public._relatorio_2026_2_eleg()
RETURNS TABLE(id uuid, aluno_id uuid, cpf text, mes int, saldo numeric, curso text, unidade text, faixa text, faixa_ordem int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role'
     AND lower(coalesce(auth.email(),'')) NOT IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') THEN
    RAISE EXCEPTION 'Acesso negado: elegibilidade restrita a gestao.' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
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
  WHERE t.vencimento between date '2026-07-01' and date '2026-12-31'
    AND upper(coalesce(t.situacao,'')) = 'ABERTO'
    AND lower(coalesce(t.status,'')) = 'em_aberto'
    AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
    AND t.acordo_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.acordo_titulo_vinculo v WHERE v.titulo_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM public.casos c WHERE c.aluno_id = t.aluno_id
        AND public.normalizar_status_acionamento(coalesce(c.status_atual,c.status_acionamento,c.status_jornada)) = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO']))
    AND NOT EXISTS (SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
        WHERE s.aluno_id = t.aluno_id::text AND s.status='AGUARDANDO_CONFIRMACAO');
END;
$$;

-- 3) RPC de leitura: relatório 2026/2 sem negociação (ao vivo, com recortes + evolução)
CREATE OR REPLACE FUNCTION public.relatorio_mensalidades_2026_2_sem_negociacao()
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

  WITH eleg AS (SELECT * FROM public._relatorio_2026_2_eleg()),
  por_mes AS (
    SELECT g.mes AS mes_numero,
      (array['Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'])[g.mes - 6] AS mes_nome,
      count(distinct e.cpf) AS cpfs, count(distinct e.aluno_id) AS alunos_unicos,
      count(e.id) AS mensalidades_sem_negociacao, round(coalesce(sum(e.saldo),0),2) AS saldo_sem_negociacao
    FROM generate_series(7,12) g(mes) LEFT JOIN eleg e ON e.mes = g.mes GROUP BY g.mes
  ),
  por_curso AS (SELECT curso, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY curso),
  por_unidade AS (SELECT unidade, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY unidade),
  por_faixa AS (SELECT faixa, faixa_ordem, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY faixa, faixa_ordem),
  tot AS (SELECT count(distinct cpf) AS cpfs, count(distinct aluno_id) AS alunos, count(*) AS mens, round(coalesce(sum(saldo),0),2) AS saldo FROM eleg),
  conf AS (SELECT count(distinct s.aluno_id) AS n FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status='AGUARDANDO_CONFIRMACAO'),
  brutos AS (SELECT e.aluno_id, t.cpf AS cpf_raw FROM eleg e JOIN public.acordos_titulos t ON t.id = e.id),
  cls AS (
    SELECT aluno_id,
      regexp_replace(coalesce(cpf_raw,''),'\D','','g') AS dig,
      CASE
        WHEN coalesce(btrim(cpf_raw),'') = '' THEN 'ausente'
        WHEN regexp_replace(cpf_raw,'\D','','g') ~ '^\d{11}$'
         AND regexp_replace(cpf_raw,'\D','','g') !~ '^(\d)\1{10}$' THEN 'valido'
        ELSE 'invalido'
      END AS classe
    FROM brutos
  ),
  cpf_alunos AS (SELECT dig, count(DISTINCT aluno_id) AS n FROM cls WHERE classe = 'valido' GROUP BY dig),
  aluno_cpfs AS (
    SELECT aluno_id, count(DISTINCT dig) FILTER (WHERE classe = 'valido') AS n_validos,
      bool_or(classe IN ('ausente','invalido')) AS tem_ruim
    FROM cls GROUP BY aluno_id
  ),
  diag AS (
    SELECT jsonb_build_object(
      'cpfs_validos', (SELECT count(*) FROM cpf_alunos),
      'cpfs_compartilhados', (SELECT count(*) FROM cpf_alunos WHERE n > 1),
      'alunos_cpf_invalido_ou_ausente', (SELECT count(*) FROM aluno_cpfs WHERE tem_ruim),
      'alunos_com_cpf_divergente', (SELECT count(*) FROM aluno_cpfs WHERE n_validos > 1),
      'titulos_cpf_invalido_ou_ausente', (SELECT count(*) FROM cls WHERE classe <> 'valido')
    ) AS j
  )
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
        'dia', s.dia, 'cpfs', s.cpfs, 'alunos', s.alunos, 'mensalidades', s.mensalidades, 'saldo', s.saldo, 'origem', s.origem
      ) ORDER BY s.dia),'[]'::jsonb) FROM public.relatorio_mens_2026_2_snapshot s),
    'alunos_unicos_semestre', (SELECT alunos FROM tot),
    'cpf_diagnostico', (SELECT j FROM diag),
    'cpfs_semestre', (SELECT cpfs FROM tot),
    'mensalidades_total', (SELECT mens FROM tot),
    'saldo_total', (SELECT saldo FROM tot),
    'casos_em_confirmacao', (SELECT n FROM conf),
    'atualizado_em', now()
  ) INTO v_out;
  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.relatorio_mensalidades_2026_2_sem_negociacao() IS
  'Read-only, ao vivo. Mensalidades 2026/2 sem negociacao (julho–dezembro, exclui alunos com confirmacao de pagamento pendente) + recortes + evolucao diaria. Restrito a gestao.';

-- 4) RPC de captura: snapshot diário (execução por cron ou clique manual)
CREATE OR REPLACE FUNCTION public.relatorio_mensalidades_2026_2_capturar()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br');
  v_tecnico boolean := coalesce(auth.role(),'') = 'service_role';
  v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_cpfs int; v_alunos int; v_mens int; v_saldo numeric;
BEGIN
  IF NOT v_tecnico AND NOT v_gestao THEN
    RAISE EXCEPTION 'Acesso negado: restrito a gestao.' USING ERRCODE='42501';
  END IF;
  SELECT count(distinct cpf), count(distinct aluno_id), count(*), round(coalesce(sum(saldo),0),2)
    INTO v_cpfs, v_alunos, v_mens, v_saldo FROM public._relatorio_2026_2_eleg();
  INSERT INTO public.relatorio_mens_2026_2_snapshot (dia, cpfs, alunos, mensalidades, saldo, capturado_em, capturado_por)
  VALUES (v_dia, v_cpfs, v_alunos, v_mens, v_saldo, now(), coalesce(nullif(v_email,''),'cron'))
  ON CONFLICT (dia) DO UPDATE SET
    cpfs=excluded.cpfs, alunos=excluded.alunos, mensalidades=excluded.mensalidades,
    saldo=excluded.saldo, capturado_em=now(), capturado_por=excluded.capturado_por;
  RETURN jsonb_build_object('dia',v_dia,'cpfs',v_cpfs,'alunos',v_alunos,'mensalidades',v_mens,'saldo',v_saldo);
END;
$function$;

COMMENT ON FUNCTION public.relatorio_mensalidades_2026_2_capturar() IS
  'Captura snapshot diário do relatório 2026/2 (totais de elegibilidade + saldo) e popula relatorio_mens_2026_2_snapshot. Executável por cron (service_role) ou clique da gestão.';

-- Grants: mesmos usuários que 2026/1
REVOKE ALL ON FUNCTION public._relatorio_2026_2_eleg() FROM public, anon, authenticated;

REVOKE ALL ON FUNCTION public.relatorio_mensalidades_2026_2_sem_negociacao() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.relatorio_mensalidades_2026_2_sem_negociacao() TO authenticated;

REVOKE ALL ON FUNCTION public.relatorio_mensalidades_2026_2_capturar() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.relatorio_mensalidades_2026_2_capturar() TO authenticated;

ALTER TABLE public.relatorio_mens_2026_2_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.relatorio_mens_2026_2_snapshot FROM public, anon, authenticated;

COMMIT;
