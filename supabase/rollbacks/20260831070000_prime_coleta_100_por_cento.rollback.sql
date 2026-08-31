-- DESFAZER 20260831070000_prime_coleta_100_por_cento.sql
--
-- Volta a fila de coleta do Prime ao formato anterior: quatro grupos (sem o
-- `nunca_coletado`) e as prioridades por LEFT JOIN de CTE.
--
-- ATENCAO -- desfazer traz os dois defeitos de volta:
--   1) a funcao volta a levar ~14s e a Edge Function volta a cortar com
--      PENDENTES_FALHOU: statement timeout -- a coleta PARA de novo;
--   2) as 3.634 pessoas sem nenhum dado do Prime voltam a nunca ser coletadas.
--
-- So use se a versao nova estiver devolvendo gente errada. Se o problema for
-- so a ordem, mexa no ORDER BY em vez de desfazer tudo.

create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table(cpf text, saldo numeric)
language sql
stable security definer
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
  sem_contato AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
       AND coalesce(a.telefone,'') = ''
       AND coalesce(a.email,'') NOT LIKE '%@%'
       AND NOT EXISTS (SELECT 1 FROM public.aluno_contatos c WHERE c.aluno_id = a.id)
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
    SELECT sc.cpf, 0::numeric, false FROM sem_contato sc
     WHERE NOT EXISTS (SELECT 1 FROM devedores d0 WHERE d0.cpf = sc.cpf)
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
    LEFT JOIN sem_contato sc2  ON sc2.cpf = c.cpf
    LEFT JOIN repetidos r      ON r.cpf = c.cpf
    LEFT JOIN recuperados rc   ON rc.cpf = c.cpf
   WHERE j.cpf IS NULL
   ORDER BY (sc2.cpf IS NOT NULL) DESC,
            (r.cpf IS NOT NULL) DESC,
            (st.cpf IS NOT NULL) DESC,
            c.tem_2026 DESC,
            (s.cpf IS NOT NULL) DESC,
            (rc.cpf IS NOT NULL) DESC,
            c.saldo DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;

revoke all on function public.prime_cadastro_pendentes(integer) from public, anon;
grant execute on function public.prime_cadastro_pendentes(integer) to service_role;
