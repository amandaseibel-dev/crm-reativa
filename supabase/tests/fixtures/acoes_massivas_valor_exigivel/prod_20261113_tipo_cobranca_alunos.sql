-- CORPO VIVO DE PRODUCAO de public.acoes_massivas_tipo_cobranca_alunos, lido por
-- pg_get_functiondef em 13/11/2026 (leitura somente leitura). md5 = 323628b786a44f2a108210f8beafea8b.
-- ACL publicada: postgres, service_role. Consumidores: acoes_massivas_universo (SECURITY DEFINER).
CREATE OR REPLACE FUNCTION public.acoes_massivas_tipo_cobranca_alunos(p_aluno_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(aluno_id uuid, tem_mensalidade boolean, tem_acordo_vencido boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with mens as (
    select distinct t.aluno_id
      from public.acordos_titulos t
     where (p_aluno_ids is null or t.aluno_id = any(p_aluno_ids))
       and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
       and coalesce(lower(t.status), '') <> 'quitada'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA'))
  ),
  ativo as (
    select distinct a.aluno_id
      from public.acordos a
     where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
       and a.status = 'ATIVO'
  ),
  vencido as (
    select distinct a.aluno_id
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
       and a.status = 'ATIVO'
       and p.status = 'VENCIDA'
  ),
  -- acordo vencido, ou mensalidade sem acordo em dia (acordo ativo sem vencida)
  populacao as (
    select v.aluno_id from vencido v
    union
    select m.aluno_id from mens m
     where not exists (select 1 from ativo x where x.aluno_id = m.aluno_id)
  )
  select p.aluno_id,
         exists (select 1 from mens m where m.aluno_id = p.aluno_id),
         exists (select 1 from vencido v where v.aluno_id = p.aluno_id)
    from populacao p;
$function$
;
