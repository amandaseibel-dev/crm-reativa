-- ROLLBACK de 20260918150000_grupo_a_confirmacao_prime
--
-- 1. Todo titulo em EM_CONFIRMACAO volta para ABERTO/em_aberto (volta a ser
--    cobrado). Decisoes ja tomadas (CONFIRMADO, VINCULADO, REJEITADO) ficam:
--    sao registro do que gente decidiu. As PENDENTES sao apagadas depois de
--    copiadas para a auditoria -- nao eram decisao, eram fila.
-- 2. Cada funcao alterada volta ao texto exato de producao de 18/09/2026.
-- 3. Sai o que a migration criou: gatilho de guarda, funcoes novas, indices.
--    prime_conferencia_fila volta a assinatura antiga.
-- FICA (aditivo, inofensivo): as colunas novas de prime_conferencia_decisao,
-- decidido_em sem NOT NULL e o check de decisao aceitando PENDENTE/VINCULADO.

begin;

drop trigger if exists trg_titulo_em_confirmacao_protegido on public.acordos_titulos;

create temp table _rb_alunos on commit drop as
select distinct aluno_id from public.acordos_titulos
 where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO' and aluno_id is not null;

insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
select 'sistema', 'ROLLBACK_GRUPO_A_CONFIRMACAO_PRIME', 'acordos_titulos',
       jsonb_build_object(
         'titulos_devolvidos_a_cobranca',
           (select coalesce(jsonb_agg(t.id), '[]'::jsonb) from public.acordos_titulos t
             where upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'),
         'decisoes_pendentes_apagadas',
           (select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) from public.prime_conferencia_decisao d
             where d.decisao = 'PENDENTE'));

update public.acordos_titulos
   set situacao = 'ABERTO', status = 'em_aberto', atualizado_em = now()
 where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';

delete from public.prime_conferencia_decisao where decisao = 'PENDENTE';

-- public._titulo_situacao_e_status_coerentes: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public._titulo_situacao_e_status_coerentes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  end if;

  return new;
end;
$function$;

-- public._trg_auto_quitar_titulo: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public._trg_auto_quitar_titulo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if upper(coalesce(old.situacao,'')) in ('ABERTO','NEGOCIADO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO') then
    perform public._talvez_quitar_aluno(new.aluno_id);
  end if;
  return new;
end;
$function$;

-- public._talvez_quitar_aluno: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public._talvez_quitar_aluno(v_aluno uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_saldo numeric; v_parc int; v_conf int;
begin
  if v_aluno is null then return; end if;

  select coalesce(sum(coalesce(saldo_corrigido, valor_original, 0)), 0) into v_saldo
    from public.acordos_titulos
   where aluno_id = v_aluno and upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO');
  if v_saldo > 0 then return; end if;

  select count(*) into v_parc
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = v_aluno
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  if v_parc > 0 then return; end if;

  select count(*) into v_conf
    from public.solicitacoes_confirmacao_pagamento
   where aluno_id = v_aluno::text and status = 'AGUARDANDO_CONFIRMACAO';
  if v_conf > 0 then return; end if;

  update public.alunos
    set status_jornada = 'QUITADO', status_atual = 'QUITADO', status_acionamento = 'QUITADO',
        valor_em_aberto = 0
    where id = v_aluno
      and coalesce(status_jornada,'') not in ('QUITADO','QUITADO_MANUAL','JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA');

  update public.casos
     set status_financeiro = 'QUITADO_AUTOMATICO',
         quitado_em        = current_date,
         origem_quitacao   = 'QUITACAO_AUTOMATICA',
         total_em_aberto   = 0,
         criticidade       = 'NORMAL',
         caso_atualizado_por = 'sistema_quitacao_automatica',
         caso_atualizado_em  = now()
   where aluno_id = v_aluno
     and quitado_em is null
     and operador_email is not null;
end;
$function$;

-- public.aluno_saldo_pendente_detalhe: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar_confirmacao_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
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
  v_interno := (v_req_claims is null) or (v_role = 'service_role');
  if not v_interno then
    if v_uid is null or v_role = 'anon' then
      raise exception 'Acesso negado.' using errcode = '42501';
    end if;
  end if;

  -- Mensalidade sai da conta SO quando vinculada a um acordo nao cancelado.
  -- Nada de deducao por data.
  select
    coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'ABERTO'), 0),
    coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'), 0)
    into v_titulos_abertos, v_titulos_orfaos
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

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
    'aluno_id', p_aluno_id,
    'titulos_abertos', round(v_titulos_abertos, 2),
    'titulos_negociados_orfaos', round(v_titulos_orfaos, 2),
    -- Mantidos por compatibilidade; a deducao por data nao existe mais.
    'titulos_superados_valor', 0,
    'titulos_superados_qtd', 0,
    'parcelas_abertas_qtd', v_parcelas_qtd,
    'parcelas_abertas_valor', round(v_parcelas_valor, 2),
    'confirmacoes_pendentes', v_conf_pendentes,
    'confirmacao_ignorada', p_ignorar_confirmacao_id,
    'total', round(v_total, 2),
    'tem_pendencia', (v_total > 0.005 or v_conf_pendentes > 0)
  );
end;
$function$;

-- public.casos_reavaliar_encerramento: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.casos_reavaliar_encerramento(p_limite integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare v_n integer;
begin
  with alvo as (
    select c.id
      from public.casos c
      join public.alunos al on al.id = c.aluno_id
     where not coalesce(c.encerrado_operacional, false)
       and c.aluno_id is not null
       -- trava que nao muda: so fecha quem NAO deve nada
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric <= 0.005
       and (
         -- a regra que ja existia diz encerrado
         public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada)
         -- ou o ALUNO esta marcado como quitado e o caso ficou para tras
         or upper(coalesce(al.status_atual,'')) ~ 'QUIT|BAIXA|SALDO_ZERO|SEM_SALDO'
         -- ou o proprio caso JA FOI CALCULADO como quitado.
         --
         -- Em 02/09/2026, 11 casos estavam com `situacao_operacional = QUITADO`,
         -- saldo zero, e ainda ABERTOS -- um deles ha seis semanas na carteira do
         -- cobranca03 (caso 9624, quitado em 21/07). Nove deles tinham o aluno com
         -- `status_atual = ACORDO_FECHADO`, palavra que nao esta no padrao acima.
         --
         -- A correcao NAO foi acrescentar ACORDO_FECHADO ao padrao, e de proposito:
         -- "acordo fechado" quer dizer acordo FIRMADO, nao pago. Sao 593 alunos com
         -- esse status e 577 deles ainda devem, R$ 2.486.988,04 no total. Colocar a
         -- palavra num padrao chamado de quitacao daria a entender o contrario para
         -- quem lesse depois.
         --
         -- `situacao_operacional` e melhor porque nao e string herdada: e o que
         -- `recalcular_situacao_aluno` calculou a partir do saldo real.
         or upper(coalesce(c.situacao_operacional,'')) = 'QUITADO'
       )
     limit coalesce(p_limite, 100000)
  )
  update public.casos c
     set encerrado_operacional = true,
         caso_atualizado_por = 'sistema_reavaliar_encerramento',
         caso_atualizado_em = now()
    from alvo a
   where c.id = a.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- public.casos_encerrar_zerados_sem_debito: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.casos_encerrar_zerados_sem_debito(p_limite integer DEFAULT NULL::integer, p_origem text DEFAULT 'cron'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare
  v_snapshot_casos int := 0;
  v_snapshot_alunos int := 0;
  v_casos int := 0;
  v_alunos int := 0;
  v_quem text := coalesce(nullif(p_origem,''), 'cron');
begin
  if auth.jwt() is not null and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Apenas gestão pode rodar o encerramento de zerados.' using errcode = '42501';
  end if;

  drop table if exists tmp_zer;
  create temporary table tmp_zer on commit drop as
  with mens as (
    select t.aluno_id, sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) v
      from public.acordos_titulos t
     where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and coalesce(lower(t.status),'') <> 'quitada'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
     group by t.aluno_id
  ), parc as (
    select a.aluno_id, sum(coalesce(p.valor,0)) v
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
     group by a.aluno_id
  ), conf as (
    select aluno_id from public.solicitacoes_confirmacao_pagamento
     where status = 'AGUARDANDO_CONFIRMACAO' group by aluno_id
  ), baixa as (
    select aluno_id from public.baixas_pagamento
     where upper(coalesce(status_baixa,'')) in ('AGUARDANDO_BAIXA','PENDENTE') group by aluno_id
  )
  select c.id as caso_id, c.aluno_id, c.matricula, c.nome, c.cpf,
         c.operador_email, c.operador_nome, c.chave_unificacao,
         coalesce(c.total_em_aberto,0) as total_em_aberto,
         coalesce(c.encerrado_operacional,false) as encerrado_operacional,
         c.status_acionamento, c.status_financeiro, c.quitado_em,
         a.status_atual as a_status_atual, a.status_jornada as a_status_jornada,
         a.cpf as a_cpf, coalesce(a.valor_em_aberto,0) as a_valor_em_aberto,
         public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada) as aluno_encerrado,
         ((upper(coalesce(a.status_atual,''))||' '||upper(coalesce(a.status_jornada,''))||' '
           ||upper(coalesce(c.status_acionamento,''))||' '||upper(coalesce(c.status_financeiro,''))||' '
           ||upper(coalesce(c.status_atual,''))) ~ 'JURIDIC|CANCEL|SUSPENS') as bloqueado,
         exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                  where s.aluno_id = c.aluno_id::text) as ja_passou_confirmacao
    from public.casos c
    join public.alunos a on a.id = c.aluno_id
    left join mens m  on m.aluno_id  = c.aluno_id
    left join parc pc on pc.aluno_id = c.aluno_id
    left join conf cf on cf.aluno_id = c.aluno_id::text
    left join baixa bx on bx.aluno_id = c.aluno_id::text
   where c.aluno_id is not null
     and (coalesce(m.v,0) + coalesce(pc.v,0)) <= 0.005
     and cf.aluno_id is null
     and bx.aluno_id is null;

  update public.casos c
     set total_em_aberto = 0,
         caso_atualizado_por = 'sistema_zerado_sem_debito',
         caso_atualizado_em = now()
    from tmp_zer z
   where c.id = z.caso_id
     and z.total_em_aberto <> 0;
  get diagnostics v_snapshot_casos = row_count;

  update public.alunos a
     set valor_em_aberto = 0
   where a.id in (select aluno_id from tmp_zer where a_valor_em_aberto <> 0);
  get diagnostics v_snapshot_alunos = row_count;

  drop table if exists tmp_alvo;
  create temporary table tmp_alvo on commit drop as
  select z.*
    from tmp_zer z
   where not z.bloqueado
     and (not z.aluno_encerrado or not z.encerrado_operacional)
     and not (z.operador_email is not null and z.quitado_em is null
              and public.normalizar_status_acionamento(z.status_acionamento) <> 'SEM SALDO EM ABERTO'
              and not z.ja_passou_confirmacao)
   order by z.caso_id
   limit coalesce(p_limite, 1000000);

  update public.casos c
     set status_acionamento = case
           when public.normalizar_status_acionamento(c.status_acionamento) in
                ('PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                 'SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO')
             then c.status_acionamento
           else 'SEM_SALDO_EM_ABERTO' end,
         status_financeiro = case
           when c.status_financeiro is null or upper(c.status_financeiro) = 'EM_ABERTO'
             then 'SEM_SALDO_EM_ABERTO'
           else c.status_financeiro end,
         encerrado_operacional = true,
         caso_atualizado_por = 'sistema_zerado_sem_debito',
         caso_atualizado_em = now()
    from tmp_alvo z
   where c.id = z.caso_id;
  get diagnostics v_casos = row_count;

  with alvo_aluno as (
    select z.aluno_id, z.a_cpf,
           bool_or(z.quitado_em is not null) as quitado,
           min(z.a_status_atual) as st_ant, min(z.matricula) as matricula
      from tmp_alvo z
     where not z.aluno_encerrado
     group by z.aluno_id, z.a_cpf
  ), novo as (
    select aa.*,
           case when aa.quitado and public.saldo_titulos_aberto(aa.a_cpf) = 0
                then 'QUITADO' else 'SEM_SALDO_EM_ABERTO' end as st_novo
      from alvo_aluno aa
  ), upd as (
    update public.alunos a
       set status_atual = n.st_novo,
           status_jornada = n.st_novo,
           status_acionamento = n.st_novo,
           valor_em_aberto = 0,
           proxima_acao = null,
           data_retorno = null,
           hora_retorno = null,
           registrado_por_email = 'sistema_zerado_sem_debito',
           registrado_em = now()
      from novo n
     where a.id = n.aluno_id
     returning a.id, n.st_ant, n.st_novo, n.matricula
  )
  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em)
  select u.id::text, 'ZERADO_REAL_SEM_SALDO',
         'Sem débito (saldo real zero, sem confirmação ou baixa pendente): aluno encerrado automaticamente. Matrícula '
           || coalesce(u.matricula,'-') || '. Origem: ' || v_quem || '.',
         coalesce(u.st_ant,'(sem)'), u.st_novo, 'Sistema', 'sistema_zerado_sem_debito', now()
    from upd u;
  get diagnostics v_alunos = row_count;

  insert into public.historico_operadores_alunos
    (aluno_id, chave_unificacao, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
  select z.aluno_id, z.chave_unificacao, z.nome, z.cpf, 'ZERADO_REAL_SEM_SALDO',
         z.operador_nome, z.operador_email,
         'Encerrado por saldo zero sem débito. Responsável preservado.', now()
    from tmp_alvo z
   where z.operador_email is not null and not z.aluno_encerrado;

  return jsonb_build_object(
    'snapshot_casos_zerados', v_snapshot_casos,
    'snapshot_alunos_zerados', v_snapshot_alunos,
    'casos_encerrados', v_casos,
    'alunos_encerrados', v_alunos,
    'origem', v_quem,
    'executado_em', now());
end;
$function$;

-- public.recalcular_situacao_aluno: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text DEFAULT NULL::text)
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

  if v_saldo_total <= 0.005 and v_conf_pend = 0 then
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
    'tem_acordo',coalesce(v_tem_acordo,false));
end; $function$;

-- public.titulo_liquidado_na_origem_e_terminal: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.titulo_liquidado_na_origem_e_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tentou text;
begin
  if coalesce(old.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL' then
    return new;
  end if;

  -- As tres marcas nao se apagam: sao a prova de POR QUE o titulo fechou.
  new.origem_liquidacao     := old.origem_liquidacao;
  -- O VELHO VENCE. Nao e coalesce do novo: uma segunda execucao concorrente
  -- chega com OUTRO pagamento em `new`, e deixar o novo ganhar reescreveria a
  -- proveniencia -- o titulo passaria a dizer que foi liquidado por um
  -- pagamento que nao foi o que o liquidou. Gravada uma vez, nao troca mais.
  new.origem_liquidacao_ref := coalesce(old.origem_liquidacao_ref, new.origem_liquidacao_ref);
  new.origem_liquidacao_em  := coalesce(old.origem_liquidacao_em,  new.origem_liquidacao_em);

  if coalesce(new.situacao,'') = 'PAGO' and coalesce(new.status,'') = 'quitada' then
    return new;   -- nada a coagir; segue a vida (acordo_id, motivo, etc.)
  end if;

  v_tentou := coalesce(new.situacao,'(null)') || '/' || coalesce(new.status,'(null)');
  new.situacao := 'PAGO';
  new.status   := 'quitada';
  new.motivo_ajuste := coalesce(new.motivo_ajuste,'')
    || case when coalesce(new.motivo_ajuste,'') = '' then '' else ' | ' end
    || 'tentativa de reabrir titulo liquidado na origem (' || v_tentou
    || ') recusada: a divida ja foi concluida pela liquidacao oficial na Prime';

  -- So registra quando REALMENTE impediu alguma coisa -- e raro, e por isso cabe.
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('sistema', 'TITULO_LIQUIDADO_REABERTURA_RECUSADA', 'acordos_titulos', old.id::text,
          jsonb_build_object('documento', old.documento, 'tentou', v_tentou,
                             'origem_liquidacao_ref', old.origem_liquidacao_ref,
                             'acordo_id_novo', new.acordo_id));
  return new;
end;
$function$;

-- public.caso_protegido_redistribuicao: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.caso_protegido_redistribuicao(p_cpf_limpo text, p_status_acionamento text, p_nao_acionar boolean, p_status_financeiro text DEFAULT NULL::text, p_valor_pago numeric DEFAULT NULL::numeric, p_quitado_em date DEFAULT NULL::date, p_valor_quitado numeric DEFAULT NULL::numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_status_norm text := public.normalizar_status_acionamento(p_status_acionamento);
  v_status_fin_norm text := public.normalizar_status_acionamento(p_status_financeiro);
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf_limpo,''), '\D', '', 'g'), 11, '0');
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL'];
begin
  if coalesce(p_nao_acionar, false) then return true; end if;

  if v_status_norm = any(bloq) or v_status_fin_norm = any(bloq) then
    return true;
  end if;

  if v_cpf = '00000000000' or v_cpf = '' then
    null;
  elsif exists (select 1 from public.acordos a where a.cpf = v_cpf and a.status = 'ATIVO')
     or exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = v_cpf and b.status_baixa = 'AGUARDANDO_BAIXA')
     -- pagamento em transito: protege sempre
     or exists (select 1 from public.links_pagamento l where l.aluno_cpf = v_cpf and l.status = 'AGUARDANDO_BAIXA')
     -- link vivo: protege por um dia
     or exists (select 1 from public.links_pagamento l
                 where l.aluno_cpf = v_cpf
                   and l.status in ('LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO')
                   and coalesce(l.enviado_ao_aluno_em, l.enviado_em, l.criado_em)::date >= current_date - 1)
     or exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_cpf = v_cpf and s.status = 'AGUARDANDO_CONFIRMACAO')
  then
    return true;
  end if;

  if (v_status_norm = any(quit) or v_status_fin_norm = any(quit)
      or coalesce(p_valor_pago,0) > 0 or p_quitado_em is not null or coalesce(p_valor_quitado,0) > 0)
     and public.saldo_titulos_aberto(v_cpf) = 0
  then
    return true;
  end if;

  if v_status_norm in (
    'ACORDO FECHADO','ACORDO EM ANDAMENTO','EM NEGOCIACAO',
    'AGUARDANDO PAGAMENTO','AGUARDANDO FINANCEIRO','EMAIL ENVIADO AO FINANCEIRO','E MAIL ENVIADO FINANC',
    'LINK CARTAO ENVIADO','PAGO PARCIAL','VALORES ENVIADOS','PROPOSTA ENVIADA','PROPOSTA DE EXCECAO',
    'TERMO ENVIADO','TERMO RECEBIDO','EM TRATATIVA','RETORNO AGENDADO'
  ) then
    return true;
  end if;

  return false;
end;
$function$;

-- public.contar_carteira_ativa: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.contar_carteira_ativa(p_email text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::int FROM public.casos c
   WHERE (p_email IS NULL OR c.operador_email = p_email)
     AND (p_email IS NOT NULL OR c.operador_email IS NOT NULL)
     AND c.encerrado_operacional = false;
$function$;

-- public.assumir_caso_livre: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.assumir_caso_livre(p_caso_id uuid)
 RETURNS TABLE(sucesso boolean, mensagem text, caso_liberado uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text; v_nome text; v_upper text; v_new record; v_new_saldo numeric; v_count int;
  v_rel record; v_liberado uuid := null;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  if v_email = '' then return query select false,'Usuario nao identificado. Faca login novamente.',null::uuid; return; end if;
  v_nome := public.nome_operador_por_email(v_email);
  if v_nome is null then return query select false,'Operador nao ativo ou nao identificado.',null::uuid; return; end if;
  v_upper := upper(v_nome);
  select c.*, public.saldo_titulos_aberto(c.cpf_limpo) AS _saldo into v_new
    from public.casos c where c.id = p_caso_id for update;
  if not found then return query select false,'Caso nao encontrado.',null::uuid; return; end if;
  if coalesce(v_new.operador_email,'') <> '' then
    return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
  end if;
  if public.caso_protegido_redistribuicao(v_new.cpf_limpo,v_new.status_acionamento,v_new.nao_acionar,v_new.status_financeiro,v_new.valor_pago,v_new.quitado_em,v_new.valor_quitado)
     or public.caso_encerrado_operacional(v_new.cpf_limpo,v_new.status_atual,v_new.status_acionamento,v_new.status_financeiro,v_new.status_jornada)
     or coalesce(v_new._saldo,0) <= 0 then
    return query select false,'Caso nao elegivel (protegido, encerrado ou sem saldo).',null::uuid; return;
  end if;
  v_new_saldo := v_new._saldo;
  v_count := (select count(*) from public.casos where operador_email = v_email);
  if v_count >= 500 then
    select c.id into v_rel from public.casos c
    where c.operador_email = v_email and c.ultima_tabulacao_em is null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc, c.caso_atualizado_em desc nulls last
    limit 1 for update skip locked;
    if v_rel.id is null then
      return query select false,'Carteira cheia (500) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;
    end if;
    v_liberado := v_rel.id;
    update public.casos set operador_email=null, operador_nome=null, operador=null where id = v_liberado;
    insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_anterior_nome,operador_anterior_email,observacao,criado_em)
    select chave_unificacao,nome,cpf,'LIBERACAO_TROCA_ASSUMIR',v_nome,v_email,'Liberado por troca ao assumir caso '||p_caso_id::text||'.',now()
    from public.casos where id = v_liberado;
  end if;
  update public.casos set operador_email=v_email, operador_nome=v_nome, operador=v_upper,
    caso_atualizado_por=v_email, caso_atualizado_em=now()
  where id = p_caso_id;
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_nome,operador_email,observacao,criado_em)
  select chave_unificacao,nome,cpf,'ASSUMIR_ATENDIMENTO',v_nome,v_email,
    'Assumido caso livre. assumido_por='||v_email||' assumido_em='||now()::text||'. Fidelizacao inicia apenas apos acionamento valido.', now()
  from public.casos where id = p_caso_id;
  if (select count(*) from public.casos where operador_email = v_email) > 500 then
    raise exception 'ROLLBACK: operador ficaria com mais de 500 casos.';
  end if;
  return query select true, 'Atendimento assumido. Acione dentro do prazo operacional para iniciar a fidelizacao de 10 dias.', v_liberado;
end;
$function$;

-- public.nivelar_medias_progressivo: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.nivelar_medias_progressivo()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_media_alvo numeric; v_op RECORD; v_caso RECORD; v_pool_id uuid;
  v_margem numeric := 500; v_max_trocas_por_operador int := 5; v_total INT := 0;
BEGIN
  SELECT round(avg(coalesce(total_em_aberto,0))::numeric,2) INTO v_media_alvo FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br';
  IF v_media_alvo IS NULL THEN RETURN 0; END IF;
  FOR v_op IN SELECT operador_email, round(avg(coalesce(total_em_aberto,0))::numeric,2) AS media FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br' GROUP BY operador_email LOOP
    IF v_op.media > v_media_alvo + v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto DESC NULLS LAST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    ELSIF v_op.media < v_media_alvo - v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_total;
END; $function$;

-- public.reforcar_teto_operadores: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.reforcar_teto_operadores()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op RECORD;
  v_caso RECORD;
  v_total INT := 0;
BEGIN
  FOR v_op IN
    SELECT operador_email, count(*) AS qtd
    FROM public.casos
    WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br'
    GROUP BY operador_email HAVING count(*) > 500
  LOOP
    FOR v_caso IN
      SELECT c.id FROM public.casos c
      JOIN public.alunos a ON a.id = c.aluno_id
      WHERE c.operador_email = v_op.operador_email
        AND c.quitado_em IS NULL
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%CANCEL%'
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%JURIDIC%'
        AND coalesce(c.status_acionamento,'') NOT ILIKE '%ACORDO%'
        AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
        AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
        AND NOT public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
      ORDER BY a.data_ultimo_acionamento ASC NULLS FIRST
      LIMIT (v_op.qtd - 500)
    LOOP
      UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL,
        caso_atualizado_por = 'job_reforco_teto', caso_atualizado_em = now()
      WHERE id = v_caso.id;
      v_total := v_total + 1;
    END LOOP;
  END LOOP;
  RETURN v_total;
END;
$function$;

-- public.prime_conferencia_baixar: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.prime_conferencia_baixar(p_titulo_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_titulo    public.acordos_titulos%rowtype;
  v_liquidado date;
  v_valor     numeric;
  v_bloqueio  text;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'SEM_PERMISSAO: seu usuário não pode dar baixa em título.';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;

  if v_titulo.status <> 'em_aberto' then
    return jsonb_build_object('ja_processado', true, 'status', v_titulo.status, 'situacao', v_titulo.situacao);
  end if;

  select case
           when upper(coalesce(a.status_jornada,''))     in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_jornada)
           when upper(coalesce(a.status_atual,''))       in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_atual)
           when upper(coalesce(a.status_acionamento,'')) in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_acionamento)
         end
    into v_bloqueio
  from public.alunos a where a.id = v_titulo.aluno_id;

  if v_bloqueio is not null then
    raise exception 'COBRANCA_NAO_COMUM: aluno está como % -- fora do escopo desta conferência.', v_bloqueio;
  end if;

  select p.liquidado_em into v_liquidado
  from public.prime_titulo_semestre p
  where btrim(coalesce(p.boleto,'')) = btrim(coalesce(v_titulo.documento,''))
    and coalesce(p.boleto,'') <> ''
    and p.liquidado_em is not null
  limit 1;

  if v_liquidado is null then
    raise exception 'SEM_PROVA_NA_PRIME: este titulo nao tem boleto liquidado na Prime.';
  end if;

  if exists (select 1 from public.acordos ac where ac.aluno_id = v_titulo.aluno_id and ac.status = 'CANCELADO') then
    raise exception 'ACORDO_CANCELADO: aluno tem acordo cancelado -- conferir na mao.';
  end if;

  v_valor := round(coalesce(v_titulo.valor_em_aberto, v_titulo.saldo_corrigido, v_titulo.valor_original, 0), 2);

  update public.acordos_titulos set status = 'quitada', situacao = 'PAGO' where id = p_titulo_id;

  if v_titulo.aluno_id is not null then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_titulo.aluno_id::text,
      'BAIXA_CONFERENCIA_PRIME',
      concat_ws(' ',
        'Titulo', btrim(coalesce(v_titulo.documento,'')),
        'venc.', to_char(v_titulo.vencimento, 'DD/MM/YYYY'),
        'baixado por conferencia com a Prime (liquidado em',
        to_char(v_liquidado, 'DD/MM/YYYY') || ').',
        nullif(btrim(coalesce(p_observacao,'')), '')
      ),
      v_email, now(), v_valor
    );
  end if;

  return jsonb_build_object('ja_processado', false, 'titulo_id', p_titulo_id,
                            'valor_baixado', v_valor, 'liquidado_em', v_liquidado);
end;
$function$;

-- public.prime_conferencia_confirmar: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.prime_conferencia_confirmar(p_titulo_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', '')); v_res jsonb;
begin
  v_res := public.prime_conferencia_baixar(p_titulo_id, p_observacao);

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  values (p_titulo_id, 'CONFIRMADO', nullif(trim(coalesce(p_observacao,'')),''), nullif(v_email,''))
  on conflict (titulo_id) do update
    set decisao = 'CONFIRMADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'decisao', 'CONFIRMADO');
end;
$function$;

-- public.prime_conferencia_rejeitar: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.prime_conferencia_rejeitar(p_titulo_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  values (p_titulo_id, 'REJEITADO', nullif(trim(coalesce(p_motivo,'')),''), nullif(v_email,''))
  on conflict (titulo_id) do update
    set decisao = 'REJEITADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  return jsonb_build_object('ok', true, 'decisao', 'REJEITADO');
end;
$function$;

-- public.prime_conferencia_rejeitar_lote: texto de producao de 18/09/2026
CREATE OR REPLACE FUNCTION public.prime_conferencia_rejeitar_lote(p_titulo_ids uuid[], p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_n int;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  if p_titulo_ids is null or array_length(p_titulo_ids, 1) is null then
    return jsonb_build_object('ok', false, 'motivo', 'LISTA_VAZIA');
  end if;

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  select t, 'REJEITADO', nullif(trim(coalesce(p_motivo,'')),''), nullif(v_email,'')
    from unnest(p_titulo_ids) as t
  on conflict (titulo_id) do update
    set decisao = 'REJEITADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'rejeitados', v_n);
end;
$function$;

-- a fila volta a assinatura antiga
drop function if exists public.prime_conferencia_fila();
CREATE OR REPLACE FUNCTION public.prime_conferencia_fila()
 RETURNS TABLE(titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text, vencimento date, valor_em_aberto numeric, liquidado_em date, tem_acordo_ativo boolean, operador_responsavel text, portador integer, portador_diz text, dinheiro text, dinheiro_diz text, lote_titulos numeric, lote_pago numeric, lote_cobertura numeric, lote_diz text, acordo_situacao text, acordo_diz text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
  with inicio as (select coalesce(min(data_pagamento), current_date) as d from public.pagamentos),
  base as (
    select l.*, pt.carrier_id, inicio.d as inicio_base
      from public.prime_conferencia_listar() l
      cross join inicio
      left join lateral (
        select p.carrier_id from public.prime_titulo_semestre p
         where p.boleto = l.documento limit 1
      ) pt on true
     where not exists (
       select 1 from public.prime_conferencia_decisao dc where dc.titulo_id = l.titulo_id
     )
  ),
  lote as (
    select b.aluno_id, b.liquidado_em,
           sum(b.valor_em_aberto) as soma_titulos,
           (select coalesce(sum(p.valor_pago),0) from public.pagamentos p
             where p.aluno_id = b.aluno_id
               and p.data_pagamento between b.liquidado_em - 5 and b.liquidado_em + 5) as soma_pago
      from base b
     where b.liquidado_em is not null
     group by 1,2
  )
  select b.titulo_id, b.aluno_id, b.aluno_nome, b.cpf, b.documento,
         b.vencimento, b.valor_em_aberto, b.liquidado_em,
         b.tem_acordo_ativo, b.operador_responsavel,
         b.carrier_id,
         case b.carrier_id
           when 195 then 'Prime ainda cobra este título'
           when 166 then 'Prime tirou da cobrança'
           else case when b.carrier_id is null then 'Prime não informa o portador'
                     else 'Portador ' || b.carrier_id::text end
         end,
         d.veredito,
         case d.veredito
           when 'ENTROU'     then 'Pagamento do aluno no Santander na mesma janela'
           when 'OUTRA_DATA' then 'Aluno pagou, mas em data diferente da liquidação'
           when 'NAO_ENTROU' then 'Nenhum pagamento do aluno — liquidou sem dinheiro entrar'
           else 'Liquidado antes de a base ter pagamentos — não dá para julgar'
         end,
         round(lo.soma_titulos, 2), round(lo.soma_pago, 2),
         case when coalesce(lo.soma_titulos,0) > 0
              then round(100.0 * lo.soma_pago / lo.soma_titulos, 0) end,
         case
           when lo.soma_titulos is null then null
           when lo.soma_pago >= lo.soma_titulos * 0.98 then 'O pagamento cobre todos os títulos liquidados neste dia'
           when lo.soma_pago >= lo.soma_titulos * 0.5  then 'O pagamento cobre só parte do que foi liquidado'
           when lo.soma_pago > 0 then 'Pagou muito abaixo do que foi liquidado — provável negociação'
           else null
         end,
         ac.situacao,
         case ac.situacao
           when 'SEM_ACORDO'      then 'Liquidou no Prime e não existe acordo no CRM — simulação que não virou nada'
           when 'ACORDO_ATIVO'    then 'Tem acordo ativo: o título virou acordo e segue aberto — cobrança em dobro'
           when 'ACORDO_ENCERRADO' then 'Teve acordo, já encerrado'
           else null
         end
    from base b
    join lateral (
      select case
        when b.liquidado_em is null or b.liquidado_em < b.inicio_base then 'FORA_DA_JANELA'
        when exists (select 1 from public.pagamentos p
                      where p.aluno_id = b.aluno_id
                        and p.data_pagamento between b.liquidado_em - 5 and b.liquidado_em + 5)
          then 'ENTROU'
        when exists (select 1 from public.pagamentos p where p.aluno_id = b.aluno_id)
          then 'OUTRA_DATA'
        else 'NAO_ENTROU'
      end as veredito
    ) d on true
    join lateral (
      select case
        when exists (select 1 from public.acordos a
                      where a.aluno_id = b.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO')
          then 'ACORDO_ATIVO'
        when exists (select 1 from public.acordos a where a.aluno_id = b.aluno_id)
          then 'ACORDO_ENCERRADO'
        else 'SEM_ACORDO'
      end as situacao
    ) ac on true
    left join lote lo on lo.aluno_id = b.aluno_id and lo.liquidado_em = b.liquidado_em;
$function$;
revoke all on function public.prime_conferencia_fila() from public, anon;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;

drop function if exists public.prime_conferencia_vincular(uuid, uuid, text);
drop function if exists public.prime_conferencia_detectar_grupo_a(boolean, uuid[], integer);
drop function if exists public.prime_grupo_a_candidatos(uuid[]);
drop function if exists public._titulo_em_confirmacao_protegido();
drop function if exists public.caso_aguarda_confirmacao_financeira(uuid);

drop index if exists public.ix_acordos_titulos_em_confirmacao_aluno;
drop index if exists public.ix_prime_conferencia_decisao_pendente;
alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_subgrupo_check;

-- as fichas dos alunos devolvidos, pela regra antiga
select public.recalcular_situacao_aluno(aluno_id, 'rollback_grupo_a') from _rb_alunos;

commit;
