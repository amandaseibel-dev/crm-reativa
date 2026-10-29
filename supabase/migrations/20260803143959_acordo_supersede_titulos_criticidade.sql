-- HOTFIX: acordo ativo substitui as mensalidades anteriores a ele.
--
-- CAUSA RAIZ dos alunos "so parcelas futuras mas CRITICO/URGENTE": ao fazer o
-- acordo, as mensalidades originais (acordos_titulos) nao sao baixadas nem
-- vinculadas -- 92% dos acordos ativos em prod NAO tem vinculo de nenhum tipo
-- (nem acordo_titulo_vinculo nem acordos_titulos.acordo_id). Como a criticidade
-- e o saldo canonico contam esses titulos vencidos, o aluno fica com divida
-- "dobrada" (mensalidade original + parcela do acordo) e aparece como critico
-- mesmo estando em dia com o acordo.
--
-- DECISAO (gestao/Amanda, 2026-08-03): acordo ativo SUPERSEDE os titulos cujo
-- vencimento e ANTERIOR a criacao do acordo (a divida ja vencida quando o acordo
-- foi assinado). Aplicada de forma consistente na criticidade E no saldo canonico.
--   * Mensalidades que vencem DEPOIS do acordo continuam contando (divida nova).
--   * So supersede se o acordo for um plano real (>=1 parcela com valor > 0),
--     protegendo acordos malformados (valor 0 / sem parcela) de zerar indevidamente.
-- NAO altera titulos, acordos, parcelas, pagamentos, baixas nem responsavel.

-- ---------- regra unica de supersessao (nao espalhar) ----------
create or replace function public.titulo_superado_por_acordo(p_aluno_id uuid, p_vencimento date)
returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1
      from public.acordos a
     where a.aluno_id = p_aluno_id
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and a.criado_em::date > p_vencimento
       and exists (select 1 from public.parcelas p
                    where p.acordo_id = a.id and coalesce(p.valor,0) > 0)
  );
$$;
revoke all on function public.titulo_superado_por_acordo(uuid,date) from public, anon;
grant execute on function public.titulo_superado_por_acordo(uuid,date) to authenticated, service_role;

-- ---------- FUNCAO CENTRAL: aplica supersessao nos titulos ----------
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

  -- titulos (mensalidades originais) que ainda contam: nao vinculados a acordo
  -- ativo E NAO superados por acordo posterior ao vencimento (supersessao).
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
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
    and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

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
                     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                     and coalesce(lower(t.status),'') not in ('quitada')
                     and not exists (
                       select 1 from public.acordo_titulo_vinculo v
                       join public.acordos a on a.id=v.acordo_id
                       where v.titulo_id=t.id and coalesce(v.ativo,true)
                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
                     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)),0)
  end;
  if v_dias_venc < 0 then v_dias_venc := 0; end if;

  select case when data_ultimo_acionamento is null then 9999 else (hoje - data_ultimo_acionamento::date) end
  into v_dias_sem_ac from public.alunos where id=p_aluno_id;
  v_dias_sem_ac := coalesce(v_dias_sem_ac, 9999);

  -- DECISAO (prioridade) -- inalterada; muda apenas o saldo de entrada.
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

-- ---------- SALDO CANONICO: mesma supersessao (alinhamento pedido) ----------
create or replace function public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar_confirmacao_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_cpf text;
  v_titulos_abertos numeric := 0;
  v_titulos_orfaos  numeric := 0;
  v_parcelas_valor  numeric := 0;
  v_parcelas_qtd    int := 0;
  v_conf_pendentes  int := 0;
  v_total           numeric := 0;
  v_req_claims text := current_setting('request.jwt.claims', true);
  v_role       text := lower(coalesce(auth.jwt() ->> 'role', ''));
  v_uid        uuid := auth.uid();
  v_interno    boolean;
begin
  v_interno := (v_req_claims IS NULL) OR (v_role = 'service_role');

  if not v_interno then
    if v_uid is null or v_role = 'anon' then
      raise exception 'Acesso negado.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.usuarios u where u.id = v_uid and u.ativo = true) then
      raise exception 'Acesso negado.' using errcode = '42501';
    end if;
  end if;

  if p_aluno_id is null then
    return jsonb_build_object('erro','aluno_id nulo','tem_pendencia', true, 'total', null);
  end if;

  select lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0')
    into v_cpf from public.alunos where id = p_aluno_id;

  select
    coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'ABERTO'), 0),
    coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'), 0)
    into v_titulos_abertos, v_titulos_orfaos
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') not in ('quitada')
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

  select count(*), coalesce(sum(coalesce(p.valor,0)),0)
    into v_parcelas_qtd, v_parcelas_valor
    from public.parcelas p
    join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = p_aluno_id
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select count(*)
    into v_conf_pendentes
    from public.solicitacoes_confirmacao_pagamento s
   where s.aluno_id = p_aluno_id::text
     and s.status = 'AGUARDANDO_CONFIRMACAO'
     and (p_ignorar_confirmacao_id is null or s.id <> p_ignorar_confirmacao_id);

  v_total := v_titulos_abertos + v_titulos_orfaos + v_parcelas_valor;

  return jsonb_build_object(
    'aluno_id',            p_aluno_id,
    'titulos_abertos',     round(v_titulos_abertos, 2),
    'titulos_negociados_orfaos', round(v_titulos_orfaos, 2),
    'parcelas_abertas_qtd', v_parcelas_qtd,
    'parcelas_abertas_valor', round(v_parcelas_valor, 2),
    'confirmacoes_pendentes', v_conf_pendentes,
    'confirmacao_ignorada',  p_ignorar_confirmacao_id,
    'total',               round(v_total, 2),
    'tem_pendencia',        (v_total > 0.005 or v_conf_pendentes > 0)
  );
end;
$function$;

-- ---------- VIEW da calibragem: mesma supersessao ----------
create or replace view public.calibragem_saldo_aluno as
 WITH tit AS (
         SELECT t.aluno_id,
            t.cpf,
            sum(COALESCE(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0::numeric)) AS saldo_mensalidade,
            count(*) AS qtd_titulos_abertos,
            min(t.vencimento) AS venc_min,
            max(t.vencimento) AS venc_max
           FROM acordos_titulos t
          WHERE upper(COALESCE(t.situacao, ''::text)) = 'ABERTO'::text
            AND lower(COALESCE(t.status, ''::text)) = 'em_aberto'::text
            AND t.acordo_id IS NULL
            AND NOT (EXISTS ( SELECT 1 FROM acordo_titulo_vinculo v
                   WHERE v.titulo_id = t.id AND COALESCE(v.ativo, true)))
            AND NOT public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
          GROUP BY t.aluno_id, t.cpf
        ), par AS (
         SELECT a.aluno_id,
            sum(COALESCE(p.valor, 0::numeric)) AS saldo_acordo,
            count(*) AS qtd_parcelas_abertas
           FROM parcelas p
             JOIN acordos a ON a.id = p.acordo_id
          WHERE (lower(COALESCE(a.status, ''::text)) <> ALL (ARRAY['cancelado'::text, 'cancelada'::text]))
            AND (upper(COALESCE(p.status, ''::text)) <> ALL (ARRAY['PAGO'::text, 'PAGA'::text, 'CANCELADA'::text, 'CANCELADO'::text, 'ESTORNADA'::text, 'ESTORNADO'::text]))
          GROUP BY a.aluno_id
        )
 SELECT COALESCE(tit.aluno_id, par.aluno_id) AS aluno_id,
    tit.cpf,
    COALESCE(tit.saldo_mensalidade, 0::numeric) AS saldo_mensalidade,
    COALESCE(par.saldo_acordo, 0::numeric) AS saldo_acordo,
    COALESCE(tit.saldo_mensalidade, 0::numeric) + COALESCE(par.saldo_acordo, 0::numeric) AS saldo_total,
    COALESCE(tit.qtd_titulos_abertos, 0::bigint) AS qtd_titulos_abertos,
    COALESCE(par.qtd_parcelas_abertas, 0::bigint) AS qtd_parcelas_abertas,
    tit.venc_min,
    tit.venc_max
   FROM tit
     FULL JOIN par ON par.aluno_id = tit.aluno_id;
