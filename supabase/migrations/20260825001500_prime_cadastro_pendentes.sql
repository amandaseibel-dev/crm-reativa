-- Fila da atualização cadastral.
--
-- Quem tem dívida em aberto e ainda não foi coletado, do maior saldo para o
-- menor. Recoleta só depois de 7 dias: o banco da Prime atualiza a cada ~4h,
-- mas cadastro não muda de hora em hora e a API cobra 2 a 3 requisições por
-- aluno. Sem essa janela, a coleta ficaria varrendo os mesmos alunos.
--
-- Só o service_role executa -- é a Edge Function `prime-cadastro` que chama.
-- APLICADA EM PROD em 2026-08-24; este arquivo existe para o repositório
-- refletir o banco.

create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table (cpf text, saldo numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
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
   ORDER BY 2 DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;

revoke all on function public.prime_cadastro_pendentes(integer) from public, authenticated;
grant execute on function public.prime_cadastro_pendentes(integer) to service_role;
