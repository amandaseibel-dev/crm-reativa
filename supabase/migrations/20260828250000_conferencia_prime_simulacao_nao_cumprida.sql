-- Quarto sinal: SIMULACAO NAO CUMPRIDA.
--
-- Amanda: "tem muitas simulacoes de acordo que nao foram cumpridas nessa
-- listagem". Ela esta certa, e da para isolar. Dos 2.263 titulos liquidados no
-- Prime sem nenhum pagamento no Santander:
--   1.668 titulos / 963 alunos / R$ 2.407.262,90 -> NENHUM acordo no CRM
--     574 titulos / 233 alunos / R$   664.748,80 -> acordo ATIVO no CRM
--      21 titulos                                -> acordo ja encerrado
--
-- Sao duas conversas OPOSTAS:
--   sem acordo   -> a Ulbra registrou a negociacao no Prime, o aluno nao fechou
--                   nem pagou. A divida e REAL. Nao baixar.
--   acordo ativo -> o titulo virou acordo e continua aberto como mensalidade:
--                   esta sendo cobrado em dobro. Baixar corrige.
--
-- Sem separar os dois, a tela mistura "nao baixe de jeito nenhum" com "baixe
-- que corrige duplicidade".

drop function if exists public.prime_conferencia_fila();

create function public.prime_conferencia_fila()
returns table (
  titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text,
  vencimento date, valor_em_aberto numeric, liquidado_em date,
  tem_acordo_ativo boolean, operador_responsavel text,
  portador int, portador_diz text,
  dinheiro text, dinheiro_diz text,
  lote_titulos numeric, lote_pago numeric, lote_cobertura numeric, lote_diz text,
  acordo_situacao text, acordo_diz text
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
         end,
         ac.situacao,
         case ac.situacao
           when 'SEM_ACORDO'      then 'Liquidou no Prime e não existe acordo no CRM — simulação que não virou nada'
           when 'ACORDO_ATIVO'    then 'Tem acordo ativo: o título virou acordo e segue aberto — cobrança em dobro'
           when 'ACORDO_ENCERRADO' then 'Teve acordo, já encerrado'
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
    join lateral (
      select case
        when exists (select 1 from public.acordos a
                      where a.aluno_id = b.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO')
          then 'ACORDO_ATIVO'
        when exists (select 1 from public.acordos a where a.aluno_id = b.aluno_id)
          then 'ACORDO_ENCERRADO'
        else 'SEM_ACORDO'
      end as situacao
    ) ac on true
    left join lote lo on lo.aluno_id = b.aluno_id and lo.liquidado_em = b.liquidado_em;
$$;

revoke all on function public.prime_conferencia_fila() from public, anon;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;
