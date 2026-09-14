CREATE OR REPLACE FUNCTION public.resumo_carteira_operador(p_email text)
 RETURNS TABLE(qtd_alunos bigint, valor_em_aberto numeric, valor_a_vencer numeric, valor_vencido numeric, qtd_negociados bigint, valor_pago_mes numeric, honorario_mes numeric, proxima_meta_valor numeric, proxima_meta_pct numeric, falta_proxima_meta numeric, dias_uteis_restantes integer, precisa_por_dia numeric, no_topo boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_mes text := to_char(current_date,'YYYY-MM');
  v_fim date := (date_trunc('month',current_date) + interval '1 month' - interval '1 day')::date;
  v_m1v numeric; v_m1p numeric; v_m2v numeric; v_m2p numeric;
  v_m3v numeric; v_m3p numeric; v_m4v numeric; v_m4p numeric;
  v_hon numeric; v_pago numeric;
  v_prox_v numeric := null; v_prox_p numeric := null;
  v_dias int; v_topo boolean := false;
BEGIN
  SELECT * INTO r FROM (
    select
      count(distinct a.id) as qtd_alunos,
      coalesce(sum(t.saldo_corrigido), 0) as valor_em_aberto,
      coalesce(sum(t.saldo_corrigido) filter (where t.vencimento >= current_date), 0) as valor_a_vencer,
      coalesce(sum(t.saldo_corrigido) filter (where t.vencimento < current_date), 0) as valor_vencido,
      count(distinct a.id) filter (where a.status_jornada = 'ACORDO_FECHADO') as qtd_negociados
    from public.alunos a
    left join public.acordos_titulos t on t.cpf = a.cpf
      and upper(coalesce(t.situacao,''))='ABERTO' and lower(coalesce(t.status,''))<>'quitada'
      and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id=t.id)
    where a.responsavel_atual_email = p_email
      and not public.caso_encerrado_operacional(a.cpf,a.status_atual,a.status_acionamento,null::text,a.status_jornada)
      and coalesce(a.status_jornada,'') not in ('AGUARDANDO_BAIXA','BAIXA_REALIZADA')
      and coalesce(a.status_atual,'')   not in ('AGUARDANDO_BAIXA','BAIXA_REALIZADA')
  ) x;

  SELECT coalesce(sum(valor_pago),0), coalesce(sum(valor_honorario),0)
    INTO v_pago, v_hon
  FROM public.pagamentos
  WHERE lower(operador_email)=lower(p_email)
    AND to_char(data_pagamento,'YYYY-MM')=v_mes;

  SELECT m1_valor,m1_percentual,m2_valor,m2_percentual,m3_valor,m3_percentual,m4_valor,m4_percentual
    INTO v_m1v,v_m1p,v_m2v,v_m2p,v_m3v,v_m3p,v_m4v,v_m4p
  FROM public.metas_projecao WHERE mes_referencia=v_mes;
  v_m1v:=coalesce(v_m1v,0); v_m2v:=coalesce(v_m2v,0); v_m3v:=coalesce(v_m3v,0); v_m4v:=coalesce(v_m4v,0);

  -- proxima faixa nao atingida (menor limite acima do honorario atual)
  IF v_m1v>0 AND v_hon < v_m1v THEN v_prox_v:=v_m1v; v_prox_p:=v_m1p;
  ELSIF v_m2v>0 AND v_hon < v_m2v THEN v_prox_v:=v_m2v; v_prox_p:=v_m2p;
  ELSIF v_m3v>0 AND v_hon < v_m3v THEN v_prox_v:=v_m3v; v_prox_p:=v_m3p;
  ELSIF v_m4v>0 AND v_hon < v_m4v THEN v_prox_v:=v_m4v; v_prox_p:=v_m4p;
  ELSE v_topo:=true;
  END IF;

  SELECT count(*) INTO v_dias
  FROM generate_series(current_date, v_fim, interval '1 day') d
  WHERE extract(isodow FROM d) < 6;

  qtd_alunos := r.qtd_alunos; valor_em_aberto := r.valor_em_aberto;
  valor_a_vencer := r.valor_a_vencer; valor_vencido := r.valor_vencido;
  qtd_negociados := r.qtd_negociados;
  valor_pago_mes := v_pago; honorario_mes := v_hon;
  proxima_meta_valor := v_prox_v; proxima_meta_pct := v_prox_p;
  falta_proxima_meta := CASE WHEN v_prox_v IS NULL THEN 0 ELSE greatest(v_prox_v - v_hon, 0) END;
  dias_uteis_restantes := v_dias;
  precisa_por_dia := CASE WHEN v_prox_v IS NULL OR v_dias<=0 THEN 0
                         ELSE round(greatest(v_prox_v - v_hon,0)/v_dias, 2) END;
  no_topo := v_topo;
  RETURN NEXT;
END;
$function$
