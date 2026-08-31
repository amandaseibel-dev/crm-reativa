-- Previa da baixa por documento, com o desenho das mensalidades do acordo.
--
-- Amanda, 31/08: "hoje se conseguimos casar o numero do documento com a baixa
-- ja ajudaria muito, e ter o desenho das mensalidades que estao vinculadas
-- aquele acordo para fazer automaticamente" e "consegue baixar o valor pago e
-- honorario e o operador?".
--
-- MEDIDO EM 31/08, pagamentos desde julho com documento:
--   355 casam com parcela ABERTA e valor exato -- R$ 268.837,61, 271 acordos
--   353 das 355 trazem honorario (R$ 19.634,26) e 355 trazem operador (37)
--   so 17 parcelas tem honorario gravado no CRM (R$ 1.193,12): o extrato e
--   MAIS completo, entao a baixa tambem corrige o honorario que falta aqui
--
-- O DESENHO so existe em 51 das 355. Nas outras 304 o acordo nao tem vinculo
-- com mensalidade nenhuma -- ver abaixo.
--
-- DESCOBERTA: os 8.465 pagamentos com documento tem TODOS o mesmo formato --
-- 11 digitos comecando com "50". O extrato Santander so traz BOLETO DE ACORDO;
-- pagamento de mensalidade avulsa nao passa por ali. Logo, "aluno sem acordo no
-- CRM" nao quer dizer que pagou mensalidade: quer dizer que pagou um boleto de
-- acordo cujo acordo nao esta aqui (3.647 pagamentos, R$ 3.818.046,82).
--
-- POR QUE O DESENHO FALTA (Amanda: "tem acordos antigos que vieram para o
-- sistema sem as mensalidades"). Dos 2.390 acordos sem vinculo ativo:
--    737 acordos / 689 alunos / R$ 2.218.961,42 -> o aluno nao tem mensalidade
--        NENHUMA na base. O desenho e impossivel: a origem nunca entrou.
--  1.218 acordos / 1.145 alunos / R$ 4.665.156,72 -> tem mensalidade ABERTA,
--        da para vincular (com a ressalva de acordo menor que a divida).
--    435 acordos / R$ 2.815.714,24 -> tem mensalidade, nenhuma aberta.
--
-- Esta funcao NAO da baixa -- so mostra o que seria baixado, linha a linha.

create or replace function public.baixa_por_documento_previa(
  p_desde date default '2026-07-01'::date
)
returns table (
  pagamento_id uuid, aluno_id uuid, aluno_nome text, operador text,
  documento text, data_pagamento date, valor_pago numeric,
  acordo_numero int, parcela_numero int, parcela_valor numeric, parcela_status text,
  mensalidades_vinculadas int, mensalidades_valor numeric, mensalidades_desenho text
)
language plpgsql stable security definer
set search_path to 'public' set statement_timeout to '300s'
as $function$
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  return query
  select p.id, a.aluno_id, al.nome, coalesce(p.operador_nome,'(sem operador)'),
         pa.boleto, p.data_pagamento, p.valor_pago,
         a.numero_acordo, pa.numero, pa.valor, pa.status,
         coalesce(m.qtd,0)::int, coalesce(m.valor,0),
         coalesce(m.desenho, '(acordo sem mensalidade vinculada)')
    from public.pagamentos p
    join public.parcelas pa on pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
    join public.acordos a on a.id = pa.acordo_id
    join public.alunos al on al.id = a.aluno_id
    left join lateral (
      select count(*) qtd,
             round(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),2) valor,
             string_agg(t.documento || ' venc ' || to_char(t.vencimento,'DD/MM/YYYY')
                        || ' R$ ' || round(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0),2)::text,
                        ' | ' order by t.vencimento) desenho
        from public.acordo_titulo_vinculo v
        join public.acordos_titulos t on t.id = v.titulo_id
       where v.acordo_id = a.id and coalesce(v.ativo,true)
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
    ) m on true
   where p.data_pagamento >= p_desde
     and coalesce(p.numero_parcela_completo,'') <> ''
     and pa.status in ('A_VENCER','VENCIDA')
     and abs(pa.valor - p.valor_pago) <= 0.05
   order by p.data_pagamento, al.nome;
end;
$function$;

revoke all on function public.baixa_por_documento_previa(date) from public, anon;
grant execute on function public.baixa_por_documento_previa(date) to authenticated, service_role;
