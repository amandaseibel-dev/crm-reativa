-- A coleta Prime passa a comecar por 2026.
--
-- Decisao da Amanda em 26/08/2026: "prioridade seja o ano de 2026 para
-- ajustar, depois vamos fazendo os outros anos".
--
-- FAZ SENTIDO NO DADO: 2026 e o ano com mais divida aberta e o mais recente --
-- o que a operacao esta trabalhando hoje:
--
--     2026 -> 13.821 titulos, 5.258 alunos, R$ 17.485.844
--     2025 -> 20.920 titulos, 5.895 alunos, R$ 15.645.258
--     2024 ->  8.245 titulos, 2.691 alunos, R$  5.938.229
--
-- A ordem anterior (relatorio 2026/1 sem negociacao, depois maior saldo) nao
-- errava, mas espalhava a coleta por todos os anos -- entao a conferencia
-- demorava a ficar util para o ano que esta em cobranca.
--
-- Ninguem sai da fila: os outros anos ficam logo atras.

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

comment on function public.prime_cadastro_pendentes(integer) is
  'Fila da coleta Prime: 2026 primeiro (decisao da Amanda, 26/08/2026), depois relatorio 2026/1 sem negociacao, depois maior saldo.';
