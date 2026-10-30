set check_function_bodies = false;

create schema if not exists auth;

create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''), 'null')::jsonb $$;

create or replace function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt()->>'role', 'anon') $$;

create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

CREATE TABLE public.acoes_desfazer (id uuid NOT NULL, tipo text NOT NULL, aluno_id uuid NOT NULL, aluno_nome text, referencia_id uuid, movimentacao_id bigint, operador_email text NOT NULL, operador_nome text, rotulo text NOT NULL, estado_anterior jsonb, atribuiu_responsavel boolean NOT NULL, criado_em timestamp with time zone NOT NULL, desfeito_em timestamp with time zone, desfeito_por text, motivo text, resultado jsonb);

CREATE TABLE public.acordos (id uuid NOT NULL, aluno_id uuid, cpf text, tipo text NOT NULL, forma_pagamento text NOT NULL, valor_total numeric, qtd_parcelas integer NOT NULL, valor_entrada numeric, entrada_paga boolean NOT NULL, data_entrada date, status text NOT NULL, observacao text, criado_por_nome text, criado_por_email text, confirmado_por_email text, confirmado_em timestamp with time zone, criado_em timestamp with time zone NOT NULL, atualizado_em timestamp with time zone NOT NULL, numero_acordo bigint NOT NULL, operador_responsavel_email text, unidade text, entrada_percentual numeric, honorarios_percentual numeric, honorarios_valor numeric, saldo numeric, motivo_ajuste text, operador_responsavel_nome text, duplicado_de uuid, duplicado_marcado_em timestamp with time zone, numero_ulbra text);

CREATE TABLE public.acordos_titulos (id uuid NOT NULL, aluno_id uuid, cpf text, documento text, vencimento date, valor_original numeric(14,2), saldo_corrigido numeric(14,2), situacao text, tipo_boleto text, dados jsonb, importacao_id uuid, created_at timestamp without time zone, status text NOT NULL, valor_em_aberto numeric, competencia text, motivo_ajuste text, atualizado_em timestamp with time zone, acordo_id uuid, vinculado_em timestamp with time zone, vinculado_por text, valor_cobranca_ajustado numeric, motivo_ajuste_valor text, valor_ajustado_por text, valor_ajustado_em timestamp with time zone, origem_liquidacao text, origem_liquidacao_ref text, origem_liquidacao_em timestamp with time zone, origem_encerramento text, origem_encerramento_ref text, origem_encerramento_em timestamp with time zone, devolucao_origem text, devolucao_ref text, devolucao_em timestamp with time zone, devolucao_por text, devolucao_situacao_anterior text);

CREATE TABLE public.aluno_movimentacoes (id bigint NOT NULL, aluno_id text NOT NULL, tipo text NOT NULL, descricao text, status_anterior text, status_novo text, registrado_por_nome text, registrado_por_email text, registrado_em timestamp with time zone NOT NULL, operador_anterior_nome text, operador_anterior_email text, operador_novo_nome text, operador_novo_email text, data_retorno timestamp with time zone, solicitacao_link_id uuid, baixa_pagamento_id uuid, link_pagamento text, motivo_devolucao text, valor_movimentacao numeric, elogio_print_path text, elogio_print_nome text, elogio_aprovado_tv boolean, elogio_aprovado_por text, elogio_aprovado_em timestamp with time zone, elogio_rejeitado_tv boolean, elogio_rejeitado_por text, elogio_rejeitado_em timestamp with time zone, lote_id uuid);

CREATE TABLE public.alunos (id uuid NOT NULL, cpf text, cpf_mascarado text, matricula text, nome text NOT NULL, email text, telefone text, curso text, unidade text, semestre text, situacao_academica text, status_jornada text, origem text, aluno_novo boolean, sem_telefone boolean, sem_email boolean, created_at timestamp without time zone, updated_at timestamp without time zone, nome_normalizado text, operador text, status_atual text, ultimo_contato date, data_retorno date, valor_em_aberto numeric(12,2), hora_retorno text, atualizado_em timestamp with time zone, operador_nome text, operador_email text, observacao text, tipo_base text, nome_aluno text, nome_referencia text, cpf_corrigido text, cpf_status_correcao text, registro_unico uuid, chave_unificacao text, unificacao_status text, registrado_por_nome text, registrado_por_email text, registrado_em timestamp with time zone, responsavel_atual_nome text, responsavel_atual_email text, responsavel_atual_em timestamp with time zone, status_acionamento text, proxima_acao text, data_ultimo_acionamento timestamp with time zone, status_link_pagamento text, status_baixa_pagamento text, fila_destino text, ultimo_link_pagamento_id uuid, ultima_baixa_pagamento_id uuid, nivel_criticidade text, processo_numero text, processo_prazo_tipo text, processo_prazo_data date, nome_resp1 text, telefone_resp1 text, nome_resp2 text, telefone_resp2 text, situacao_operacional text, saldo_vencido numeric, saldo_total numeric, curso_real text, academico_codigo text, academico_fonte text, academico_atualizado_em timestamp with time zone, retorno_confirmado_em timestamp with time zone, retorno_origem text, semestre_divida text, semestre_divida_em timestamp with time zone, retorno_prioritario boolean NOT NULL);

CREATE TABLE public.casos (id uuid NOT NULL, caso_codigo integer, cpf_original text, cpf_limpo text, cpf_mascarado text, matricula text, nome text, nome_normalizado text, operador_base text, operador_mensalidade text, operador_acordo text, operador_acordo_planilha text, status_atual text, data_ultimo_acionamento date, status_acionamento text, criticidade text, proxima_acao_automatica text, total_em_aberto numeric, data_retorno date, dias_atraso integer, nivel_carteira text, sla_operacional text, urgencia text, observacoes text, mensalidades_em_aberto numeric, acordo_em_aberto numeric, parcela_a_vencer numeric, parcelas_vencidas numeric, proximo_vencimento date, valor_pago numeric, honorario numeric, data_pagamento date, status_financeiro text, observacao_financeira text, created_at timestamp without time zone, data_retorno_nova date, ultima_tabulacao_em timestamp without time zone, fila_responsavel text, hora_retorno time without time zone, observacao_operacional text, status_termo text, termo_status_validacao text, termo_url text, termo_nome_arquivo text, termo_observacao text, termo_motivo_rejeicao text, termo_enviado_por text, termo_validado_por text, termo_validado_em timestamp with time zone, nome_aluno text, cpf text, status_jornada text, operador text, observacao text, aluno text, nome_completo text, email text, telefone text, curso text, unidade text, semestre text, ultimo_acionamento date, valor_em_aberto numeric, valor_aberto numeric, valor_total numeric, valor_divida numeric, saldo_devedor numeric, valor numeric, origem text, operador_nome text, operador_email text, nome_referencia text, cpf_corrigido text, cpf_status_correcao text, registro_unico uuid, chave_unificacao text, unificacao_status text, origem_quitacao text, quitado_em date, valor_quitado numeric, baixa_importada_id uuid, valor_cobranca_ajustado numeric, motivo_ajuste_valor text, valor_ajustado_por text, valor_ajustado_em timestamp with time zone, cadastro_caso_observacao text, caso_atualizado_por text, caso_atualizado_em timestamp with time zone, nao_acionar boolean NOT NULL, aluno_id uuid, nivelamento_marcador text, nivelamento_em timestamp with time zone, nivelamento_simulacao_id uuid, situacao_operacional text, saldo_vencido numeric, saldo_total numeric, encerrado_operacional boolean NOT NULL, operador_mensalidade_email text, operador_mensalidade_nome text, mensalidade_girada_em timestamp with time zone, giro_fidelizacao_ate date);

CREATE TABLE public.pagamentos (id uuid NOT NULL, aluno_id uuid, cpf text, data_pagamento date, valor_pago numeric(14,2), tipo_pagamento text, entrada_paga boolean, dados jsonb, importacao_id uuid, created_at timestamp without time zone, operador_email text, operador_nome text, valor_honorario numeric, aluno_nome text, retroativo boolean NOT NULL, titulo_numero text, operador_ajustado_manualmente boolean NOT NULL, numero_parcela_completo text, matricula text, origem_vinculo text, origem_vinculo_ref text, origem_vinculo_em timestamp with time zone, status_conciliacao text, conciliacao_motivo text, conciliacao_em timestamp with time zone);

CREATE TABLE public.parcelas (id uuid NOT NULL, acordo_id uuid NOT NULL, numero integer NOT NULL, valor numeric, vencimento date, status text NOT NULL, pago_em timestamp with time zone, confirmado_por_email text, observacao text, solicitacao_confirmacao_id uuid, criado_em timestamp with time zone NOT NULL, atualizado_em timestamp with time zone NOT NULL, honorarios numeric, forma_pagamento text, is_entrada boolean, boleto text, titulos_origem text, boleto_confiavel boolean NOT NULL, renegociada_em timestamp with time zone, renegociada_no_acordo_id uuid, origem_baixa text, origem_baixa_ref text, origem_baixa_em timestamp with time zone, efeito_sem_pagamento text, efeito_sem_pagamento_origem text, efeito_sem_pagamento_por text, efeito_sem_pagamento_em timestamp with time zone);

CREATE TABLE public.prime_contratos (cpf text NOT NULL, registration text NOT NULL, valid_from date NOT NULL, valid_to date, status text, tipo text, curso text, campus text, turno text, periodo_curso integer, cancelado_em date, coletado_em timestamp with time zone NOT NULL);

CREATE TABLE public.prime_extrato (matricula text NOT NULL, boleto text NOT NULL, cpf text, vencimento date, liquidado_em date, valor_liquido numeric, valor_pago numeric, honorario numeric, de_acordo boolean, portador integer, portador_nome text, coletado_em timestamp with time zone NOT NULL, valor_bruto numeric, desconto numeric, multa numeric, juros numeric);

CREATE TABLE public.solicitacoes_confirmacao_pagamento (id uuid NOT NULL, aluno_id text, aluno_nome text, aluno_cpf text, operador_email text, operador_nome text, valor_informado numeric, motivo text, status text NOT NULL, observacao_adm text, confirmado_por text, confirmado_em timestamp with time zone, criado_em timestamp with time zone NOT NULL, atualizado_em timestamp with time zone NOT NULL, acordo_id uuid, parcela_id uuid, forma_pagamento text, qtd_parcelas integer, valor_entrada numeric, entrada_paga boolean, titulo_id uuid, data_pagamento date, tipo_pagamento text, comprovante_link_id uuid, dados_vinculados_em timestamp with time zone, dados_vinculados_por_email text, principal_referencia numeric, juros numeric, multa numeric, honorarios numeric, total_negociado numeric, composicao_validada_em timestamp with time zone, composicao_validada_por_email text, pagamento_id uuid, origem_divida text);

CREATE TABLE public.acordo_titulo_vinculo (id uuid NOT NULL, acordo_id uuid NOT NULL, titulo_id uuid NOT NULL, ativo boolean NOT NULL, vinculado_por text, motivo_desvinculo text, criado_em timestamp with time zone NOT NULL, origem text);

CREATE TABLE public.caso_encerramento_sem_saldo (id bigint NOT NULL, escopo text NOT NULL, caso_id uuid, aluno_id uuid, cpf_congelado text, classificacao text NOT NULL, saldo_no_momento numeric, estado_anterior jsonb NOT NULL, justificativa text NOT NULL, decidido_por text, decidido_em timestamp with time zone, origem text NOT NULL, evidencia jsonb, resolvido_em timestamp with time zone, resolvido_por text, registrado_em timestamp with time zone NOT NULL);

CREATE OR REPLACE FUNCTION public._caso_encerrado_operacional_regra(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                       'SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO',
                       'ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO',
                       'SALDO ZERO CONFIRMADO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;

  if public._encerramento_congelado(p_aluno_id, p_caso_id, p_cpf, nat, nac, nfi, njo) then return true; end if;

  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit))
     and public._caso_sem_saldo_conferido(p_aluno_id, p_cpf) then return true; end if;

  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION public._caso_sem_saldo_conferido(p_aluno_id uuid, p_cpf text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cpf  text := public._cpf11(p_cpf);
  v_aid  uuid := p_aluno_id;
  v_n    int;
begin
  if v_aid is null then
    if v_cpf is null then
      return false;
    end if;
    select count(*) into v_n
      from public.alunos al
     where lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf;
    if coalesce(v_n,0) <> 1 then
      return false;
    end if;
    select al.id into v_aid
      from public.alunos al
     where lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf
     limit 1;
  end if;
  return coalesce((public.aluno_saldo_pendente_detalhe(v_aid)->>'total')::numeric, -1) <= 0.005;
end;
$function$;

CREATE OR REPLACE FUNCTION public._cpf11(p_cpf text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(lpad(regexp_replace(coalesce(p_cpf,''), '\D', '', 'g'), 11, '0'), '00000000000');
$function$;

CREATE OR REPLACE FUNCTION public._encerramento_congelado(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_nat text DEFAULT NULL::text, p_nac text DEFAULT NULL::text, p_nfi text DEFAULT NULL::text, p_njo text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.caso_encerramento_sem_saldo e
     where e.resolvido_em is null
       and (
         e.caso_id = p_caso_id
         or (p_caso_id is null and e.escopo = 'ALUNO' and e.aluno_id = p_aluno_id)
         or (e.cpf_congelado is not null
             and e.cpf_congelado = public._cpf11(p_cpf)
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_atual','')) = coalesce(p_nat,'')
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_acionamento','')) = coalesce(p_nac,'')
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_jornada','')) = coalesce(p_njo,'')
             and (e.escopo = 'ALUNO'
                  or public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_financeiro','')) = coalesce(p_nfi,'')))));
$function$;

CREATE OR REPLACE FUNCTION public.parcela_viva(p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select upper(coalesce(p_status, '')) not in (
    -- pagamento real (regra 1: so aqui entra dinheiro)
    'PAGO', 'PAGA',
    -- saida por cancelamento/estorno
    'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO',
    -- regra 2: saiu definitivamente da nossa responsabilidade, SEM pagamento
    'DEVOLVIDA',
    -- regra 3: cobranca suspensa temporariamente, SEM pagamento
    'SUSPENSA'
  );
$function$;

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
  v_tit_conf       int := 0;
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
     and public.parcela_viva(p.status);

  select count(*)
    into v_conf_pendentes
    from public.solicitacoes_confirmacao_pagamento s
   where s.aluno_id = p_aluno_id::text
     and s.status = 'AGUARDANDO_CONFIRMACAO'
     and (p_ignorar_confirmacao_id is null or s.id <> p_ignorar_confirmacao_id);

  -- Titulo aguardando a Conferencia Prime: fora do total exigivel (nao e
  -- cobrado), mas e pendencia -- ninguem quita nem encerra o aluno por ele.
  select count(*)
    into v_tit_conf
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO';

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
    'titulos_em_confirmacao', v_tit_conf,
    'tem_pendencia', (v_total > 0.005 or v_conf_pendentes > 0 or v_tit_conf > 0)
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.caso_em_giro_fidelizacao(p_ate date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_ate is not null
     and p_ate >= (now() at time zone 'America/Sao_Paulo')::date;
$function$;

CREATE OR REPLACE FUNCTION public.acoes_massivas_fora_do_universo()
 RETURNS TABLE(motivo_fora text, alunos integer, titulos integer, valor numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$ declare v_sistema boolean := (auth.role() = 'service_role') or (auth.jwt() is null and session_user in ('postgres','reativa_responsavel_executor')); begin if not v_sistema and not public.usuario_e_gestao() then raise exception 'Acesso negado: auditoria do universo das acoes massivas restrita a gestao.' using errcode = '42501'; end if; return query with u as materialized (select x.aluno_id from public.acoes_massivas_universo('{"operador":"todos"}'::jsonb) x), cand as (select t.aluno_id, case when coalesce(t.tipo_boleto, '') = 'Acordo' then 'BOLETO_DE_ACORDO' else 'SITUACAO_' || upper(coalesce(nullif(btrim(t.situacao), ''), 'NULA')) end as motivo, coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v from public.acordos_titulos t where t.aluno_id is not null and coalesce(lower(t.status), '') <> 'quitada') select c.motivo, count(distinct c.aluno_id)::int, count(*)::int, round(sum(c.v), 2) from cand c where c.v > 0 and not exists (select 1 from u where u.aluno_id = c.aluno_id) group by c.motivo order by 4 desc; end; $function$;

CREATE OR REPLACE FUNCTION public.acoes_massivas_liquidados_prime(p_aluno_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(aluno_id uuid, titulos integer, valor_crm numeric, pago_prime numeric, ultima_liquidacao date)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with vivos as (
    select t.id, t.aluno_id, t.cpf, t.vencimento, t.created_at::date as importado,
           regexp_replace(coalesce(t.documento,''), '\D', '', 'g') as boleto,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v
      from public.acordos_titulos t
     where (p_aluno_ids is null or t.aluno_id = any(p_aluno_ids))
       and upper(coalesce(t.situacao,'')) = 'ABERTO'
       and coalesce(lower(t.status),'') <> 'quitada'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and not exists (
         select 1 from public.acordo_titulo_vinculo vv
           join public.acordos ac on ac.id = vv.acordo_id
          where vv.titulo_id = t.id and coalesce(vv.ativo, true)
            and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA'))
  ),
  cls as (
    select v.aluno_id, v.v, e.liquidado_em, e.valor_pago,
           (e.liquidado_em is not null
            and e.liquidado_em > v.vencimento + 30
            and e.liquidado_em >= v.importado
            and coalesce(e.valor_pago, 0) > 0) as liquidado_real
      from vivos v
      left join lateral (
        select e.liquidado_em, e.valor_pago
          from public.prime_extrato e
         where e.boleto = v.boleto and e.cpf = v.cpf
         order by e.coletado_em desc limit 1) e on true
  )
  select cls.aluno_id, count(*)::int, sum(cls.v), sum(cls.valor_pago), max(cls.liquidado_em)
    from cls
   group by cls.aluno_id
  having bool_and(cls.liquidado_real)
     and not exists (select 1 from public.acordos ac
                      where ac.aluno_id = cls.aluno_id
                        and upper(coalesce(ac.status,'')) in ('CANCELADO','CANCELADA'))
     and (sum(cls.valor_pago) >= sum(cls.v) * 0.5
          or exists (select 1 from public.acordos ac
                      where ac.aluno_id = cls.aluno_id
                        and upper(coalesce(ac.status,'')) like 'QUITADO%'));
$function$;

CREATE OR REPLACE FUNCTION public.acoes_massivas_tipo_cobertura(p_tipo text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(p_tipo, '') in (
    'FINALIZACAO_ATENDIMENTO', 'FINALIZACAO', 'CONTATO',
    'LINK_ENVIADO_AO_ALUNO', 'SOLICITACAO_LINK_PAGAMENTO',
    'ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL');
$function$;

CREATE OR REPLACE FUNCTION public.acoes_massivas_tipo_cobranca_alunos(p_aluno_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(aluno_id uuid, tem_mensalidade boolean, tem_acordo_vencido boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with mens as (
    select distinct t.aluno_id
      from public.acordos_titulos t
     where (p_aluno_ids is null or t.aluno_id = any(p_aluno_ids))
       and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
       and coalesce(lower(t.status), '') <> 'quitada'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA'))
  ),
  ativo as (
    select distinct a.aluno_id
      from public.acordos a
     where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
       and a.status = 'ATIVO'
  ),
  vencido as (
    select distinct a.aluno_id
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
       and a.status = 'ATIVO'
       and p.status = 'VENCIDA'
  ),
  -- acordo vencido, ou mensalidade sem acordo em dia (acordo ativo sem vencida)
  populacao as (
    select v.aluno_id from vencido v
    union
    select m.aluno_id from mens m
     where not exists (select 1 from ativo x where x.aluno_id = m.aluno_id)
  )
  select p.aluno_id,
         exists (select 1 from mens m where m.aluno_id = p.aluno_id),
         exists (select 1 from vencido v where v.aluno_id = p.aluno_id)
    from populacao p;
$function$;

CREATE OR REPLACE FUNCTION public.acoes_massivas_tipo_cobranca_corresponde(p_tipo text, p_tem_mensalidade boolean, p_tem_acordo_vencido boolean)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case upper(coalesce(p_tipo, ''))
           -- mensalidade SEM acordo vencido: quem tem os dois fica nos acordos
           when 'MENSALIDADES' then coalesce(p_tem_mensalidade, false) and not coalesce(p_tem_acordo_vencido, false)
           when 'ACORDOS_VENCIDOS' then coalesce(p_tem_acordo_vencido, false)
           when 'MENSALIDADES_E_ACORDOS' then coalesce(p_tem_mensalidade, false) or coalesce(p_tem_acordo_vencido, false)
           else false
         end;
$function$;

CREATE OR REPLACE FUNCTION public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_data_ultimo_acionamento is not null
     and p_data_ultimo_acionamento + 10 >= current_date;
$function$;

CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._caso_encerrado_operacional_regra(
    p_aluno_id, p_caso_id, p_cpf, p_status_atual, p_status_acionamento, p_status_financeiro, p_status_jornada);
$function$;

CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._caso_encerrado_operacional_regra(
    null::uuid, null::uuid, p_cpf, p_status_atual, p_status_acionamento, p_status_financeiro, p_status_jornada);
$function$;

CREATE OR REPLACE FUNCTION public.normalizar_status_acionamento(p_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT trim(regexp_replace(
    upper(unaccent(coalesce(p_status, ''))),
    '[_\-]+', ' ', 'g'
  ));
$function$;

CREATE OR REPLACE FUNCTION public.semestre_corrente_inicio()
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when extract(month from current_date) <= 6
              then make_date(extract(year from current_date)::int, 1, 1)
              else make_date(extract(year from current_date)::int, 7, 1) end;
$function$;

CREATE OR REPLACE FUNCTION public.usuario_e_gestao()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$function$;
