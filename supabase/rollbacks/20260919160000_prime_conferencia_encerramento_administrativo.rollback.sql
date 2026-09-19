-- ROLLBACK do encerramento administrativo (20260919160000). Devolve as funcoes
-- ao texto anterior, remove gatilho, RPC, helper e colunas. So roda se nenhum
-- titulo foi encerrado administrativamente (senao a proveniencia se perderia).
begin;
do $$ begin
  if exists (select 1 from public.acordos_titulos where origem_encerramento is not null)
     or exists (select 1 from public.prime_conferencia_decisao where decisao = 'ENCERRADO_ADMINISTRATIVO') then
    raise exception 'ROLLBACK_BLOQUEADO: ja existem titulos encerrados administrativamente; reverter apagaria proveniencia';
  end if;
end $$;
drop trigger if exists trg_titulo_encerrado_administrativo_protegido on public.acordos_titulos;
drop function if exists public._titulo_encerrado_administrativo_protegido();
drop function if exists public.prime_conferencia_encerrar_administrativo(uuid, text);
drop function if exists public.prime_conferencia_encerrar_zerado_aluno(uuid, text);

create or replace function public._trg_auto_quitar_titulo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- EM_CONFIRMACAO conta como divida ainda nao resolvida: entrar nele nao
  -- quita ninguem; sair dele para PAGO (baixa confirmada) segue quitando.
  if upper(coalesce(old.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO') then
    perform public._talvez_quitar_aluno(new.aluno_id);
  end if;
  return new;
end;
$function$;

create or replace function public.carteira_2026_1_classificar()
 returns table(titulo_id uuid, cpf text, aluno_id uuid, documento text, vencimento date, entrada_em date, valor_original numeric, situacao_crm text, estado_prime text, faixa text, sub_faixa text, acordo_estado text, ef_pago numeric, ef_negociado numeric, ef_convertido numeric, em_validacao numeric, academico numeric, inadimplencia numeric, recuperacao_financeira numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with serie as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(liquidado_em) liq
      from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
  ),
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas,
           count(*) filter (where status = 'VENCIDA' and vencimento >= current_date - 30) venc_ate30,
           count(*) filter (where status = 'VENCIDA' and vencimento <  current_date - 30) venc_mais30
      from public.parcelas group by 1
  ),
  acordo as (
    select a.id,
           case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                when a.status = 'QUITADO' then 1 else 0 end ratio,
           case when a.status = 'CANCELADO' then 'cancelado'
                when a.status = 'QUITADO'   then 'quitado'
                when coalesce(p.venc_mais30,0) > 0 then 'quebrado'
                when coalesce(p.venc_ate30,0)  > 0 then 'atraso'
                else 'regular' end estado
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  boletos_nossos as (
    select distinct regexp_replace(coalesce(boleto,''), '\D', '', 'g') b
      from public.parcelas where boleto is not null
  ),
  caixa_fora as (
    select lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') cpf,
           min(p.data_pagamento) primeiro
      from public.pagamentos p
      join public.alunos al on al.id = p.aluno_id
      left join boletos_nossos bn
             on bn.b = regexp_replace(coalesce(p.numero_parcela_completo,''), '\D', '', 'g')
     where bn.b is null group by 1
  ),
  cancelado_solto as (
    select lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') cpf,
           array_agg(a.criado_em::date) datas
      from public.acordos a
     where a.status = 'CANCELADO'
       and not exists (select 1 from public.acordos_titulos x where x.acordo_id = a.id)
       and not exists (select 1 from public.acordo_titulo_vinculo v where v.acordo_id = a.id)
     group by 1
  ),
  academico_cpf as (
    select lpad(regexp_replace(coalesce(cpf,''), '\D', '', 'g'), 11, '0') cpf,
           bool_or(status in ('Anulado','Cancelado')
                   and valid_from >= date '2026-01-01' and valid_from < date '2026-07-01') anulado,
           bool_or(status = 'Confirmado'
                   and valid_from >= date '2026-01-01' and valid_from < date '2026-07-01') confirmado
      from public.prime_contratos group by 1
  ),
  base as (
    select b.titulo_id, b.cpf, b.aluno_id, b.documento, b.vencimento, b.entrada_em,
           b.valor_original vo, t.situacao,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo,
           coalesce(t.acordo_id, v.acordo_id) acordo_id, s.liq,
           (s.liq is not null and s.liq > b.vencimento + 30 and s.liq >= b.entrada_em) liq_real,
           (s.liq is null) sem_linha
      from public.carteira_2026_1_base b
      join public.acordos_titulos t on t.id = b.titulo_id
      left join public.acordo_titulo_vinculo v on v.titulo_id = b.titulo_id and v.ativo
      left join serie s on s.b = regexp_replace(coalesce(b.documento,''), '\D', '', 'g')
  ),
  marcado as (
    select base.*, ac.ratio, ac.estado,
           ((cf.primeiro is not null and cf.primeiro >= base.liq - 30)
            or (cs.datas is not null
                and exists (select 1 from unnest(cs.datas) d where base.liq between d - 7 and d + 7))) origem_provada,
           (cf.cpf is not null) tem_caixa_fora,
           (coalesce(acd.anulado, false) and not coalesce(acd.confirmado, false)) academico
      from base
      left join acordo ac on ac.id = base.acordo_id
      left join caixa_fora cf on cf.cpf = base.cpf
      left join cancelado_solto cs on cs.cpf = base.cpf
      left join academico_cpf acd on acd.cpf = base.cpf
  )
  select
    titulo_id, cpf, aluno_id, documento, vencimento, entrada_em, vo, situacao,
    case when sem_linha then 'sem linha no Prime'
         when liq_real then 'liquidado no Prime' else 'aberto no Prime' end,
    case when acordo_id is not null then 'EFETIVIDADE'
         when situacao = 'PAGO' and greatest(vo - saldo, 0) > 0 then 'EFETIVIDADE'
         when liq_real and origem_provada then 'EFETIVIDADE'
         when liq_real and academico then 'ACADEMICO'
         when liq_real then 'EM_VALIDACAO'
         when tem_caixa_fora then 'EM_VALIDACAO'
         when sem_linha then 'EM_VALIDACAO'
         else 'INADIMPLENCIA' end,
    case when acordo_id is not null then
           case when coalesce(ratio,0) >= 1 then 'Pago / Quitado'
                when estado = 'regular'   then 'Negociado regular'
                when estado = 'atraso'    then 'Negociado em atraso'
                when estado = 'quebrado'  then 'Acordo quebrado'
                when estado = 'cancelado' then 'Acordo cancelado'
                else 'Negociado regular' end
         when situacao = 'PAGO' and greatest(vo - saldo, 0) > 0 then 'Pago / Quitado'
         when liq_real and origem_provada then 'Convertido com origem comprovada'
         when liq_real and academico then 'Baixa/Ajuste academico'
         when liq_real then 'Liquidado no Prime, origem nao comprovada'
         when tem_caixa_fora then 'Aberto no Prime, mas paga acordo fora do CRM'
         when sem_linha then 'Sem confirmacao do Prime (titulo nao encontrado)'
         else 'Sem pagamento e sem negociacao' end,
    coalesce(estado, 'sem_acordo'),
    case when acordo_id is not null then vo * coalesce(ratio,0)
         when situacao = 'PAGO' then greatest(vo - saldo, 0) else 0 end,
    case when acordo_id is not null then vo * (1 - coalesce(ratio,0)) else 0 end,
    case when acordo_id is null and liq_real and origem_provada
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when acordo_id is null and liq_real and not origem_provada and not academico
         then (case when situacao = 'PAGO' then saldo else vo end)
         when acordo_id is null and not liq_real and tem_caixa_fora
         then (case when situacao = 'PAGO' then saldo else vo end)
         when acordo_id is null and sem_linha and not tem_caixa_fora
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when acordo_id is null and liq_real and not origem_provada and academico
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when acordo_id is null and not liq_real and not tem_caixa_fora and not sem_linha
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when acordo_id is not null then vo * coalesce(ratio,0)
         when situacao = 'PAGO' then greatest(vo - saldo, 0) else 0 end
  from marcado;
$function$;

-- recalcular_situacao_aluno: texto de producao de 19/09 (md5 f4e1db18...)
create or replace function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_tit_conf int := 0;
  v_termo_pend boolean := false;
  v_baixa_pend boolean := false;
  v_tem_acordo boolean := false;
  v_saldo_vencido numeric; v_saldo_total numeric;
  v_dias_venc int := 0; v_dias_sem_ac int;
  v_status_acion text; v_ult_acion date; v_acao_massiva boolean := false;
  v_ret_atual date; v_orig_atual text;
  v_lembrete date;
  v_nivel text; v_situacao text; v_proxima text; v_retorno date; v_origem text;
  v_preservar_tabulacao boolean := false; v_proxima_auto text;
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
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select p.vencimento, p.valor into v_prox_venc, v_prox_val
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
    and p.vencimento >= hoje
  order by p.vencimento asc, p.numero asc
  limit 1;

  select
    coalesce(sum(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0),
    coalesce(sum(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento < hoje),0)
  into v_tit_val, v_tit_venc_val
  from public.acordos_titulos t
  where t.aluno_id=p_aluno_id
    and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
    and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
    and not exists (
      select 1 from public.acordo_titulo_vinculo v
      join public.acordos a on a.id=v.acordo_id
      where v.titulo_id=t.id and coalesce(v.ativo,true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO'))
    and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

  select count(*) into v_conf_pend
  from public.solicitacoes_confirmacao_pagamento
  where aluno_id=p_aluno_id::text and status='AGUARDANDO_CONFIRMACAO';

  -- titulos aguardando a Conferencia Prime (fora do saldo, mas nao quitados)
  select count(*) into v_tit_conf
  from public.acordos_titulos t
  where t.aluno_id=p_aluno_id and upper(coalesce(t.situacao,''))='EM_CONFIRMACAO';

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
                     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                     and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
                     and not exists (
                       select 1 from public.acordo_titulo_vinculo v
                       join public.acordos a on a.id=v.acordo_id
                       where v.titulo_id=t.id and coalesce(v.ativo,true)
                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO'))
                     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)),0)
  end;
  if v_dias_venc < 0 then v_dias_venc := 0; end if;

  select
    case when data_ultimo_acionamento is null then 9999 else (hoje - data_ultimo_acionamento::date) end,
    data_ultimo_acionamento::date,
    coalesce(status_acionamento,'') ilike 'Ação massiva%',
    data_retorno,
    retorno_origem
  into v_dias_sem_ac, v_ult_acion, v_acao_massiva, v_ret_atual, v_orig_atual
  from public.alunos where id=p_aluno_id;
  v_dias_sem_ac := coalesce(v_dias_sem_ac, 9999);

  if v_saldo_total <= 0.005 and v_conf_pend = 0 and v_tit_conf > 0 then
     -- So resta titulo aguardando a Conferencia Prime: nao e quitacao.
     v_situacao := 'AGUARDANDO_CONFIRMACAO';
     v_nivel    := 'NORMAL';
     v_proxima  := 'Próxima ação: aguardar a decisão da Conferência Prime sobre a liquidação do título.';
     v_retorno  := null; v_origem := null;
  elsif v_saldo_total <= 0.005 and v_conf_pend = 0 then
     v_nivel := 'NORMAL';
     if v_baixa_pend then
        v_situacao := 'QUITADO_AGUARDANDO_BAIXA';
        v_proxima  := 'Próxima ação: concluir a baixa e finalizar o caso.';
     else
        v_situacao := 'QUITADO';
        v_proxima  := null;
     end if;
     v_retorno := null; v_origem := null;
  elsif v_conf_pend > 0 and v_saldo_vencido <= 0.005 then
     v_situacao := 'AGUARDANDO_CONFIRMACAO';
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'ATENCAO');
     v_proxima := 'Próxima ação: confirmar o pagamento no financeiro.';
     v_retorno := null; v_origem := null;
  elsif v_saldo_vencido > 0.005 then
     v_nivel := public.calibragem_nivel_criticidade(v_dias_venc, v_dias_sem_ac, v_saldo_total, v_termo_pend, v_fim_mes, v_regras);
     v_situacao := 'COBRANCA_VENCIDA';
     v_proxima := 'Próxima ação: cobrar o saldo vencido de '||public.fmt_brl(v_saldo_vencido)||'.';
     if v_conf_pend > 0 then
        -- Está com o financeiro: o caso fica parado até a conferência ser
        -- concluída. Sem prazo empurrando ele de volta para o operador.
        v_proxima := 'Próxima ação: aguardar a confirmação do pagamento no financeiro'
                  || ' (saldo vencido de '||public.fmt_brl(v_saldo_vencido)||' segue em aberto).';
        v_retorno := null; v_origem := null;
     elsif v_acao_massiva and v_ult_acion is not null and (hoje - v_ult_acion) < 10 then
        v_retorno := v_ult_acion + 10;
        v_origem  := 'AUTOMATICO';
     elsif v_ret_atual is not null and v_ret_atual > hoje then
        v_retorno := v_ret_atual;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     else
        v_retorno := hoje;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     end if;
  elsif v_parc_fut_val > 0.005 and v_prox_venc is not null then
     v_nivel := 'NORMAL';
     v_situacao := 'ACORDO_EM_DIA';
     v_proxima := 'Próxima ação: lembrar o aluno da parcela de '||public.fmt_brl(coalesce(v_prox_val,0))
                ||' com vencimento em '||to_char(v_prox_venc,'DD/MM/YYYY')||'.';
     v_lembrete := public.dia_util_anterior_ou_igual(v_prox_venc - v_ant);
     if v_ret_atual is not null and v_ret_atual > hoje and coalesce(v_orig_atual,'') like 'OPERADOR%' then
        v_retorno := v_ret_atual;
        v_origem  := v_orig_atual;
     elsif v_ult_acion is not null and v_ult_acion >= v_lembrete then
        v_retorno := null;
        v_origem  := null;
     else
        v_retorno := greatest(hoje, v_lembrete);
        v_origem  := 'AUTOMATICO';
     end if;
  else
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'NORMAL');
     v_situacao := 'SEM_PENDENCIA';
     v_proxima := null;
     v_retorno := null; v_origem := null;
  end if;

  -- Acionado hoje: o desfecho tabulado pelo operador manda na fila.
  v_proxima_auto := v_proxima;  -- casos.proxima_acao_automatica segue automatica
  v_preservar_tabulacao := (v_ult_acion = hoje)
    and v_conf_pend = 0
    and v_situacao not in ('QUITADO','QUITADO_AGUARDANDO_BAIXA','AGUARDANDO_CONFIRMACAO');
  if v_preservar_tabulacao then
     select al.proxima_acao, al.data_retorno, al.retorno_origem
       into v_proxima, v_retorno, v_origem
       from public.alunos al where al.id = p_aluno_id;
  end if;
  update public.casos set
     criticidade            = v_nivel,
     situacao_operacional   = v_situacao,
     proxima_acao_automatica= coalesce(v_proxima_auto, v_proxima),
     proximo_vencimento     = coalesce(v_prox_venc, v_parc_antiga_venc, proximo_vencimento),
     parcela_a_vencer       = v_prox_val,
     parcelas_vencidas      = v_venc_qtd,
     saldo_vencido          = v_saldo_vencido,
     saldo_total            = v_saldo_total,
     data_retorno           = v_retorno,
     caso_atualizado_em     = now()
   where aluno_id = p_aluno_id;

  update public.alunos set
     nivel_criticidade    = v_nivel,
     situacao_operacional = v_situacao,
     proxima_acao         = v_proxima,
     saldo_vencido        = v_saldo_vencido,
     saldo_total          = v_saldo_total,
     data_retorno         = v_retorno,
     retorno_origem       = v_origem
   where id = p_aluno_id;

  if v_situacao='ACORDO_EM_DIA' and v_prox_venc is not null then
     insert into public.retorno_acordo_auto(aluno_id, proximo_vencimento, data_retorno, valor, lote)
     values (p_aluno_id, v_prox_venc, coalesce(v_retorno, v_lembrete), v_prox_val, coalesce(p_lote,'evento'))
     on conflict (aluno_id, proximo_vencimento)
       do update set data_retorno=excluded.data_retorno, valor=excluded.valor, gerado_em=now();
  end if;

  return jsonb_build_object(
    'aluno_id',p_aluno_id,'situacao',v_situacao,'criticidade',v_nivel,
    'proxima_acao',v_proxima,'data_retorno',v_retorno,'retorno_origem',v_origem,
    'lembrete_parcela',v_lembrete,
    'saldo_vencido',v_saldo_vencido,'saldo_total',v_saldo_total,
    'proxima_parcela_venc',v_prox_venc,'proxima_parcela_valor',v_prox_val,
    'confirmacao_pendente',v_conf_pend>0,'termo_pendente',v_termo_pend,
    'entrada_pendente',coalesce(v_entrada_pend,false),'baixa_pendente',v_baixa_pend,
    'tem_acordo',coalesce(v_tem_acordo,false),
    'titulos_em_confirmacao',v_tit_conf);
end; $function$;

alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_decisao_check;
alter table public.prime_conferencia_decisao add constraint prime_conferencia_decisao_decisao_check
  check (decisao = any (array['PENDENTE','CONFIRMADO','VINCULADO','REJEITADO']));
alter table public.acordos_titulos drop constraint if exists acordos_titulos_origem_encerramento_valida;
alter table public.acordos_titulos
  drop column if exists origem_encerramento, drop column if exists origem_encerramento_ref, drop column if exists origem_encerramento_em;
commit;
