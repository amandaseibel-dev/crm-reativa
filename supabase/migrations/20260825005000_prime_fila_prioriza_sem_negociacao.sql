-- A fila da atualização cadastral passa a atender PRIMEIRO quem está no
-- relatório "Mensalidades 2026/1 sem negociação" -- os 2.853 CPFs de jan–maio
-- que a operação ainda precisa trabalhar. Depois deles, o resto dos devedores,
-- sempre do maior saldo para o menor.
--
-- Por que importa: antes a fila ia pelo saldo puro e misturava quem já
-- negociou com quem não negociou. Pedido da Amanda: a faixa de 2026 primeiro.
--
-- APLICADA EM PROD em 2026-08-25. Conferido: as 500 primeiras da fila são
-- todas da faixa, de R$ 77.471,78 a R$ 4.426,62.

create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table (cpf text, saldo numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  WITH sem_negociacao AS (
    SELECT DISTINCT cpf FROM public._relatorio_2026_1_eleg()
  ),
  devedores AS (
    SELECT lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') AS cpf,
           round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 2) AS saldo
      FROM public.acordos_titulos t
     WHERE lower(coalesce(t.status,'')) = 'em_aberto'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND length(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g')) = 11
       AND NOT EXISTS (
             SELECT 1 FROM public.prime_contratos c
              WHERE c.cpf = lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0')
                AND c.coletado_em > now() - interval '7 days'
           )
     GROUP BY 1
  )
  SELECT d.cpf, d.saldo
    FROM devedores d
   ORDER BY (EXISTS (SELECT 1 FROM sem_negociacao s WHERE s.cpf = d.cpf)) DESC,
            d.saldo DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;

revoke all on function public.prime_cadastro_pendentes(integer) from public, authenticated;
grant execute on function public.prime_cadastro_pendentes(integer) to service_role;
