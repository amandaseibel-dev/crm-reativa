-- Definicoes de producao (somente leitura) em 2026-11-18, geradas de funcoes_prod.json.
set check_function_bodies = off;

-- public._caso_encerrado_operacional_regra(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text) · md5(prosrc) 9472634d1c8adde3a5906fbaebbb8486
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

-- public._caso_sem_saldo_conferido(p_aluno_id uuid, p_cpf text) · md5(prosrc) d72413941a1fc042a46af618239462ed
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

-- public._cpf11(p_cpf text) · md5(prosrc) 09e6a3d7df4915eb9cbb20b8d97445e6
CREATE OR REPLACE FUNCTION public._cpf11(p_cpf text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(lpad(regexp_replace(coalesce(p_cpf,''), '\D', '', 'g'), 11, '0'), '00000000000');
$function$;

-- public._encerramento_congelado(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_nat text, p_nac text, p_nfi text, p_njo text) · md5(prosrc) 8d3f4963997789ad94f28d571d310fb9
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

-- public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar_confirmacao_id uuid) · md5(prosrc) 1f676604ebeba3561eafc6306e187ba2
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

-- public.calibragem_e_gestao() · md5(prosrc) cee6783831836f9fccdbd20b63cf4296
CREATE OR REPLACE FUNCTION public.calibragem_e_gestao()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_email = '' then return false; end if;
  if v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then return true; end if;
  return false;
end; $function$;

-- public.caso_aguarda_confirmacao_financeira(p_aluno_id uuid) · md5(prosrc) de84992ce76af33281ef09f8505bcfc3
CREATE OR REPLACE FUNCTION public.caso_aguarda_confirmacao_financeira(p_aluno_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_aluno_id is not null
     and exists (select 1 from public.acordos_titulos t
                  where t.aluno_id = p_aluno_id
                    and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
     and coalesce((select sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
                     from public.acordos_titulos t
                    where t.aluno_id = p_aluno_id
                      and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                      and coalesce(lower(t.status),'') <> 'quitada'
                      and coalesce(t.tipo_boleto,'') <> 'Acordo'
                      and not exists (select 1 from public.acordo_titulo_vinculo v
                                        join public.acordos a on a.id = v.acordo_id
                                       where v.titulo_id = t.id and coalesce(v.ativo, true)
                                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))), 0) <= 0.005
     and not exists (select 1 from public.parcelas p
                       join public.acordos a on a.id = p.acordo_id
                      where a.aluno_id = p_aluno_id
                        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
                        and public.parcela_viva(p.status));
$function$;

-- public.caso_encerrado_operacional(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text) · md5(prosrc) fddf04c759aba2bec730cc7da24ec68a
CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._caso_encerrado_operacional_regra(
    p_aluno_id, p_caso_id, p_cpf, p_status_atual, p_status_acionamento, p_status_financeiro, p_status_jornada);
$function$;

-- public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text) · md5(prosrc) b65a36744bd71fe8837d59f378892944
CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._caso_encerrado_operacional_regra(
    null::uuid, null::uuid, p_cpf, p_status_atual, p_status_acionamento, p_status_financeiro, p_status_jornada);
$function$;

-- public.caso_encerramento_congelado(p_caso_id uuid) · md5(prosrc) 1de50b10708f8cc6ec8dd5bada214987
CREATE OR REPLACE FUNCTION public.caso_encerramento_congelado(p_caso_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.caso_encerramento_sem_saldo e
                  where e.resolvido_em is null and e.caso_id = p_caso_id);
$function$;

-- public.caso_protegido_redistribuicao(p_cpf_limpo text, p_status_acionamento text, p_nao_acionar boolean, p_status_financeiro text, p_valor_pago numeric, p_quitado_em date, p_valor_quitado numeric) · md5(prosrc) 1c00d3fb6b87d3e1a3e2ab4efa6e59ed
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

  -- Caso cujo unico saldo esta em titulo aguardando a Conferencia Prime: nao
  -- ocupa vaga (teto, reposicao, nivelamento), nao e redistribuido e nao e
  -- solto pela fidelizacao -- o responsavel fica para quando houver decisao.
  -- (o aluno e achado pelo CPF normalizado da ficha -- indice
  -- idx_alunos_cpf_normalizado; o CPF gravado no titulo pode divergir)
  if v_cpf <> '00000000000' and v_cpf <> '' and exists (
       select 1 from public.alunos al
        where lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0') = v_cpf
          and exists (select 1 from public.acordos_titulos t
                       where t.aluno_id = al.id
                         and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
          and public.caso_aguarda_confirmacao_financeira(al.id)) then
    return true;
  end if;

  -- CONFIRMACAO FINANCEIRA ABERTA (solicitacoes_confirmacao_pagamento), pelo
  -- aluno_id da solicitacao -- NAO por solicitacoes.aluno_cpf, que e nulo em
  -- 345 das 351 abertas. Os dois estados abertos protegem. Sem nome, sem
  -- aproximacao: aluno pelo CPF normalizado da ficha (mesma chave do bloco acima),
  -- solicitacao por aluno_id (texto, indexado).
  if v_cpf <> '00000000000' and v_cpf <> '' and exists (
       select 1 from public.alunos al
        where lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0') = v_cpf
          and exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                       where s.aluno_id = al.id::text
                         and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))) then
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

-- public.normalizar_status_acionamento(p_status text) · md5(prosrc) 111639f9c4227e11b2f31fc7204ed64d
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

-- public.parcela_viva(p_status text) · md5(prosrc) df5e77b776af5f1360ac0f7d0ec500f2
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

-- public.saldo_titulos_aberto(p_cpf text) · md5(prosrc) ee0d3a1f54b4785e57e0abd86157342f
CREATE OR REPLACE FUNCTION public.saldo_titulos_aberto(p_cpf text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(t.saldo_corrigido),0)
  from public.acordos_titulos t
  where t.cpf = lpad(regexp_replace(coalesce(p_cpf,''),'\D','','g'),11,'0')
    and coalesce(upper(t.situacao),'') = 'ABERTO'
    and coalesce(lower(t.status),'') <> 'quitada'
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);
$function$;

set check_function_bodies = on;
