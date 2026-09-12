create or replace function public.invariantes_rodar(p_nome text default null::text)
 returns table(nome text, achados bigint, valor numeric)
 language plpgsql
 security definer
 set search_path to 'public', 'cron'
as $fn$
declare
  v record; v_n bigint; v_v numeric; v_d jsonb;
  v_t timestamptz; v_mv timestamptz;
begin
  for v in select c.nome from public.invariante_config c
           where c.ligado and (p_nome is null or c.nome = p_nome)
           order by c.nome loop
    v_t := clock_timestamp(); v_n := 0; v_v := null; v_d := null;

    case v.nome

      when 'cron_com_falha' then
        select count(*), jsonb_agg(distinct j.jobname)
          into v_n, v_d
          from cron.job_run_details d
          join cron.job j on j.jobid = d.jobid
         where d.status = 'failed'
           and d.start_time > now() - interval '24 hours';

      when 'titulo_aberto_liquidado_no_prime' then
        select count(*), round(sum(t.saldo_corrigido), 2) into v_n, v_v
          from public.acordos_titulos t
          join public.prime_extrato p on p.boleto = t.documento
         where t.status = 'em_aberto'
           and p.liquidado_em is not null
           and p.liquidado_em > p.vencimento + 30
           and p.liquidado_em > t.created_at::date;

      when 'parcela_paga_sem_pagamento' then
        select count(*), round(sum(pa.valor), 2) into v_n, v_v
          from public.parcelas pa
          join public.acordos a on a.id = pa.acordo_id
         where pa.status = 'PAGO'
           and pa.pago_em >= date '2026-06-01'
           and pa.boleto is not null and length(pa.boleto) = 11
           and not exists (
                 select 1 from public.pagamentos g
                  where g.numero_parcela_completo is not null
                    and substring(g.numero_parcela_completo, 2, 7) = substring(pa.boleto, 2, 7))
           and not exists (
                 select 1 from public.pagamentos g2
                  where g2.aluno_id = a.aluno_id
                    and g2.data_pagamento >= date '2026-06-01');

      when 'ficha_com_mais_de_um_cpf' then
        select count(*) into v_n from (
          select t.aluno_id from public.acordos_titulos t
           where t.aluno_id is not null and t.cpf is not null
           group by 1 having count(distinct t.cpf) > 1) x;

      when 'aluno_com_duas_fichas' then
        select count(*) into v_n from (
          select c.cpf from public.casos c
           where coalesce(c.encerrado_operacional, false) = false and c.cpf is not null
           group by 1 having count(*) > 1) y;

      when 'acordo_saldo_vs_parcelas' then
        select count(*), round(sum(x.diferenca), 2) into v_n, v_v from (
          select a.id, abs(a.valor_total - sum(p.valor)) as diferenca
            from public.acordos a
            join public.parcelas p on p.acordo_id = a.id and p.status <> 'CANCELADA'
           where a.status = 'ATIVO'
           group by a.id, a.valor_total
          having abs(a.valor_total - sum(p.valor)) > 0.01) x;

      when 'acordo_quitado_com_parcela_aberta' then
        select count(*), round(sum(x.aberto), 2) into v_n, v_v from (
          select a.id, sum(p.valor) as aberto
            from public.acordos a
            join public.parcelas p on p.acordo_id = a.id
           where a.status = 'QUITADO' and p.status in ('A_VENCER','VENCIDA')
           group by a.id) x;

      when 'caso_saldo_zero_na_fila' then
        select count(*) into v_n from public.casos c
         where coalesce(c.encerrado_operacional, false) = false
           and coalesce(c.saldo_total, c.total_em_aberto, 0) = 0;

      when 'parcela_documento_de_outro_aluno' then
        select count(*) into v_n
          from public.parcelas pa
          join public.acordos a on a.id = pa.acordo_id
          join public.acordos_titulos t on t.documento = substring(pa.boleto, 2, 7)
         where pa.boleto is not null and length(pa.boleto) = 11
           and t.aluno_id is not null and a.aluno_id is not null
           and t.aluno_id <> a.aluno_id;

      when 'matview_saude_velha' then
        select m.atualizado_em into v_mv from public.saude_carteira_mv_meta m limit 1;
        v_n := coalesce(extract(epoch from (now() - v_mv))::bigint / 60, 99999);
        v_d := jsonb_build_object('atualizado_em', v_mv);
        if v_n <= 120 then v_n := 0; end if;

      when 'bordero_atrasado' then
        select coalesce(extract(day from now() - max(i.created_at))::bigint, 999) into v_n
          from public.importacoes i
         where i.tipo = 'BORDERO' and coalesce(i.status, '') <> 'EXCLUIDA';
        if v_n <= 35 then v_n := 0; end if;

      when 'acordo_sem_origem' then
        select count(*), round(sum(a.saldo), 2) into v_n, v_v
          from public.acordos a
         where a.status = 'ATIVO'
           and not exists (select 1 from public.acordos_titulos t where t.acordo_id = a.id);

      when 'acordo_ativo_sem_responsavel' then
        select count(*), round(sum(a.saldo), 2) into v_n, v_v
          from public.acordos a
         where a.status = 'ATIVO' and a.operador_responsavel_email is null;

      when 'ficha_fantasma_com_pagamento' then
        select count(*), round(sum(x.valor), 2) into v_n, v_v from (
          select al.id, sum(g.valor_pago) as valor
            from public.alunos al
            join public.pagamentos g on g.aluno_id = al.id
           where al.cpf is null
             and not exists (select 1 from public.casos c where c.aluno_id = al.id)
             and not exists (select 1 from public.acordos ac where ac.aluno_id = al.id)
           group by al.id) x;

      when 'reabertura_de_ficha_barrada' then
        select count(*) into v_n from public.ficha_reabertura_barrada b
         where b.em > now() - interval '24 hours';

      when 'parcela_com_boleto_de_outro_acordo' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
          join public.acordos a on a.id = p.acordo_id
         where p.boleto is not null and length(p.boleto) = 11
           and a.numero_ulbra is not null
           and substring(p.boleto,2,6) <> lpad(a.numero_ulbra,6,'0');

      when 'parcela_paga_sem_assinatura_nem_pagamento' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
         where p.status = 'PAGO'
           and p.boleto is not null and length(p.boleto) = 11
           and p.confirmado_por_email is null
           and not exists (select 1 from public.pagamentos g
                            where g.numero_parcela_completo = p.boleto);

      when 'baixa_sem_lastro_no_titulo' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
         where p.status = 'PAGO'
           and p.boleto is not null and length(p.boleto) = 11
           and p.confirmado_por_email is null
           and not exists (select 1 from public.pagamentos g
                            where g.numero_parcela_completo is not null
                              and substring(g.numero_parcela_completo,2,6) = substring(p.boleto,2,6));

      when 'acordo_sem_pagamento_com_mensalidade_fora' then
        select count(*), round(sum(x.valor),2) into v_n, v_v from (
          select a.id, coalesce(sum(coalesce(t.valor_original,t.saldo_corrigido,0)),0) valor
            from public.acordos a
            join public.acordo_titulo_vinculo vin on vin.acordo_id = a.id and coalesce(vin.ativo,true)
            join public.acordos_titulos t on t.id = vin.titulo_id and t.status <> 'em_aberto'
           where a.status = 'ATIVO'
             and not exists (select 1 from public.parcelas p
                              where p.acordo_id = a.id and p.status = 'PAGO')
           group by a.id) x;

      when 'parcela_re_acordada_ainda_cobrando' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
          join public.acordos_titulos t on t.documento = '0' || p.boleto
          join public.acordos nv on nv.id = t.acordo_id
         where p.boleto is not null and p.status in ('VENCIDA','A_VENCER')
           and nv.status in ('ATIVO','QUITADO')
           and nv.id <> p.acordo_id
           and exists (select 1 from public.parcelas pp
                        where pp.acordo_id = nv.id and pp.status = 'PAGO');

      when 'mensalidade_presa_em_acordo_cancelado' then
        select count(*), round(sum(coalesce(t.valor_original,t.saldo_corrigido,0)),2) into v_n, v_v
          from public.acordo_titulo_vinculo vin
          join public.acordos a on a.id = vin.acordo_id
                               and upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA')
          join public.acordos_titulos t on t.id = vin.titulo_id
         where t.status = 'vinculada' and upper(coalesce(t.situacao,'')) = 'NEGOCIADO';

      when 'parcela_futura_paga_sem_o_seu_pagamento' then
        select count(*), round(sum(p.valor),2) into v_n, v_v
          from public.parcelas p
         where p.status = 'PAGO'
           and p.vencimento > current_date
           and p.boleto is not null and length(p.boleto) = 11
           and not exists (select 1 from public.pagamentos g
                            where g.numero_parcela_completo = p.boleto);

      -- ------------------------------------------------------------------
      -- NOVOS em 11/09/2026: os cinco que estavam ligados e sem codigo.
      -- Todos somente leitura.
      -- ------------------------------------------------------------------

      -- Mesmo boleto liquidado no MESMO dia mais de uma vez. Data diferente
      -- nao entra: ali e pagamento de residuo, que e legitimo (27 grupos em
      -- prod, nenhum no mesmo dia). O valor e o EXCEDENTE: soma menos o maior.
      when 'pagamento_repetido_no_mesmo_boleto' then
        select count(*), round(coalesce(sum(x.excedente),0),2) into v_n, v_v from (
          select sum(g.valor_pago) - max(g.valor_pago) as excedente
            from public.pagamentos g
           where g.numero_parcela_completo is not null
           group by g.numero_parcela_completo, g.data_pagamento
          having count(*) > 1) x;

      -- Parcela aberta de acordo vivo sem numero de boleto: nunca podera
      -- receber baixa automatica, porque o casamento e pelo boleto.
      when 'parcela_recuperada_sem_boleto' then
        select count(*), round(coalesce(sum(p.valor),0),2) into v_n, v_v
          from public.parcelas p
          join public.acordos a on a.id = p.acordo_id
         where nullif(p.boleto,'') is null
           and upper(coalesce(a.status,'')) in ('ATIVO','QUITADO')
           and upper(coalesce(p.status,'')) in ('A_VENCER','VENCIDA');

      -- Baixa ASSINADA (tem confirmado_por_email) na parcela errada: o boleto
      -- dela nao tem pagamento, mas existe pagamento de OUTRA parcela do mesmo
      -- acordo. Diferente de baixa_sem_lastro, que olha a falta de assinatura.
      when 'baixa_manual_na_parcela_errada' then
        select count(*), round(coalesce(sum(p.valor),0),2) into v_n, v_v
          from public.parcelas p
         where p.status = 'PAGO'
           and p.confirmado_por_email is not null
           and p.boleto is not null and length(p.boleto) = 11
           and not exists (select 1 from public.pagamentos g
                            where g.numero_parcela_completo = p.boleto)
           and exists (select 1 from public.pagamentos g2
                        where g2.numero_parcela_completo is not null
                          and substring(g2.numero_parcela_completo,2,6) = substring(p.boleto,2,6));

      -- Subconjunto RECUPERAVEL de acordo_sem_origem: acordo sem titulo e sem
      -- vinculo, com parcela paga, cujo aluno tem UMA unica data de liquidacao
      -- no Prime -- a origem da negociacao e dedutivel sem ambiguidade.
      when 'acordo_sem_origem_deduzivel' then
        select count(*), round(coalesce(sum(a.saldo),0),2) into v_n, v_v
          from public.acordos a
         where a.status in ('ATIVO','QUITADO')
           and not exists (select 1 from public.acordos_titulos t where t.acordo_id = a.id)
           and not exists (select 1 from public.acordo_titulo_vinculo v2
                            where v2.acordo_id = a.id and coalesce(v2.ativo,true))
           and exists (select 1 from public.parcelas p
                        where p.acordo_id = a.id and p.status = 'PAGO')
           and (select count(distinct pe.liquidado_em)
                  from public.acordos_titulos t2
                  join public.prime_extrato pe on pe.boleto = t2.documento
                                              and pe.liquidado_em is not null
                 where t2.aluno_id = a.aluno_id
                   and coalesce(t2.tipo_boleto,'') <> 'Acordo'
                   and t2.status = 'em_aberto') = 1;

      -- Re-acordo de re-acordo: parcela RENEGOCIADA cujo acordo de destino
      -- tambem tem parcela RENEGOCIADA. Cadeia assim e onde a divida se perde.
      when 'renegociacao_em_cadeia' then
        select count(*), round(coalesce(sum(p.valor),0),2) into v_n, v_v
          from public.parcelas p
         where p.status = 'RENEGOCIADA'
           and p.renegociada_no_acordo_id is not null
           and exists (select 1 from public.parcelas p2
                        where p2.acordo_id = p.renegociada_no_acordo_id
                          and p2.status = 'RENEGOCIADA');

      else v_n := 0;
    end case;

    insert into public.invariante_resultado (nome, achados, valor, detalhe, duracao_ms)
    values (v.nome, coalesce(v_n, 0), v_v, v_d,
            extract(milliseconds from clock_timestamp() - v_t)::int);

    nome := v.nome; achados := coalesce(v_n, 0); valor := v_v; return next;
  end loop;
end;
$fn$;

update public.invariante_config
   set ligado = false,
       explicacao = coalesce(explicacao,'')
         || ' [DESLIGADO 11/09/2026: as duas regras testadas nao agregam. Pelo'
         || ' sufixo do boleto daria 5.909 achados, que e o deslocamento de'
         || ' sufixo conhecido e aceito (ruido permanente). Pelo prefixo do'
         || ' acordo daria 49 / R$ 89.081,49, exatamente o que'
         || ' parcela_com_boleto_de_outro_acordo ja mede.]'
 where nome = 'boleto_amarrado_na_parcela_errada';
