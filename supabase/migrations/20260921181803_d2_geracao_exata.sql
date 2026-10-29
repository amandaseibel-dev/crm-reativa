-- D-2 EXATO. A geracao passa de JANELA ACUMULADA (hoje >= data do alerta) para o DIA EXATO (hoje = data do alerta).
-- Regra de negocio: o alerta nasce somente quando current_date = vencimento - 2 dias corridos (modo CORRIDO; no modo UTIL, a data ja calculada
-- por acordo_alerta_data). D-1, vence hoje e vencida NAO geram retroativamente; rodada perdida nao e recuperada depois.
-- Unica mudanca: a condicao  p_hoje >= acordo_alerta_data(...)  virou  p_hoje = acordo_alerta_data(...). Todo o resto da funcao e igual
-- (parcela aberta e futura, acordo ATIVO e em_dia, aluno nao bloqueado (PR #444), idempotencia por indice unico parcial).
-- acordo_alertas_resolver NAO muda: alerta criado em D-2 continua aberto em D-1/D-0 e so fecha por PAGA/QUITADO/CANCELADO/SUBSTITUIDA/BLOQUEADO/VENCIDA.
-- Esta migration NAO executa acordo_alertas_gerar, nao cria alertas nem cron. ACL preservada (CREATE OR REPLACE) e reafirmada.
begin;
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
     and p_hoje = public.acordo_alerta_data(p.vencimento, v_dias, v_modo)     -- D-2 EXATO: so no proprio dia do alerta; dia perdido nao e recuperado
     and public.acordo_classificar(a.id, p_hoje)->>'classe' = 'em_dia'      -- acordo com parcela vencida ja esta na cobranca normal: sem D2
     and not public.aluno_bloqueado_para_d2(a.aluno_id)                    -- aluno que nao pode ser acionado: sem D2
  on conflict (acordo_id, parcela_id, tipo) where resolvido_em is null do nothing;
  get diagnostics v_novos = row_count;
  return jsonb_build_object('hoje', p_hoje, 'dias', v_dias, 'modo', v_modo, 'resolvidos', v_res, 'criados', v_novos);
end;
$function$;

revoke all on function public.acordo_alertas_gerar(date,int,text) from public, anon, authenticated;
grant execute on function public.acordo_alertas_gerar(date,int,text) to service_role;
commit;
