-- Quitado tambem entra na fila da Prime -- para dar para MEDIR a conversao.
--
-- Amanda, 27/08/2026: "quantos alunos recebemos em 2026/1 e quantos fizeram a
-- matricula", e a definicao que ela deu de conversao: "na real sao todos alunos
-- com a matricula confirmada em 2026/2".
--
-- E o indicador certo. A primeira coisa que eu ia medir era "fechou acordo" --
-- seria enganoso: 593 dos 694 acordos do mes vieram da IMPORTACAO do Prime, nao
-- da mao do operador. Contar aquilo como conversao daria credito ao arquivo.
--
-- O QUE A MEDICAO MOSTROU, e por que ela ainda nao vale:
--
--   quitados na ficha ....... 708 alunos, so 202 medveis, 188 matricularam (93,1%)
--   com baixa de parcela .... 535 alunos, so 120 medveis, 111 matricularam (92,5%)
--   coorte geral 2026/1 ... 5.423 alunos,   4.515 medveis, 3.551 matric. (78,6%)
--
-- 93% contra 78,6% e uma diferenca grande e na direcao esperada. Mas esta
-- apoiada em 28% do grupo, e a amostra NAO e aleatoria: a coleta so busca quem
-- tem DIVIDA EM ABERTO (ver a CTE `devedores`), e quem foi quitado deixou de
-- ter. Os medveis sao justamente os coletados ANTES de serem quitados.
-- Extrapolar dai seria inventar numero -- e ela levaria isso para a diretoria.
--
-- A CORRECAO. Quem foi recuperado (quitado na ficha ou com baixa de parcela)
-- passa a entrar na fila mesmo sem divida. Sao 1.118 CPFs, dos quais 836 nunca
-- foram consultados. A coleta roda a cada 2 minutos com 60 por vez: fecha em
-- algumas horas, uma vez so -- depois ficam 7 dias em `ja_coletados` e saem da
-- frente.
--
-- ORDEM DE PRIORIDADE, e ela e deliberada:
--   1. cadastro repetido  -> destrava conferencia de duplicidade
--   2. sem telefone       -> destrava a operacao (aluno inalcancavel)
--   3. 2026 / sem negociacao
--   4. recuperados        -> destrava a MEDICAO
--   5. maior saldo
-- Trabalho parado vem antes de relatorio.

create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table(cpf text, saldo numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  WITH sem_negociacao AS MATERIALIZED (
    SELECT DISTINCT e.cpf FROM public._relatorio_2026_1_eleg() e
  ),
  devedores AS MATERIALIZED (
    SELECT lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') AS cpf,
           round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 2) AS saldo,
           bool_or(extract(year from t.vencimento) = 2026) AS tem_2026
      FROM public.acordos_titulos t
     WHERE lower(coalesce(t.status,'')) = 'em_aberto'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND length(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g')) = 11
     GROUP BY 1
  ),
  repetidos AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
       AND length(coalesce(a.nome,'')) > 12
       AND EXISTS (
         SELECT 1 FROM public.alunos b
          WHERE b.id <> a.id
            AND length(coalesce(b.nome,'')) > 12
            AND upper(regexp_replace(translate(b.nome,
                  'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                  'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g'))
              = upper(regexp_replace(translate(a.nome,
                  'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                  'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g'))
       )
  ),
  -- RECUPERADOS: quitados na ficha ou com baixa de parcela. Sem divida, nunca
  -- entrariam -- e sao justamente eles que respondem se o trabalho converte em
  -- matricula.
  recuperados AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.casos c
      JOIN public.alunos al ON al.id = c.aluno_id
     WHERE c.quitado_em IS NOT NULL
       AND length(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g')) = 11
    UNION
    SELECT DISTINCT lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0')
      FROM public.baixas_pagamento b
      JOIN public.parcelas p ON p.id = b.parcela_id
      JOIN public.acordos a  ON a.id = p.acordo_id
      JOIN public.alunos al  ON al.id = a.aluno_id
     WHERE b.status_baixa = 'REALIZADA'
       AND length(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g')) = 11
  ),
  candidatos AS MATERIALIZED (
    SELECT d.cpf, d.saldo, d.tem_2026 FROM devedores d
    UNION
    SELECT r.cpf, 0::numeric, false FROM repetidos r
     WHERE NOT EXISTS (SELECT 1 FROM devedores d2 WHERE d2.cpf = r.cpf)
    UNION
    SELECT rc.cpf, 0::numeric, false FROM recuperados rc
     WHERE NOT EXISTS (SELECT 1 FROM devedores d3 WHERE d3.cpf = rc.cpf)
  ),
  ja_coletados AS MATERIALIZED (
    SELECT DISTINCT c.cpf FROM public.prime_contratos c
     WHERE c.coletado_em > now() - interval '7 days'
  ),
  sem_telefone AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE coalesce(a.telefone,'') = ''
       AND length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
  )
  SELECT c.cpf, c.saldo
    FROM candidatos c
    LEFT JOIN sem_negociacao s ON s.cpf = c.cpf
    LEFT JOIN ja_coletados j   ON j.cpf = c.cpf
    LEFT JOIN sem_telefone st  ON st.cpf = c.cpf
    LEFT JOIN repetidos r      ON r.cpf = c.cpf
    LEFT JOIN recuperados rc   ON rc.cpf = c.cpf
   WHERE j.cpf IS NULL
   ORDER BY (r.cpf IS NOT NULL) DESC,    -- 1) cadastro repetido: destrava conferencia
            (st.cpf IS NOT NULL) DESC,   -- 2) sem telefone: destrava a operacao
            c.tem_2026 DESC,
            (s.cpf IS NOT NULL) DESC,
            (rc.cpf IS NOT NULL) DESC,   -- 3) recuperados: destrava a MEDICAO
            c.saldo DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;
