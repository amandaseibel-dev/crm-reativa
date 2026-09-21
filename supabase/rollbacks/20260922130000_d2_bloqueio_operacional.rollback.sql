-- ROLLBACK de 20260922130000: volta gerar/resolver ao texto de 20260922110000 e remove o helper.
-- Alertas ja fechados com resolucao 'BLOQUEADO' passam a 'SUBSTITUIDA' (o check antigo nao conhece o valor); nao ha alerta ativo afetado.
begin;
update public.acordo_alertas_parcela set resolucao = 'SUBSTITUIDA' where resolucao = 'BLOQUEADO';
alter table public.acordo_alertas_parcela drop constraint if exists acordo_alertas_parcela_resolucao_check;
alter table public.acordo_alertas_parcela add constraint acordo_alertas_parcela_resolucao_check
  check (resolucao in ('PAGA','ACORDO_QUITADO','ACORDO_CANCELADO','VENCIDA','SUBSTITUIDA'));
CREATE OR REPLACE FUNCTION public.acordo_alertas_resolver(p_hoje date DEFAULT current_date)
 RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare n int;
begin
  update public.acordo_alertas_parcela x set resolvido_em = now(), resolucao = q.res
    from (
      select x2.id, case
               when upper(coalesce(a.status,'')) = 'QUITADO' then 'ACORDO_QUITADO'
               when upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA') then 'ACORDO_CANCELADO'
               when upper(coalesce(p.status,'')) = 'PAGO' then 'PAGA'
               when upper(coalesce(p.status,'')) in ('CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') then 'SUBSTITUIDA'
               when p.vencimento < p_hoje then 'VENCIDA' end res
        from public.acordo_alertas_parcela x2
        join public.acordos a on a.id = x2.acordo_id join public.parcelas p on p.id = x2.parcela_id
       where x2.resolvido_em is null) q
   where x.id = q.id and q.res is not null;
  get diagnostics n = row_count; return n;
end;
$function$;

CREATE OR REPLACE FUNCTION public.acordo_alertas_gerar(p_hoje date DEFAULT current_date, p_dias int DEFAULT NULL, p_modo text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_cfg jsonb; v_dias int; v_modo text; v_res int; v_novos int;
begin
  v_cfg  := coalesce((select valor from public.calibragem_parametros where chave = 'alerta_parcela_d2'), '{}'::jsonb);
  v_dias := coalesce(p_dias, nullif(v_cfg->>'dias','')::int, 2);
  v_modo := upper(coalesce(p_modo, nullif(v_cfg->>'modo',''), 'CORRIDO'));
  v_res  := public.acordo_alertas_resolver(p_hoje);
  insert into public.acordo_alertas_parcela (acordo_id, parcela_id, aluno_id, tipo, numero_parcela, vencimento, valor, data_alerta, responsavel_email)
  select a.id, p.id, a.aluno_id, 'D2', p.numero, p.vencimento, p.valor, public.acordo_alerta_data(p.vencimento, v_dias, v_modo),
         coalesce(nullif(btrim(a.operador_responsavel_email),''), nullif(btrim(al.responsavel_atual_email),''))
    from public.acordos a
    join public.parcelas p on p.acordo_id = a.id
    left join public.alunos al on al.id = a.aluno_id
   where upper(coalesce(a.status,'')) = 'ATIVO'
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
     and p.vencimento >= p_hoje
     and p_hoje >= public.acordo_alerta_data(p.vencimento, v_dias, v_modo)
     and public.acordo_classificar(a.id, p_hoje)->>'classe' = 'em_dia'      -- acordo com parcela vencida ja esta na cobranca normal: sem D2
  on conflict (acordo_id, parcela_id, tipo) where resolvido_em is null do nothing;
  get diagnostics v_novos = row_count;
  return jsonb_build_object('hoje', p_hoje, 'dias', v_dias, 'modo', v_modo, 'resolvidos', v_res, 'criados', v_novos);
end;
$function$;
drop function if exists public.aluno_bloqueado_para_d2(uuid);
commit;
