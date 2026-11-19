-- Corpos REAIS lidos de producao (pg_get_functiondef), somente leitura, em 18/11/2026.
-- Projeto ahattpqrjmhkzsmnbdzs. md5 = md5(pg_get_functiondef(oid)).
--
--   aluno_elegibilidade_cobranca(uuid)  md5 d87c10aac1d733bbf2bdd4683265f3e3  DEFINER owner postgres  ACL postgres,service_role
--   usuario_e_gestao()                  md5 af3d391f4234e6a352585777897568e4  DEFINER owner postgres  ACL postgres,authenticated,service_role,reativa_responsavel_executor
--   saldo_cobravel_aluno(uuid)          md5 e2c732946181aa7ad258798503dd7209  DEFINER owner postgres  ACL postgres,service_role
--   aluno_bloqueio_administrativo(uuid) md5 8ef9b6b7454d78af0e22f344362506c8  DEFINER owner postgres  ACL postgres,service_role
--   aluno_pendencia_operacional(uuid)   md5 f1389aa0ce8e017f7ffec5297925b909  DEFINER owner postgres  ACL postgres,service_role
--   normalizar_status_acionamento(text) md5 5e37ad78f61f9d1853819de6ce18b65c  INVOKER owner postgres  ACL postgres,authenticated,service_role
--
-- DEPENDENCIAS NAO VERSIONADAS NO REPOSITORIO: as TABELAS abaixo sao stubs de
-- estrutura, criados so com as colunas que as funcoes lidas referenciam. Os
-- CORPOS das funcoes (abaixo) sao os lidos de producao. parcela_viva (md5
-- 21d1dd16ff680c8bf0d13523d5780202) foi lida de producao via pg_get_functiondef
-- em 18/11/2026; a versao da migration 20261007211500 e a mesma no corpo.
-- Este arquivo NAO e prova de elegibilidade de producao: os dados das tabelas sao sinteticos.

create extension if not exists unaccent;

-- ---------------------------------------------------------------- stubs de estrutura
create table if not exists alunos (
  id uuid primary key, cpf text, situacao_operacional text, status_atual text,
  status_acionamento text, status_jornada text, responsavel_atual_email text
);
create table if not exists casos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid not null,
  operador_email text, encerrado_operacional boolean default false,
  nao_acionar boolean default false, status_atual text, status_financeiro text, status_jornada text
);
create table if not exists acordos_titulos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid, importacao_id uuid,
  situacao text, status text, tipo_boleto text, vencimento date,
  valor_original numeric, saldo_corrigido numeric, valor_cobranca_ajustado numeric,
  valor_em_aberto numeric
);
create table if not exists acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid, status text);
create table if not exists acordo_titulo_vinculo (titulo_id uuid, acordo_id uuid, ativo boolean default true);
create table if not exists parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid, valor numeric, status text);
create table if not exists baixas_pagamento (id bigserial primary key, aluno_id text, status_baixa text);
create table if not exists solicitacoes_confirmacao_pagamento (id bigserial primary key, aluno_id text, status text);
create table if not exists usuarios (email text primary key, ativo boolean not null);

create type elegibilidade_cobranca as (
  aluno_id uuid, avaliado_em timestamptz, suspenso boolean, cancelado boolean, juridico boolean,
  nao_acionar boolean, encerrado_administrativamente boolean, possui_saldo_cobravel boolean,
  aguardando_conferencia_prime boolean, saldo_zero_definitivo boolean,
  permanece_em_fila_especializada boolean, bloqueio_outra_ficha boolean,
  motivo_principal text, motivos_secundarios text[], elegivel boolean
);

-- parcela_viva: corpo REAL lido de producao em 18/11/2026 (md5 21d1dd16ff680c8bf0d13523d5780202,
-- INVOKER, ACL PUBLIC/postgres/authenticated/service_role).
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

-- ---------------------------------------------------------------- corpos reais
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

CREATE OR REPLACE FUNCTION public.aluno_bloqueio_administrativo(p_aluno_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_susp boolean; v_canc boolean; v_jur boolean; v_nao boolean;
  n1 text; n2 text; n3 text;
  susp_set text[] := array['SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  canc_set text[] := array['CANCELADO','CANCELAMENTO COBRANCA'];
begin
  select public.normalizar_status_acionamento(al.status_atual),
         public.normalizar_status_acionamento(al.status_acionamento),
         public.normalizar_status_acionamento(al.status_jornada)
    into n1, n2, n3
    from public.alunos al where al.id = p_aluno_id;
  if not found then return 'ALUNO_INEXISTENTE'; end if;

  select bool_or(public.normalizar_status_acionamento(c.status_atual)      = any(susp_set)
              or public.normalizar_status_acionamento(c.status_financeiro) = any(susp_set)
              or public.normalizar_status_acionamento(c.status_jornada)    = any(susp_set)),
         bool_or(public.normalizar_status_acionamento(c.status_atual)      = any(canc_set)
              or public.normalizar_status_acionamento(c.status_financeiro) = 'CANCELAMENTO COBRANCA'
              or public.normalizar_status_acionamento(c.status_jornada)    = any(canc_set)),
         bool_or(public.normalizar_status_acionamento(c.status_atual)      = 'JURIDICO'
              or public.normalizar_status_acionamento(c.status_financeiro) = 'JURIDICO'
              or public.normalizar_status_acionamento(c.status_jornada)    = 'JURIDICO'),
         bool_or(coalesce(c.nao_acionar,false))
    into v_susp, v_canc, v_jur, v_nao
    from public.casos c where c.aluno_id = p_aluno_id;

  if n1 = any(susp_set) or n2 = any(susp_set) or n3 = any(susp_set) or coalesce(v_susp,false)
     then return 'SUSPENSAO_COBRANCA'; end if;
  if n1 = any(canc_set) or n2 = 'CANCELAMENTO COBRANCA' or n3 = any(canc_set) or coalesce(v_canc,false)
     then return 'CANCELAMENTO_COBRANCA'; end if;
  if n1 = 'JURIDICO' or n2 = 'JURIDICO' or n3 = 'JURIDICO' or coalesce(v_jur,false)
     then return 'JURIDICO'; end if;
  if coalesce(v_nao,false) then return 'NAO_ACIONAR_EXPLICITO'; end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.aluno_pendencia_operacional(p_aluno_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.acordos_titulos t
                  WHERE t.aluno_id = p_aluno_id
                    AND upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
         THEN 'CONFERENCIA_PRIME'
    WHEN EXISTS (SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
                  WHERE s.aluno_id = p_aluno_id::text
                    AND s.status IN ('AGUARDANDO_CONFIRMACAO',
                                     'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))
         THEN 'CONFIRMACAO_PAGAMENTO'
    WHEN EXISTS (SELECT 1 FROM public.baixas_pagamento b
                  WHERE b.aluno_id = p_aluno_id::text
                    AND upper(coalesce(b.status_baixa,'')) IN ('AGUARDANDO_BAIXA','PENDENTE'))
         THEN 'BAIXA_PENDENTE'
    WHEN EXISTS (SELECT 1 FROM public.acordos a
                  WHERE a.aluno_id = p_aluno_id
                    AND upper(coalesce(a.status,'')) = 'ATIVO')
         THEN 'ACORDO_ATIVO'
    ELSE NULL END;
$function$;

CREATE OR REPLACE FUNCTION public.saldo_cobravel_aluno(p_aluno_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN public.aluno_bloqueio_administrativo(p_aluno_id) = 'SUSPENSAO_COBRANCA'
      THEN 0::numeric
    ELSE round(
      coalesce((
        SELECT sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0))
          FROM public.acordos_titulos t
         WHERE t.aluno_id = p_aluno_id
           AND upper(coalesce(t.situacao,'')) IN ('ABERTO','NEGOCIADO')
           AND coalesce(lower(t.status),'') <> 'quitada'
           AND coalesce(t.tipo_boleto,'') <> 'Acordo'
           AND NOT EXISTS (
             SELECT 1 FROM public.acordo_titulo_vinculo v
               JOIN public.acordos a ON a.id = v.acordo_id
              WHERE v.titulo_id = t.id AND coalesce(v.ativo, true)
                AND upper(coalesce(a.status,'')) NOT IN ('CANCELADO','CANCELADA'))
      ), 0)
      + coalesce((
        SELECT sum(coalesce(p.valor,0))
          FROM public.parcelas p
          JOIN public.acordos a ON a.id = p.acordo_id
         WHERE a.aluno_id = p_aluno_id
           AND upper(coalesce(a.status,'')) = 'ATIVO'
           AND public.parcela_viva(p.status)
           AND upper(coalesce(p.status,'')) <> 'RENEGOCIADA'
      ), 0)
    , 2) END;
$function$;

CREATE OR REPLACE FUNCTION public.aluno_elegibilidade_cobranca(p_aluno_id uuid)
 RETURNS elegibilidade_cobranca
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r public.elegibilidade_cobranca;
  v_saldo numeric;
  v_pend  text;
  v_bloq  text;
  v_cpf_norm text;
  v_em_fila int := 0;
  v_nao boolean := false;
  v_conf boolean := false;
  v_sec text[] := '{}'::text[];
begin
  r.aluno_id    := p_aluno_id;
  r.avaliado_em := now();

  select nullif(lpad(regexp_replace(coalesce(al.cpf,''),'\D','','g'),11,'0'),'00000000000'),
         (public.normalizar_status_acionamento(al.situacao_operacional) = 'AGUARDANDO CONFIRMACAO')
    into v_cpf_norm, v_conf
    from public.alunos al where al.id = p_aluno_id;
  if not found then
    r.elegivel := false;
    r.motivo_principal := 'ALUNO_INEXISTENTE';
    return r;
  end if;

  select count(*) filter (where not coalesce(c.encerrado_operacional,false)),
         bool_or(coalesce(c.nao_acionar,false))
    into v_em_fila, v_nao
    from public.casos c where c.aluno_id = p_aluno_id;

  v_saldo := public.saldo_cobravel_aluno(p_aluno_id);
  v_pend  := public.aluno_pendencia_operacional(p_aluno_id);
  v_bloq  := public.aluno_bloqueio_administrativo(p_aluno_id);

  v_conf := coalesce(v_conf,false) or exists (
    select 1 from public.solicitacoes_confirmacao_pagamento s
     where s.aluno_id = p_aluno_id::text
       and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'));

  r.suspenso    := (v_bloq = 'SUSPENSAO_COBRANCA');
  r.cancelado   := (v_bloq = 'CANCELAMENTO_COBRANCA');
  r.juridico    := (v_bloq = 'JURIDICO');
  r.nao_acionar := coalesce(v_nao,false);
  r.encerrado_administrativamente := (v_bloq in ('SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','JURIDICO'));

  r.possui_saldo_cobravel        := (v_saldo > 0.005);
  r.aguardando_conferencia_prime := (v_pend = 'CONFERENCIA_PRIME');
  r.saldo_zero_definitivo        := (v_saldo <= 0.005 and v_pend is null);
  r.permanece_em_fila_especializada := (v_saldo <= 0.005 and v_pend is not null);

  r.bloqueio_outra_ficha := (
    v_cpf_norm is not null and v_em_fila = 0
    and exists (select 1 from public.alunos a2
                  join public.casos c2 on c2.aluno_id = a2.id
                                      and not coalesce(c2.encerrado_operacional,false)
                 where a2.id <> p_aluno_id
                   and nullif(lpad(regexp_replace(coalesce(a2.cpf,''),'\D','','g'),11,'0'),'00000000000') = v_cpf_norm));

  r.motivo_principal := case
    when r.suspenso                        then 'SUSPENSAO_COBRANCA'
    when r.cancelado                       then 'CANCELAMENTO_COBRANCA'
    when r.juridico                        then 'JURIDICO'
    when r.nao_acionar                     then 'NAO_ACIONAR_EXPLICITO'
    when v_conf                            then 'CONFIRMACAO_PAGAMENTO_PENDENTE'
    when r.permanece_em_fila_especializada then 'SEM_SALDO_ACIONAVEL_TEMPORARIO'
    when r.saldo_zero_definitivo           then 'SALDO_ZERO_DEFINITIVO'
    when r.bloqueio_outra_ficha            then 'CPF_COBRADO_POR_OUTRA_FICHA'
    else null end;

  if r.suspenso    then v_sec := array_append(v_sec, 'SUSPENSAO_COBRANCA'); end if;
  if r.cancelado   then v_sec := array_append(v_sec, 'CANCELAMENTO_COBRANCA'); end if;
  if r.juridico    then v_sec := array_append(v_sec, 'JURIDICO'); end if;
  if r.nao_acionar then v_sec := array_append(v_sec, 'NAO_ACIONAR_EXPLICITO'); end if;
  if v_conf        then v_sec := array_append(v_sec, 'CONFIRMACAO_PAGAMENTO_PENDENTE'); end if;
  if r.permanece_em_fila_especializada
     then v_sec := array_append(v_sec, 'SEM_SALDO_ACIONAVEL_TEMPORARIO:' || v_pend); end if;
  if r.saldo_zero_definitivo then v_sec := array_append(v_sec, 'SALDO_ZERO_DEFINITIVO'); end if;
  if r.bloqueio_outra_ficha  then v_sec := array_append(v_sec, 'CPF_COBRADO_POR_OUTRA_FICHA'); end if;
  r.motivos_secundarios := nullif(v_sec, '{}'::text[]);

  r.elegivel := (r.motivo_principal is null);
  return r;
end;
$function$;
