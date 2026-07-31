-- ============================================================================
-- CALIBRAGEM — CRITICIDADE AUTOMÁTICA PARAMETRIZÁVEL (item 5)
-- ----------------------------------------------------------------------------
-- Motor de PONTUAÇÃO configurável. NÃO altera a lógica da fila operacional nem
-- a coluna casos.criticidade (que a fila usa). Apenas DERIVA um nível
-- (CRITICO/URGENTE/ATENCAO/NORMAL) para exibição na Calibragem e novos módulos.
--
-- Regras em calibragem_parametros.criticidade_regras (editável pela gestão):
--   pesos: cada sinal disparado soma um peso; niveis: pontuação mínima por nível.
-- Sinais: dias vencido, dias sem acionamento, valor, termo pendente,
--   proximidade do fim do mês (parametrizável e extensível).
-- Reversível.
-- ============================================================================

begin;

-- Regras padrão (scoring) — sobrescreve o placeholder anterior ----------------
update public.calibragem_parametros
   set valor = '{
     "pesos": {
       "dias_vencido":        {"min": 5,    "peso": 2},
       "dias_sem_acionamento":{"min": 10,   "peso": 2},
       "valor":               {"min": 5000, "peso": 1},
       "termo_pendente":      {"peso": 2},
       "fim_mes":             {"dias": 5, "peso": 1}
     },
     "niveis": {"critico": 5, "urgente": 3, "atencao": 1}
   }'::jsonb,
       descricao = 'Motor de criticidade automática (scoring). Editável pela gestão.',
       atualizado_em = now(), atualizado_por = 'migration:criticidade_auto'
 where chave = 'criticidade_regras';

-- Função pura de nível (score -> nível) --------------------------------------
create or replace function public.calibragem_nivel_criticidade(
  p_dias_venc int, p_dias_sem_ac int, p_valor numeric,
  p_termo_pendente boolean, p_fim_mes boolean, p_regras jsonb
) returns text language plpgsql immutable as $$
declare s numeric := 0; p jsonb := p_regras->'pesos'; n jsonb := p_regras->'niveis';
begin
  if coalesce(p_dias_venc,0)    >= coalesce((p->'dias_vencido'->>'min')::int, 2147483647)          then s := s + coalesce((p->'dias_vencido'->>'peso')::numeric,0); end if;
  if coalesce(p_dias_sem_ac,0)  >= coalesce((p->'dias_sem_acionamento'->>'min')::int, 2147483647)   then s := s + coalesce((p->'dias_sem_acionamento'->>'peso')::numeric,0); end if;
  if coalesce(p_valor,0)        >= coalesce((p->'valor'->>'min')::numeric, 1e18)                     then s := s + coalesce((p->'valor'->>'peso')::numeric,0); end if;
  if coalesce(p_termo_pendente,false)                                                                then s := s + coalesce((p->'termo_pendente'->>'peso')::numeric,0); end if;
  if coalesce(p_fim_mes,false)                                                                       then s := s + coalesce((p->'fim_mes'->>'peso')::numeric,0); end if;
  if    s >= coalesce((n->>'critico')::numeric, 5) then return 'CRITICO';
  elsif s >= coalesce((n->>'urgente')::numeric, 3) then return 'URGENTE';
  elsif s >= coalesce((n->>'atencao')::numeric, 1) then return 'ATENCAO';
  else  return 'NORMAL'; end if;
end; $$;
revoke all on function public.calibragem_nivel_criticidade(int,int,numeric,boolean,boolean,jsonb) from public;
grant execute on function public.calibragem_nivel_criticidade(int,int,numeric,boolean,boolean,jsonb) to authenticated;

-- Distribuição da criticidade automática por operador (on-demand, ~4k casos) --
create or replace function public.calibragem_criticidade_auto()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_regras jsonb := coalesce((select valor from public.calibragem_parametros where chave='criticidade_regras'), '{}'::jsonb);
  v_fim_mes_dias int := coalesce((v_regras->'pesos'->'fim_mes'->>'dias')::int, 5);
  v_fim_mes boolean := (date_trunc('month', now()) + interval '1 month - 1 day')::date - current_date <= v_fim_mes_dias;
  v_ops jsonb;
begin
  if not public.calibragem_e_gestao() then raise exception 'Sem permissão.'; end if;

  with base as (
    select c.operador_email op_email, max(c.operador_nome) op_nome,
           public.calibragem_nivel_criticidade(
             coalesce(c.dias_atraso,0),
             case when c.data_ultimo_acionamento is null then 9999 else (current_date - c.data_ultimo_acionamento) end,
             coalesce(s.saldo_total,0),
             (c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')),
             v_fim_mes, v_regras) as nivel,
           coalesce(s.saldo_total,0) as saldo
    from public.casos c
    left join public.calibragem_saldo_aluno s on s.aluno_id=c.aluno_id
    where c.operador_email is not null
    group by c.operador_email, c.id, c.dias_atraso, c.data_ultimo_acionamento, c.status_termo, c.termo_status_validacao, s.saldo_total
  ),
  agg as (
    select op_email, max(op_nome) op_nome,
      count(*) filter (where nivel='CRITICO') c_q, coalesce(sum(saldo) filter (where nivel='CRITICO'),0) c_v,
      count(*) filter (where nivel='URGENTE') u_q, coalesce(sum(saldo) filter (where nivel='URGENTE'),0) u_v,
      count(*) filter (where nivel='ATENCAO') a_q, coalesce(sum(saldo) filter (where nivel='ATENCAO'),0) a_v,
      count(*) filter (where nivel='NORMAL')  n_q, coalesce(sum(saldo) filter (where nivel='NORMAL'),0) n_v
    from base group by op_email
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'operador_email', op_email, 'operador_nome', op_nome,
    'critico', jsonb_build_object('qtd',c_q,'valor',round(c_v,2)),
    'urgente', jsonb_build_object('qtd',u_q,'valor',round(u_v,2)),
    'atencao', jsonb_build_object('qtd',a_q,'valor',round(a_v,2)),
    'normal',  jsonb_build_object('qtd',n_q,'valor',round(n_v,2))
  ) order by op_nome), '[]'::jsonb) into v_ops from agg;

  return jsonb_build_object('config', v_regras, 'fim_mes', v_fim_mes, 'operadores', v_ops);
end; $$;
revoke all on function public.calibragem_criticidade_auto() from public;
grant execute on function public.calibragem_criticidade_auto() to authenticated;

commit;
