-- Dois boletos de acordo com os MESMOS vencimentos = mesma divida renegociada.
--
-- Amanda, 31/08: "precisamos fazer que o sistema entenda que o novo acordo
-- importado e das mesmas parcelas e desconsidere o antigo acordo importado --
-- nem sempre aquele que fechamos inicialmente e formalizado".
--
-- QUEM MANDA E O BOLETO, nao o numero do acordo no CRM. Caso que revelou isso,
-- Gilberto Dias Junior:
--     acordo 3331 (criado 12/08) -> boleto 06958  R$ 26.667,44
--     acordo 3410 (criado 18/08) -> boleto 06858  R$ 26.614,71
-- O acordo de numero MAIOR carrega o boleto MAIS VELHO. Nem o primeiro fechado
-- nem o ultimo lancado e o formalizado -- so o boleto diz.
--
-- Os dois boletos tem os MESMOS 6 vencimentos (09/2026 a 02/2027) e R$ 52,73 de
-- diferenca, que e juros do dia da emissao. Ninguem faz dois acordos com as
-- mesmas datas: e um so, renegociado, contado duas vezes.
--
-- CRITERIO ESTREITO DE PROPOSITO: exige conjunto de vencimentos IDENTICO. Isso
-- preserva a regra de 27/08 -- acordo novo NAO substitui o anterior quando sao
-- dividas diferentes. Marcos Paulo Silva Queiroz tem dois boletos (06922 e
-- 06924) com 1 e 2 parcelas, vencimentos diferentes e R$ 3.886,08 de diferenca:
-- dividas distintas, nao e tocado.
--
-- SINALIZA, NAO CANCELA -- e de proposito. Os dois boletos do Gilberto vieram
-- no MESMO arquivo ("Relatorio Titulos em Aberto ( - ) (3).xls", 18/08): a
-- Ulbra lista os dois como cobraveis na mesma foto. Cancelar por inferencia
-- apagaria divida que a fonte ainda cobra -- a mesma armadilha de
-- `parcela-igual-a-soma-e-entrada-de-50`. A decisao fica na tela de duplicados,
-- para quem pode conferir com a Ulbra.
--
-- Nunca sinaliza acordo com parcela paga ou baixa ativa.

create or replace function public.acordos_sinalizar_boleto_repetido()
returns jsonb
language plpgsql security definer
set search_path to 'public' set statement_timeout to '300s'
as $function$
declare v_n int := 0;
begin
  with bol as (
    select t.aluno_id, substr(t.documento,3,5) titulo,
           array_agg(t.vencimento order by t.vencimento) vencs,
           round(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),2) valor
      from public.acordos_titulos t
     where coalesce(t.tipo_boleto,'')='Acordo' and t.documento ~ '^\d{12}$'
     group by 1,2
  ), par as (
    select velho.aluno_id, velho.valor v_velho, novo.valor v_novo
      from bol velho join bol novo
        on novo.aluno_id = velho.aluno_id and novo.titulo > velho.titulo
       and novo.vencs = velho.vencs
  ), acordo as (
    select p.aluno_id,
           (select a.id from public.acordos a where a.aluno_id=p.aluno_id
             and abs(round(a.valor_total,2) - p.v_velho) <= 0.05
             and upper(coalesce(a.status,''))='ATIVO' order by a.numero_acordo desc limit 1) id_velho,
           (select a.id from public.acordos a where a.aluno_id=p.aluno_id
             and abs(round(a.valor_total,2) - p.v_novo) <= 0.05
             and upper(coalesce(a.status,''))='ATIVO' order by a.numero_acordo desc limit 1) id_novo
      from par p
  )
  update public.acordos a
     set duplicado_de = ac.id_novo, duplicado_marcado_em = now()
    from acordo ac
   where a.id = ac.id_velho and ac.id_novo is not null and ac.id_velho <> ac.id_novo
     and a.duplicado_de is null
     and not exists (select 1 from public.parcelas p where p.acordo_id=a.id and p.status='PAGO')
     and not exists (select 1 from public.baixas_pagamento b where b.acordo_id=a.id and b.devolvido_em is null);
  get diagnostics v_n = row_count;
  return jsonb_build_object('sinalizados', v_n);
end;
$function$;

revoke all on function public.acordos_sinalizar_boleto_repetido() from public, anon;
grant execute on function public.acordos_sinalizar_boleto_repetido() to authenticated, service_role;

select cron.schedule('acordos_sinalizar_boleto_repetido','40 * * * *',
  'select public.acordos_sinalizar_boleto_repetido();');
