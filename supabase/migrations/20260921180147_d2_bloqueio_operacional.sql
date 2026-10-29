-- D-2: aluno que NAO PODE SER ACIONADO nao gera (nem mantem) alerta preventivo. Patch minimo e isolado no fluxo D-2.
--
-- Regra (mesma semantica do bloqueio de ACIONAMENTO que ja existe em caso_encerrado_operacional: lista bloq_acion, normalizada por
-- normalizar_status_acionamento): o aluno esta bloqueado se QUALQUER destes campos normalizar para
--   'CANCELAMENTO COBRANCA' | 'JURIDICO' | 'SUSPENSAO COBRANCA' | 'SUSPENSAO DE COBRANCA'
--     alunos.status_atual / status_jornada / status_acionamento
--     casos.status_atual / status_acionamento / status_jornada / status_financeiro   (qualquer caso do aluno)
--   ou se algum caso do aluno tem casos.nao_acionar = true.
-- NAO usa 'CANCELADO' puro nem texto aproximado ('CANCEL'): 'CANCELADO' tambem e acordo/parcela cancelado (semantica propria, fora deste patch).
-- Nao amplia nada alem do D-2: nao mexe em divida, acordo, parcela, saldo, status financeiro, indicadores, Acoes Massivas, carteira, pagamentos.
-- Comportamento: bloqueado antes => acordo_alertas_gerar nao cria; bloqueado depois => acordo_alertas_resolver fecha o alerta aberto com
-- resolucao 'BLOQUEADO' (na proxima rodada); desbloqueado => o indice unico e parcial (resolvido_em is null), entao uma futura geracao normal
-- pode criar de novo se as demais regras valerem. Precedencia da resolucao: quitado/cancelado/paga/substituida ANTES de bloqueado ANTES de vencida.
-- Nenhum alerta e criado por esta migration. Preserva o fail-safe dos gatilhos (PR #443) e as ACLs (CREATE OR REPLACE mantem).
begin;

alter table public.acordo_alertas_parcela drop constraint if exists acordo_alertas_parcela_resolucao_check;
alter table public.acordo_alertas_parcela add constraint acordo_alertas_parcela_resolucao_check
  check (resolucao in ('PAGA','ACORDO_QUITADO','ACORDO_CANCELADO','VENCIDA','SUBSTITUIDA','BLOQUEADO'));

CREATE OR REPLACE FUNCTION public.aluno_bloqueado_para_d2(p_aluno_id uuid)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  bloq text[] := array['CANCELAMENTO COBRANCA','JURIDICO','SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
begin
  if p_aluno_id is null then return false; end if;
  if exists (select 1 from public.alunos a
              where a.id = p_aluno_id
                and (public.normalizar_status_acionamento(a.status_atual) = any(bloq)
                  or public.normalizar_status_acionamento(a.status_jornada) = any(bloq)
                  or public.normalizar_status_acionamento(a.status_acionamento) = any(bloq))) then
    return true;
  end if;
  return exists (select 1 from public.casos c
                  where c.aluno_id = p_aluno_id
                    and (c.nao_acionar is true
                      or public.normalizar_status_acionamento(c.status_atual) = any(bloq)
                      or public.normalizar_status_acionamento(c.status_acionamento) = any(bloq)
                      or public.normalizar_status_acionamento(c.status_jornada) = any(bloq)
                      or public.normalizar_status_acionamento(c.status_financeiro) = any(bloq)));
end;
$function$;
revoke all on function public.aluno_bloqueado_para_d2(uuid) from public, anon, authenticated;
grant execute on function public.aluno_bloqueado_para_d2(uuid) to service_role;

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
               when public.aluno_bloqueado_para_d2(x2.aluno_id) then 'BLOQUEADO'
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
     and not public.aluno_bloqueado_para_d2(a.aluno_id)                    -- aluno que nao pode ser acionado: sem D2
  on conflict (acordo_id, parcela_id, tipo) where resolvido_em is null do nothing;
  get diagnostics v_novos = row_count;
  return jsonb_build_object('hoje', p_hoje, 'dias', v_dias, 'modo', v_modo, 'resolvidos', v_res, 'criados', v_novos);
end;
$function$;

revoke all on function public.acordo_alertas_gerar(date,int,text), public.acordo_alertas_resolver(date) from public, anon, authenticated;
grant execute on function public.acordo_alertas_gerar(date,int,text), public.acordo_alertas_resolver(date) to service_role;
commit;
