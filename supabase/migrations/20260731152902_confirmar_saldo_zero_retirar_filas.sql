-- Botao "Confirmar saldo zero e retirar das filas" (Confirmacao de Valor).
-- Retira o aluno de carteira/fila/retornos/confirmacao/distribuicao e da contagem
-- dos 500, bloqueia redistribuicao e libera reposicao, SEM apagar registros e SEM
-- alterar o financeiro (nao marca titulos/parcelas como pagos). Exige motivo,
-- registra auditoria. Somente Amanda, Fernanda e Amanda ADM.

-- 1) caso_encerrado_operacional reconhece SALDO ZERO CONFIRMADO (incondicional,
--    pois e uma decisao manual da gestao) -> sai da contagem dos 500 e das filas.
create or replace function public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 returns boolean language plpgsql stable set search_path to 'public' as $function$
declare
  bloq  text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  quit  text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','SEM SALDO EM ABERTO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- 2) auditoria (sem exclusao fisica)
create table if not exists public.saldo_zero_confirmado_auditoria (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid not null,
  motivo text not null,
  operador_anterior_email text,
  responsavel_anterior_email text,
  valor_em_aberto_anterior numeric,
  executado_por text,
  executado_em timestamptz not null default now()
);
alter table public.saldo_zero_confirmado_auditoria enable row level security;
drop policy if exists szc_ro on public.saldo_zero_confirmado_auditoria;
create policy szc_ro on public.saldo_zero_confirmado_auditoria for select
  using (coalesce(auth.role(),'')='service_role' or public.usuario_e_gestao());

-- 3) RPC principal
create or replace function public.confirmar_saldo_zero_retirar_filas(p_aluno_id uuid, p_motivo text)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_nome text; v_op text; v_resp text; v_val numeric; v_txt text := p_aluno_id::text;
begin
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then
    raise exception 'Sem permissao: apenas Amanda, Fernanda ou Amanda ADM podem confirmar saldo zero.' using errcode='42501';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatorio para confirmar saldo zero.' using errcode='22023';
  end if;
  if p_aluno_id is null then raise exception 'aluno_id nulo.'; end if;

  select responsavel_atual_nome, responsavel_atual_email, valor_em_aberto
    into v_nome, v_resp, v_val from public.alunos where id=p_aluno_id;
  select operador_email into v_op from public.casos where aluno_id=p_aluno_id limit 1;

  -- casos: encerra operacionalmente, tira da contagem/distribuicao, bloqueia redistribuicao.
  update public.casos set
     status_atual='SALDO_ZERO_CONFIRMADO', status_financeiro='SALDO_ZERO_CONFIRMADO',
     status_jornada='SALDO_ZERO_CONFIRMADO', status_acionamento='SALDO_ZERO_CONFIRMADO',
     situacao_operacional='SALDO_ZERO_CONFIRMADO',
     total_em_aberto=0, nao_acionar=true,
     data_retorno=null, data_retorno_nova=null, proxima_acao_automatica=null,
     caso_atualizado_por=v_email, caso_atualizado_em=now()
   where aluno_id=p_aluno_id;

  -- alunos: sai da carteira/retornos; preserva responsavel (historico) e financeiro.
  update public.alunos set
     status_atual='SALDO_ZERO_CONFIRMADO', status_jornada='SALDO_ZERO_CONFIRMADO',
     status_acionamento='SALDO_ZERO_CONFIRMADO', situacao_operacional='SALDO_ZERO_CONFIRMADO',
     valor_em_aberto=0, fila_destino=null, proxima_acao=null, data_retorno=null, hora_retorno=null
   where id=p_aluno_id;

  -- sai da fila de confirmacao (sem apagar): encerra as pendentes deste aluno.
  update public.solicitacoes_confirmacao_pagamento
     set status='ENCERRADO_SALDO_ZERO', observacao_adm=coalesce(observacao_adm,'')||' | Saldo zero confirmado: '||p_motivo,
         confirmado_por=v_email, confirmado_em=now(), atualizado_em=now()
   where aluno_id=v_txt and status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');

  -- auditoria + historico (nao apaga nada; financeiro intacto)
  insert into public.saldo_zero_confirmado_auditoria
    (aluno_id, motivo, operador_anterior_email, responsavel_anterior_email, valor_em_aberto_anterior, executado_por)
  values (p_aluno_id, p_motivo, v_op, v_resp, v_val, v_email);

  insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
  values (v_txt, 'SALDO_ZERO_CONFIRMADO',
          'Saldo zero confirmado e retirado das filas (financeiro preservado). Motivo: '||p_motivo,
          'SALDO_ZERO_CONFIRMADO', coalesce(v_nome, v_email), v_email, now());

  return jsonb_build_object('ok', true, 'aluno_id', p_aluno_id, 'status', 'SALDO_ZERO_CONFIRMADO');
end; $$;

revoke all on function public.confirmar_saldo_zero_retirar_filas(uuid,text) from public, anon, authenticated;
grant execute on function public.confirmar_saldo_zero_retirar_filas(uuid,text) to authenticated, service_role;

-- 4) recalcular_situacao_aluno respeita o encerramento manual (nao reverte).
create or replace function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text default null)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  hoje date := current_date;
  v_regras jsonb := coalesce((select valor from public.calibragem_parametros where chave='criticidade_regras'),'{}'::jsonb);
  v_ant int := coalesce((select (valor->>'dias')::int from public.calibragem_parametros where chave='retorno_antecedencia_dias'),2);
  v_fim_mes_dias int := coalesce((v_regras->'pesos'->'fim_mes'->>'dias')::int,5);
  v_fim_mes boolean := (date_trunc('month',now())+interval '1 month - 1 day')::date - hoje <= v_fim_mes_dias;
  v_parc_venc_val numeric := 0; v_parc_fut_val numeric := 0;
  v_venc_qtd int := 0; v_fut_qtd int := 0;
  v_parc_antiga_venc date;
  v_prox_venc date; v_prox_val numeric;
  v_entrada_pend boolean := false;
  v_tit_val numeric := 0; v_tit_venc_val numeric := 0;
  v_conf_pend int := 0;
  v_termo_pend boolean := false;
  v_baixa_pend boolean := false;
  v_tem_acordo boolean := false;
  v_saldo_vencido numeric; v_saldo_total numeric;
  v_dias_venc int := 0; v_dias_sem_ac int;
  v_nivel text; v_situacao text; v_proxima text; v_retorno date;
begin
  if p_aluno_id is null then return jsonb_build_object('erro','sem_aluno'); end if;

  -- Encerramento manual (gestao) prevalece: nao recalcula nem reabre.
  if exists (select 1 from public.alunos where id=p_aluno_id
             and upper(coalesce(status_atual,''))='SALDO_ZERO_CONFIRMADO') then
    return jsonb_build_object('aluno_id',p_aluno_id,'situacao','SALDO_ZERO_CONFIRMADO','skip',true);
  end if;

  select
    coalesce(sum(p.valor) filter (where p.vencimento <  hoje),0),
    coalesce(sum(p.valor) filter (where p.vencimento >= hoje),0),
    count(*) filter (where p.vencimento <  hoje),
    count(*) filter (where p.vencimento >= hoje),
    min(p.vencimento) filter (where p.vencimento < hoje),
    bool_or(p.is_entrada),
    count(*) > 0
  into v_parc_venc_val, v_parc_fut_val, v_venc_qtd, v_fut_qtd, v_parc_antiga_venc, v_entrada_pend, v_tem_acordo
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select p.vencimento, p.valor into v_prox_venc, v_prox_val
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
    and p.vencimento >= hoje
  order by p.vencimento asc, p.numero asc
  limit 1;

  select
    coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0),
    coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento < hoje),0)
  into v_tit_val, v_tit_venc_val
  from public.acordos_titulos t
  where t.aluno_id=p_aluno_id
    and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
    and coalesce(lower(t.status),'') not in ('quitada')
    and not exists (
      select 1 from public.acordo_titulo_vinculo v
      join public.acordos a on a.id=v.acordo_id
      where v.titulo_id=t.id and coalesce(v.ativo,true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

  select count(*) into v_conf_pend
  from public.solicitacoes_confirmacao_pagamento
  where aluno_id=p_aluno_id::text and status='AGUARDANDO_CONFIRMACAO';

  select coalesce((c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')), false)
  into v_termo_pend from public.casos c where c.aluno_id=p_aluno_id limit 1;
  v_termo_pend := coalesce(v_termo_pend,false);

  select coalesce((al.status_baixa_pagamento is not null and al.status_baixa_pagamento <> 'BAIXA_REALIZADA'), false)
  into v_baixa_pend from public.alunos al where al.id=p_aluno_id;
  v_baixa_pend := coalesce(v_baixa_pend,false);

  v_saldo_vencido := round(v_parc_venc_val + v_tit_venc_val, 2);
  v_saldo_total   := round(v_parc_venc_val + v_parc_fut_val + v_tit_val, 2);

  v_dias_venc := case
    when v_parc_antiga_venc is not null then (hoje - v_parc_antiga_venc)
    else coalesce((select hoje - min(t.vencimento) from public.acordos_titulos t
                   where t.aluno_id=p_aluno_id and t.vencimento < hoje
                     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')),0)
  end;
  if v_dias_venc < 0 then v_dias_venc := 0; end if;

  select case when data_ultimo_acionamento is null then 9999 else (hoje - data_ultimo_acionamento::date) end
  into v_dias_sem_ac from public.alunos where id=p_aluno_id;
  v_dias_sem_ac := coalesce(v_dias_sem_ac, 9999);

  if v_saldo_total <= 0.005 and v_conf_pend = 0 then
     v_nivel := 'NORMAL';
     if v_baixa_pend then
        v_situacao := 'QUITADO_AGUARDANDO_BAIXA';
        v_proxima  := 'Próxima ação: concluir a baixa e finalizar o caso.';
     else
        v_situacao := 'QUITADO';
        v_proxima  := null;
     end if;
     v_retorno := null;
  elsif v_conf_pend > 0 and v_saldo_vencido <= 0.005 then
     v_situacao := 'AGUARDANDO_CONFIRMACAO';
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'ATENCAO');
     v_proxima := 'Próxima ação: confirmar o pagamento no financeiro.';
     v_retorno := null;
  elsif v_saldo_vencido > 0.005 then
     v_nivel := public.calibragem_nivel_criticidade(v_dias_venc, v_dias_sem_ac, v_saldo_total, v_termo_pend, v_fim_mes, v_regras);
     v_situacao := 'COBRANCA_VENCIDA';
     v_proxima := 'Próxima ação: cobrar o saldo vencido de '||public.fmt_brl(v_saldo_vencido)||'.';
     v_retorno := hoje;
  elsif v_parc_fut_val > 0.005 and v_prox_venc is not null then
     v_nivel := 'NORMAL';
     v_situacao := 'ACORDO_EM_DIA';
     v_proxima := 'Próxima ação: acompanhar a parcela de '||public.fmt_brl(coalesce(v_prox_val,0))
                ||' com vencimento em '||to_char(v_prox_venc,'DD/MM/YYYY')||'.';
     v_retorno := greatest(hoje, v_prox_venc - v_ant);
  else
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'NORMAL');
     v_situacao := 'SEM_PENDENCIA';
     v_proxima := null;
     v_retorno := null;
  end if;

  update public.casos set
     criticidade            = v_nivel,
     situacao_operacional   = v_situacao,
     proxima_acao_automatica= v_proxima,
     proximo_vencimento     = coalesce(v_prox_venc, v_parc_antiga_venc, proximo_vencimento),
     parcela_a_vencer       = v_prox_val,
     parcelas_vencidas      = v_venc_qtd,
     data_retorno           = v_retorno,
     caso_atualizado_em     = now()
   where aluno_id = p_aluno_id;

  update public.alunos set
     nivel_criticidade    = v_nivel,
     situacao_operacional = v_situacao,
     proxima_acao         = v_proxima,
     data_retorno         = v_retorno
   where id = p_aluno_id;

  if v_situacao='ACORDO_EM_DIA' and v_prox_venc is not null then
     insert into public.retorno_acordo_auto(aluno_id, proximo_vencimento, data_retorno, valor, lote)
     values (p_aluno_id, v_prox_venc, v_retorno, v_prox_val, coalesce(p_lote,'evento'))
     on conflict (aluno_id, proximo_vencimento)
       do update set data_retorno=excluded.data_retorno, valor=excluded.valor, gerado_em=now();
  end if;

  return jsonb_build_object(
    'aluno_id',p_aluno_id,'situacao',v_situacao,'criticidade',v_nivel,
    'proxima_acao',v_proxima,'data_retorno',v_retorno,
    'saldo_vencido',v_saldo_vencido,'saldo_total',v_saldo_total,
    'proxima_parcela_venc',v_prox_venc,'proxima_parcela_valor',v_prox_val,
    'confirmacao_pendente',v_conf_pend>0,'termo_pendente',v_termo_pend,
    'entrada_pendente',coalesce(v_entrada_pend,false),'baixa_pendente',v_baixa_pend,
    'tem_acordo',coalesce(v_tem_acordo,false));
end; $$;
