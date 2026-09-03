-- Desfaz 20260902310000_criticidade_auto_conta_perdendo.sql
-- Volta `calibragem_criticidade_auto` aos quatro baldes originais.
-- Atencao: com a escada ligada, isto faz os casos em PERDENDO sumirem do
-- painel da gestao -- so rodar junto com o rollback de 20260902300000.

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
      count(*) filter (where nivel='CRITICO') c_q, coalesce(sum(saldo) filter (where nivel='CRITICO'),0) c_v,
      count(*) filter (where nivel='URGENTE') u_q, coalesce(sum(saldo) filter (where nivel='URGENTE'),0) u_v,
      count(*) filter (where nivel='ATENCAO') a_q, coalesce(sum(saldo) filter (where nivel='ATENCAO'),0) a_v,
      count(*) filter (where nivel='NORMAL')  n_q, coalesce(sum(saldo) filter (where nivel='NORMAL'),0) n_v
    from base group by op_email
  )
  select coalesce(jsonb_agg(jsonb_build_object('operador_email', op_email, 'operador_nome', op_nome,
    'critico', jsonb_build_object('qtd',c_q,'valor',round(c_v,2)),
    'urgente', jsonb_build_object('qtd',u_q,'valor',round(u_v,2)),
    'atencao', jsonb_build_object('qtd',a_q,'valor',round(a_v,2)),
    'normal',  jsonb_build_object('qtd',n_q,'valor',round(n_v,2))) order by op_nome), '[]'::jsonb) into v_ops from agg;
  return jsonb_build_object('config', v_regras, 'fim_mes', v_fim_mes, 'operadores', v_ops);
end; $function$;
