-- ALINHAMENTO COM PRODUCAO, 2026-10-26, para a bancada do encerramento sem saldo.
--
-- A fixture do grupo A e de 18/09 e a cadeia de migrations do repositorio nao
-- fecha ate hoje (a de 20261007143000 exige `origem_encerramento`, coluna que
-- entrou por outra migration). Em vez de adivinhar a cadeia, este arquivo traz o
-- texto EXATO de `pg_get_functiondef` das tres funcoes que divergiam, lido de
-- producao em 26/10/2026. O teste confere md5(prosrc) das NOVE funcoes do
-- contrato: se a transcricao estiver errada, o teste reprova.
--
-- NAO REAPLICAVEL EM PRODUCAO. E fixture de teste.

-- `casos_reabrir_com_divida` le esta tabela (TRAVA NOVA 2). A fixture de 18/09
-- nao a tem.
create table if not exists public.cobranca_nao_reabrir (
  cpf        text primary key,
  motivo     text,
  criado_por text,
  criado_em  timestamptz not null default now()
);

-- `aluno_saldo_pendente_detalhe` chama esta funcao; a fixture de 18/09 nao a tem.
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
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- status_acionamento fala do ACIONAMENTO. 'CANCELADO' aqui e acordo
  -- cancelado, nao cobranca cancelada -- e nao tira ninguem da fila.
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- + ANTECIPACAO SEMESTRE (07/10/2026). Entra pelo ramo condicional de propo-
  -- sito: `normalizar_status_acionamento` troca '_' por ' ', por isso sem under-
  -- score aqui.
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO','ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.casos_reabrir_com_divida(p_limite integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare
  v_bloq text[] := array['JURIDICO','CANCELAMENTO COBRANCA','SUSPENSAO COBRANCA',
                         'SUSPENSAO DE COBRANCA','CANCELADO'];
  -- status_acionamento: 'CANCELADO' aqui e acordo cancelado. Nao bloqueia.
  v_bloq_acion text[] := array['JURIDICO','CANCELAMENTO COBRANCA','SUSPENSAO COBRANCA',
                               'SUSPENSAO DE COBRANCA'];
  v_n integer := 0;
  v_pulados integer := 0;
  v_falhas integer := 0;
  r record;
begin
  for r in
    select c.id, c.aluno_id, c.status_atual as st_ant
      from public.casos c
     where c.aluno_id is not null
       and (coalesce(c.encerrado_operacional, false)
            or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                                 c.status_financeiro, c.status_jornada))
       and not exists (
         select 1 from public.casos c2
          where c2.aluno_id = c.aluno_id and c2.id <> c.id
            and not coalesce(c2.encerrado_operacional, false))
       -- TRAVA NOVA 1. Decisao explicita de nao acionar, gravada no caso.
       and not coalesce(c.nao_acionar, false)
       -- TRAVA NOVA 2. Decisao explicita de nao cobrar, gravada pela gestao.
       and not exists (
         select 1 from public.cobranca_nao_reabrir nr
          where nr.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D', '', 'g'), 11, '0')
            and regexp_replace(coalesce(c.cpf_limpo,''), '\D', '', 'g') <> '')
       and public.normalizar_status_acionamento(coalesce(c.status_atual,''))       <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_acionamento,'')) <> all(v_bloq_acion)
       and public.normalizar_status_acionamento(coalesce(c.status_financeiro,''))  <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_jornada,''))     <> all(v_bloq)
       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'
       and not exists (select 1 from public.alunos al
                        where al.id = c.aluno_id
                          and upper(coalesce(al.status_atual,'')) ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO')
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric > 0.005
     limit coalesce(p_limite, 100000)
  loop
    if exists (
      select 1 from public.casos c2
       where c2.aluno_id = r.aluno_id
         and c2.id <> r.id
         and not coalesce(c2.encerrado_operacional, false)
         and public.caso_encerrado_operacional(c2.cpf, c2.status_atual, c2.status_acionamento,
                                               c2.status_financeiro, c2.status_jornada) = false
    ) then
      v_pulados := v_pulados + 1;
      continue;
    end if;

    begin
      update public.casos
         set status_atual = 'Em cobrança',
             status_acionamento = null,
             status_jornada = 'Em cobrança',
             status_financeiro = case
               when public.normalizar_status_acionamento(coalesce(status_financeiro,''))
                    in ('QUITADO','PAGO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                        'SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO')
                 then null
               else status_financeiro end,
             encerrado_operacional = false,
             caso_atualizado_por = 'sistema_reabrir_com_divida',
             caso_atualizado_em = now()
       where id = r.id;

      update public.alunos
         set status_atual = 'Em cobrança',
             status_jornada = 'Em cobrança',
             status_acionamento = null
       where id = r.aluno_id
         and upper(coalesce(status_atual,'')) !~ 'JURIDICO|CANCELAMENTO|SUSPENSAO';

      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em)
      values (r.aluno_id::text, 'REABERTURA_DIVIDA_NOVA',
              'Caso estava fora da base como "' || coalesce(r.st_ant,'(sem status)')
              || '" mas voltou a ter saldo em aberto. Devolvido para a fila.',
              coalesce(r.st_ant,'(sem)'), 'Em cobrança',
              'Sistema', 'sistema_reabrir_com_divida', now());

      perform public.recalcular_situacao_aluno(r.aluno_id, 'reabrir_com_divida');
      v_n := v_n + 1;
    exception when others then
      v_falhas := v_falhas + 1;
      raise warning 'casos_reabrir_com_divida: caso % do aluno % nao foi reaberto e foi pulado: %',
        r.id, r.aluno_id, sqlerrm;
    end;
  end loop;

  if v_pulados > 0 or v_falhas > 0 then
    raise warning 'casos_reabrir_com_divida: % reaberto(s), % pulado(s) por ja terem caso aberto, % com erro',
      v_n, v_pulados, v_falhas;
  end if;

  return v_n;
end;
$function$
;
