-- O painel de criticidade da gestao passa a contar o nivel PERDENDO.
--
-- `calibragem_criticidade_auto` somava por balde fixo -- CRITICO, URGENTE,
-- ATENCAO, NORMAL. Com a escada de 20260902300000, os casos que caem em
-- PERDENDO nao entravam em nenhum balde e sumiam do total do operador.
-- Em prod isso seriam 671 casos invisiveis no painel.
--
-- Unica mudanca: balde `perdendo` na agregacao e no JSON de saida. O front lê
-- em src/pages/Calibragem.jsx (NIVEIS_CRIT).

create or replace function public.calibragem_criticidade_auto()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_regras jsonb := coalesce((select valor from public.calibragem_parametros where chave='criticidade_regras'), '{}'::jsonb);
  v_fim_mes_dias int := coalesce((v_regras->'pesos'->'fim_mes'->>'dias')::int, 5);
  v_fim_mes boolean := (date_trunc('month', now()) + interval '1 month - 1 day')::date - current_date <= v_fim_mes_dias;
  v_ops jsonb;
begin
  if not public.calibragem_e_gestao() then raise exception 'Sem permissão.'; end if;
  with base as (
    select c.operador_email op_email, c.operador_nome op_nome,
           public.calibragem_nivel_criticidade(
             coalesce(c.dias_atraso,0),
             case when c.data_ultimo_acionamento is null then 9999 else (current_date - c.data_ultimo_acionamento) end,
             coalesce(s.saldo_total,0),
             (c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')),
             v_fim_mes, v_regras) as nivel,
           coalesce(s.saldo_total,0) as saldo
    from public.casos c left join public.calibragem_saldo_aluno s on s.aluno_id=c.aluno_id
    where c.operador_email is not null
  ),
  agg as (
    select op_email, max(op_nome) op_nome,
      count(*) filter (where nivel='PERDENDO') p_q, coalesce(sum(saldo) filter (where nivel='PERDENDO'),0) p_v,
      count(*) filter (where nivel='CRITICO') c_q, coalesce(sum(saldo) filter (where nivel='CRITICO'),0) c_v,
      count(*) filter (where nivel='URGENTE') u_q, coalesce(sum(saldo) filter (where nivel='URGENTE'),0) u_v,
      count(*) filter (where nivel='ATENCAO') a_q, coalesce(sum(saldo) filter (where nivel='ATENCAO'),0) a_v,
      count(*) filter (where nivel='NORMAL')  n_q, coalesce(sum(saldo) filter (where nivel='NORMAL'),0) n_v
    from base group by op_email
  )
  select coalesce(jsonb_agg(jsonb_build_object('operador_email', op_email, 'operador_nome', op_nome,
    'perdendo', jsonb_build_object('qtd',p_q,'valor',round(p_v,2)),
    'critico', jsonb_build_object('qtd',c_q,'valor',round(c_v,2)),
    'urgente', jsonb_build_object('qtd',u_q,'valor',round(u_v,2)),
    'atencao', jsonb_build_object('qtd',a_q,'valor',round(a_v,2)),
    'normal',  jsonb_build_object('qtd',n_q,'valor',round(n_v,2))) order by op_nome), '[]'::jsonb) into v_ops from agg;
  return jsonb_build_object('config', v_regras, 'fim_mes', v_fim_mes, 'operadores', v_ops);
end; $function$;
