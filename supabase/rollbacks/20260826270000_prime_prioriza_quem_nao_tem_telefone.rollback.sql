-- Rollback: a fila da Prime volta a ignorar quem não tem telefone.
--
-- ATENÇÃO: sem essa prioridade, os 3.853 alunos sem telefone voltam para o fim
-- da fila e só serão consultados quando a varredura chegar neles por saldo.
-- Enquanto isso eles seguem fora de ação massiva, de mensagem e de acionamento.
create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table(cpf text, saldo numeric)
language sql stable security definer set search_path to 'public'
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
  ja_coletados AS MATERIALIZED (
    SELECT DISTINCT c.cpf FROM public.prime_contratos c
     WHERE c.coletado_em > now() - interval '7 days'
  )
  SELECT d.cpf, d.saldo
    FROM devedores d
    LEFT JOIN sem_negociacao s ON s.cpf = d.cpf
    LEFT JOIN ja_coletados j   ON j.cpf = d.cpf
   WHERE j.cpf IS NULL
   ORDER BY d.tem_2026 DESC, (s.cpf IS NOT NULL) DESC, d.saldo DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;
