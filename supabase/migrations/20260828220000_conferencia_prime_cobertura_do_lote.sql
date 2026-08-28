-- Terceiro sinal da Conferencia Prime: a COBERTURA DO LOTE.
--
-- Comparar valor de titulo com valor de pagamento nao funciona: de 1.595
-- titulos com pagamento na janela, so 1 batia exato. O aluno paga varios
-- titulos de uma vez, com juros e honorario embutidos.
--
-- A unidade certa e o lote: aluno + data de liquidacao. Somando os titulos
-- liquidados naquele dia contra tudo que o aluno pagou na janela (+/- 5 dias):
--   1.056 titulos (R$ 832.147,44) -- pagamento cobre o dia inteiro
--     266 titulos (R$ 378.377,74) -- cobre so parte
--     269 titulos (R$ 320.080,16) -- muito abaixo, cheira a negociacao
--
-- E isso que permite baixar um card inteiro com confianca, em vez de titulo a
-- titulo no escuro.

create index if not exists idx_pagamentos_aluno_data
  on public.pagamentos (aluno_id, data_pagamento) where aluno_id is not null;

drop function if exists public.prime_conferencia_fila();

create function public.prime_conferencia_fila()
returns table (
  titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text,
  vencimento date, valor_em_aberto numeric, liquidado_em date,
  tem_acordo_ativo boolean, operador_responsavel text,
  portador int, portador_diz text,
  dinheiro text, dinheiro_diz text,
  lote_titulos numeric, lote_pago numeric, lote_cobertura numeric, lote_diz text
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '180s'
as $$
  with inicio as (select coalesce(min(data_pagamento), current_date) as d from public.pagamentos),
  base as (
    select l.*, pt.carrier_id, inicio.d as inicio_base
      from public.prime_conferencia_listar() l
      cross join inicio
      left join lateral (
        select p.carrier_id from public.prime_titulo_semestre p
         where p.boleto = l.documento limit 1
      ) pt on true
     where not exists (
       select 1 from public.prime_conferencia_decisao dc where dc.titulo_id = l.titulo_id
     )
  ),
  lote as (
    select b.aluno_id, b.liquidado_em,
           sum(b.valor_em_aberto) as soma_titulos,
           (select coalesce(sum(p.valor_pago),0) from public.pagamentos p
             where p.aluno_id = b.aluno_id
               and p.data_pagamento between b.liquidado_em - 5 and b.liquidado_em + 5) as soma_pago
      from base b
     where b.liquidado_em is not null
     group by 1,2
  )
  select b.titulo_id, b.aluno_id, b.aluno_nome, b.cpf, b.documento,
         b.vencimento, b.valor_em_aberto, b.liquidado_em,
         b.tem_acordo_ativo, b.operador_responsavel,
         b.carrier_id,
         case b.carrier_id
           when 195 then 'Prime ainda cobra este título'
           when 166 then 'Prime tirou da cobrança'
           else case when b.carrier_id is null then 'Prime não informa o portador'
                     else 'Portador ' || b.carrier_id::text end
         end,
         d.veredito,
         case d.veredito
           when 'ENTROU'     then 'Pagamento do aluno no Santander na mesma janela'
           when 'OUTRA_DATA' then 'Aluno pagou, mas em data diferente da liquidação'
           when 'NAO_ENTROU' then 'Nenhum pagamento do aluno — liquidou sem dinheiro entrar'
           else 'Liquidado antes de a base ter pagamentos — não dá para julgar'
         end,
         round(lo.soma_titulos, 2), round(lo.soma_pago, 2),
         case when coalesce(lo.soma_titulos,0) > 0
              then round(100.0 * lo.soma_pago / lo.soma_titulos, 0) end,
         case
           when lo.soma_titulos is null then null
           when lo.soma_pago >= lo.soma_titulos * 0.98 then 'O pagamento cobre todos os títulos liquidados neste dia'
           when lo.soma_pago >= lo.soma_titulos * 0.5  then 'O pagamento cobre só parte do que foi liquidado'
           when lo.soma_pago > 0 then 'Pagou muito abaixo do que foi liquidado — provável negociação'
           else null
         end
    from base b
    join lateral (
      select case
        when b.liquidado_em is null or b.liquidado_em < b.inicio_base then 'FORA_DA_JANELA'
        when exists (select 1 from public.pagamentos p
                      where p.aluno_id = b.aluno_id
                        and p.data_pagamento between b.liquidado_em - 5 and b.liquidado_em + 5)
          then 'ENTROU'
        when exists (select 1 from public.pagamentos p where p.aluno_id = b.aluno_id)
          then 'OUTRA_DATA'
        else 'NAO_ENTROU'
      end as veredito
    ) d on true
    left join lote lo on lo.aluno_id = b.aluno_id and lo.liquidado_em = b.liquidado_em;
$$;

revoke all on function public.prime_conferencia_fila() from public, anon;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;
