-- Situacao operacional + criticidade + proxima acao + retorno recalculados de
-- forma unica e consistente por recalcular_situacao_aluno(p_aluno_id), disparada
-- por eventos financeiros e por uma rotina diaria leve. Regras oficiais:
--  - Vencido pago, so parcelas futuras -> NORMAL + ACORDO_EM_DIA + retorno D-2.
--  - Qualquer vencido -> criticidade pela regra canonica (calibragem) + cobrar.
--  - Comprovante aguardando -> AGUARDANDO_CONFIRMACAO (nao rebaixa criticidade).
--  - Saldo zero -> QUITADO (concluir baixa se pendente).
--  - "Quebrado" NAO e classificado ate a gestao definir acordo_quebra_dias.
-- Nao mexe em responsavel, filas de status do pipeline, nem redistribui casos.

-- ---------- colunas de situacao operacional ----------
alter table public.casos  add column if not exists situacao_operacional text;
alter table public.alunos add column if not exists situacao_operacional text;

-- ---------- parametros configuraveis pela gestao ----------
insert into public.calibragem_parametros(chave, valor)
values ('retorno_antecedencia_dias', jsonb_build_object('dias',2))
on conflict (chave) do nothing;
-- acordo_quebra_dias fica AUSENTE de proposito: sem classificacao de quebrado
-- ate a gestao definir o parametro.

-- ---------- auditoria + dedup de retorno automatico ----------
create table if not exists public.retorno_acordo_auto (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid not null,
  proximo_vencimento date not null,
  data_retorno date,
  valor numeric,
  lote text,
  gerado_em timestamptz not null default now(),
  unique (aluno_id, proximo_vencimento)
);
alter table public.retorno_acordo_auto enable row level security;
drop policy if exists raa_ro on public.retorno_acordo_auto;
create policy raa_ro on public.retorno_acordo_auto for select
  using (coalesce(auth.role(),'')='service_role' or public.app_usuario_ativo());

-- ---------- helper: formata BRL "R$ 1.234,56" ----------
create or replace function public.fmt_brl(p numeric)
returns text language sql immutable as $$
  select 'R$ ' || translate(to_char(round(coalesce(p,0),2),'FM999G999G999G990D00'), '.,', ',.');
$$;

-- ---------- FUNCAO CENTRAL ----------
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

  -- DECISAO (prioridade)
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

-- ---------- rotina diaria leve (virada dos vencimentos) ----------
create or replace function public.recalcular_situacao_virada_diaria(p_lote text default null)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r record; n int := 0; v_lote text := coalesce(p_lote, 'virada_'||to_char(now(),'YYYYMMDD'));
begin
  for r in
    select distinct al.aluno_id from (
      select a.aluno_id
      from public.parcelas p join public.acordos a on a.id=p.acordo_id
      where upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
        and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
        and p.vencimento in (current_date, current_date - 1)
      union
      select aluno_id from public.casos
       where aluno_id is not null and data_retorno is not null and data_retorno <= current_date
      union
      select aluno_id from public.retorno_acordo_auto
       where proximo_vencimento in (current_date, current_date - 1, current_date + 1)
    ) al
    where al.aluno_id is not null
  loop
    perform public.recalcular_situacao_aluno(r.aluno_id, v_lote);
    n := n + 1;
  end loop;
  return jsonb_build_object('lote', v_lote, 'alunos_recalculados', n, 'executado_em', now());
end; $$;

-- ---------- gatilhos resilientes (nunca quebram o fluxo principal) ----------
create or replace function public._trg_recalc_por_parcela()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_aluno uuid;
begin
  begin
    select a.aluno_id into v_aluno from public.acordos a
     where a.id = coalesce(NEW.acordo_id, OLD.acordo_id);
    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, 'trg_parcela'); end if;
  exception when others then null;
  end;
  return null;
end; $$;

create or replace function public._trg_recalc_por_aluno_text()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_aluno uuid;
begin
  begin
    v_aluno := nullif(coalesce(NEW.aluno_id, OLD.aluno_id),'')::uuid;
    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, TG_ARGV[0]); end if;
  exception when others then null;
  end;
  return null;
end; $$;

create or replace function public._trg_recalc_por_aluno_uuid()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_aluno uuid;
begin
  begin
    v_aluno := coalesce(NEW.aluno_id, OLD.aluno_id);
    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, TG_ARGV[0]); end if;
  exception when others then null;
  end;
  return null;
end; $$;

drop trigger if exists trg_recalc_parcela on public.parcelas;
create trigger trg_recalc_parcela
  after insert or update or delete on public.parcelas
  for each row execute function public._trg_recalc_por_parcela();

drop trigger if exists trg_recalc_conf on public.solicitacoes_confirmacao_pagamento;
create trigger trg_recalc_conf
  after insert or update on public.solicitacoes_confirmacao_pagamento
  for each row execute function public._trg_recalc_por_aluno_text('trg_confirmacao');

drop trigger if exists trg_recalc_baixa on public.baixas_pagamento;
create trigger trg_recalc_baixa
  after insert or update on public.baixas_pagamento
  for each row execute function public._trg_recalc_por_aluno_text('trg_baixa');

drop trigger if exists trg_recalc_termo on public.termos_acordo;
create trigger trg_recalc_termo
  after insert or update on public.termos_acordo
  for each row execute function public._trg_recalc_por_aluno_uuid('trg_termo');

drop trigger if exists trg_recalc_acordo on public.acordos;
create trigger trg_recalc_acordo
  after insert or update on public.acordos
  for each row execute function public._trg_recalc_por_aluno_uuid('trg_acordo');

-- permissao de execucao
revoke all on function public.recalcular_situacao_aluno(uuid,text) from public, anon;
grant execute on function public.recalcular_situacao_aluno(uuid,text) to authenticated, service_role;
revoke all on function public.recalcular_situacao_virada_diaria(text) from public, anon;
grant execute on function public.recalcular_situacao_virada_diaria(text) to service_role;
