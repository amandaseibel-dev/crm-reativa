-- Relatório "Mensalidades 2026/1 sem negociação": junho volta para o recorte.
--
-- A migration 20260824235000 cortou o relatório em maio (2026/1 termina na
-- parcela 5; junho é matrícula antecipada de 2026/2). Decisão da Amanda em
-- 2026-08-25: as parcelas de junho voltam a aparecer.
--
-- O que muda: só a janela de vencimento (jan–mai -> jan–jun) e a régua de meses
-- (1..5 -> 1..6, com "Junho").
--
-- O que NÃO muda: as regras de contagem e de valor continuam idênticas --
-- mesmo saldo canônico (saldo_corrigido -> valor_em_aberto -> valor_original),
-- mesmos filtros (ABERTO/em_aberto, sem acordo_id, sem vínculo, fora de
-- CANCELADO/JURÍDICO) e o mesmo corte do portador 166 (sai só quem negociou
-- pela Prime E não tem acordo ativo nem confirmação no CRM). O espelho
-- `negociado_166` acompanha a mesma janela.
--
-- A tela não muda de formato: mesmas chaves no JSON; o componente usa
-- `meses.length`, então gráfico e tabela absorvem o sexto mês sozinhos.
begin;

create or replace function public._relatorio_2026_1_eleg()
returns table (id uuid, aluno_id uuid, cpf text, mes integer, saldo numeric,
               curso text, unidade text, faixa text, faixa_ordem integer)
language sql
stable
security definer
set search_path to 'public'
as $function$
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
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) >  500 THEN 'R$ 500 a R$ 1.000'
           ELSE 'Até R$ 500'
         END,
         CASE
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 2000 THEN 4
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 1000 THEN 3
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) >  500 THEN 2
           ELSE 1
         END
  FROM public.acordos_titulos t
  LEFT JOIN public.alunos al ON al.id = t.aluno_id
  WHERE t.vencimento between date '2026-01-01' and date '2026-06-30'
    AND upper(coalesce(t.situacao,'')) = 'ABERTO'
    AND lower(coalesce(t.status,''))   = 'em_aberto'
    AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
    AND t.acordo_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.acordo_titulo_vinculo v WHERE v.titulo_id = t.id)
    AND NOT EXISTS (
          SELECT 1 FROM public.casos c
           WHERE c.aluno_id = t.aluno_id
             AND public.normalizar_status_acionamento(
                   coalesce(c.status_atual, c.status_acionamento, c.status_jornada)
                 ) = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'])
        )
    -- Sai só quem negociou pela Prime E não tem nada registrado no CRM.
    AND NOT (
          EXISTS (SELECT 1 FROM public.prime_portador_membro pm
                   WHERE pm.portador = 166
                     AND pm.cpf = lpad(regexp_replace(coalesce(t.cpf,''),'\D','','g'),11,'0'))
      AND NOT EXISTS (SELECT 1 FROM public.acordos ac
                       WHERE ac.aluno_id = t.aluno_id AND ac.status = 'ATIVO')
      AND NOT EXISTS (SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
                       WHERE s.aluno_id = t.aluno_id::text
                         AND s.status = 'AGUARDANDO_CONFIRMACAO')
        );
$function$;

-- A RPC da tela: mesmas chaves de sempre, incluindo `negociado_166` (o espelho).
-- Régua de meses de 1 a 6; o componente usa `meses.length`, então o gráfico e
-- a tabela se ajustam sozinhos.
create or replace function public.relatorio_mensalidades_2026_1_sem_negociacao()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br')
                      OR public.usuario_e_diretoria();
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
  neg AS (
    SELECT count(distinct lpad(regexp_replace(coalesce(t.cpf,''),'\D','','g'),11,'0')) AS cpfs,
           count(*) AS mensalidades, round(coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0),2) AS saldo
      FROM public.acordos_titulos t
     WHERE t.vencimento between date '2026-01-01' and date '2026-06-30'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND lower(coalesce(t.status,''))   = 'em_aberto'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND t.acordo_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.acordo_titulo_vinculo v WHERE v.titulo_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.casos c WHERE c.aluno_id = t.aluno_id
             AND public.normalizar_status_acionamento(coalesce(c.status_atual,c.status_acionamento,c.status_jornada))
                 = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO']))
       AND EXISTS (SELECT 1 FROM public.prime_portador_membro pm
                    WHERE pm.portador = 166
                      AND pm.cpf = lpad(regexp_replace(coalesce(t.cpf,''),'\D','','g'),11,'0'))
       AND NOT EXISTS (SELECT 1 FROM public.acordos ac
                        WHERE ac.aluno_id = t.aluno_id AND ac.status = 'ATIVO')
       AND NOT EXISTS (SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
                        WHERE s.aluno_id = t.aluno_id::text
                          AND s.status = 'AGUARDANDO_CONFIRMACAO')
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
        'dia', s.dia, 'cpfs', s.cpfs, 'alunos', s.alunos, 'mensalidades', s.mensalidades,
        'saldo', s.saldo, 'origem', s.origem
      ) ORDER BY s.dia),'[]'::jsonb) FROM public.relatorio_mens_2026_1_snapshot s),
    'alunos_unicos_semestre', (SELECT alunos FROM tot),
    'cpfs_semestre', (SELECT cpfs FROM tot),
    'mensalidades_total', (SELECT mens FROM tot),
    'saldo_total', (SELECT saldo FROM tot),
    'negociado_166', (SELECT to_jsonb(n) FROM neg n),
    'casos_em_confirmacao', 0,
    'casos_em_revisao_manual', 0,
    'atualizado_em', now()
  ) INTO v_out;
  RETURN v_out;
END;
$function$;

commit;
