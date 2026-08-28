-- Amanda: "tem casos la que nem estao pagos, nao tem vinculo com os relatorios
-- do santander".
--
-- Ela esta certa, e da para provar. Nossa base de pagamentos comeca em
-- 01/07/2026; para titulo liquidado no Prime a partir dessa data, se o dinheiro
-- tivesse entrado nos teriamos o pagamento. Medido em 28/08/2026:
--   2.263 titulos (R$ 3.091.064,77) liquidados SEM nenhum pagamento do aluno
--   1.595 titulos (R$ 1.532.584,75) com pagamento na mesma janela (+/- 5 dias)
--     183 titulos com pagamento, mas em outra data
--
-- Liquidado sem dinheiro entrar = negociacao, nao pagamento. Baixar apagaria
-- divida viva.
--
-- Titulo liquidado ANTES de 01/07 fica como FORA_DA_JANELA (36.895 titulos):
-- ali a ausencia nao prova nada, porque nao importavamos pagamento ainda.
-- Dizer "nao pagou" sobre esses seria mentira estatistica.

drop function if exists public.prime_conferencia_fila();

create function public.prime_conferencia_fila()
returns table (
  titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text,
  vencimento date, valor_em_aberto numeric, liquidado_em date,
  tem_acordo_ativo boolean, operador_responsavel text,
  portador int, portador_diz text,
  dinheiro text, dinheiro_diz text
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '180s'
as $$
  with inicio as (select coalesce(min(data_pagamento), current_date) as d from public.pagamentos)
  select l.titulo_id, l.aluno_id, l.aluno_nome, l.cpf, l.documento,
         l.vencimento, l.valor_em_aberto, l.liquidado_em,
         l.tem_acordo_ativo, l.operador_responsavel,
         pt.carrier_id,
         case pt.carrier_id
           when 195 then 'Prime ainda cobra este título'
           when 166 then 'Prime tirou da cobrança'
           else case when pt.carrier_id is null then 'Prime não informa o portador'
                     else 'Portador ' || pt.carrier_id::text end
         end,
         d.veredito,
         case d.veredito
           when 'ENTROU'     then 'Pagamento do aluno no Santander na mesma janela'
           when 'OUTRA_DATA' then 'Aluno pagou, mas em data diferente da liquidação'
           when 'NAO_ENTROU' then 'Nenhum pagamento do aluno — liquidou sem dinheiro entrar'
           else 'Liquidado antes de a base ter pagamentos — não dá para julgar'
         end
    from public.prime_conferencia_listar() l
    cross join inicio
    left join lateral (
      select p.carrier_id from public.prime_titulo_semestre p
       where p.boleto = l.documento limit 1
    ) pt on true
    join lateral (
      select case
        when l.liquidado_em is null or l.liquidado_em < inicio.d then 'FORA_DA_JANELA'
        when exists (select 1 from public.pagamentos p
                      where p.aluno_id = l.aluno_id
                        and p.data_pagamento between l.liquidado_em - 5 and l.liquidado_em + 5)
          then 'ENTROU'
        when exists (select 1 from public.pagamentos p where p.aluno_id = l.aluno_id)
          then 'OUTRA_DATA'
        else 'NAO_ENTROU'
      end as veredito
    ) d on true
   where not exists (
     select 1 from public.prime_conferencia_decisao dc where dc.titulo_id = l.titulo_id
   );
$$;

revoke all on function public.prime_conferencia_fila() from public, anon;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;
