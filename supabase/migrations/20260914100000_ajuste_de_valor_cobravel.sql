-- AJUSTE DE VALOR COBRAVEL -- primeira versao, prospectiva, sem backfill.
--
-- A REGRA. O valor recebido no bordero e historico e nunca pode ser
-- sobrescrito. Quando houver desconto, correcao ou ajuste operacional, Amanda ou
-- Fernanda definem um VALOR COBRAVEL para aquele titulo. O historico continua
-- mostrando R$ 5.000; a operacao passa a considerar R$ 4.200.
--
-- POR QUE COLUNA NOVA EM acordos_titulos, e nao reaproveitar `casos`. Os campos
-- `casos.valor_cobranca_ajustado` / `motivo_ajuste_valor` / `valor_ajustado_por`
-- / `valor_ajustado_em` existem, mas sao por CASO (por aluno) e carregam 457
-- residuos antigos. O ajuste aqui e por TITULO. Os residuos de `casos` ficam
-- intocados -- esta migration nao os le nem os escreve.
--
-- O QUE NAO MUDA: `valor_original`, `valor_em_aberto` e `saldo_corrigido`
-- seguem sendo o que sempre foram. Nenhum backfill. Nenhum titulo existente e
-- alterado por esta migration.

-- ---------------------------------------------------------------------------
-- 1. COLUNAS
-- ---------------------------------------------------------------------------
alter table public.acordos_titulos
  add column if not exists valor_cobranca_ajustado numeric,
  add column if not exists motivo_ajuste_valor     text,
  add column if not exists valor_ajustado_por      text,
  add column if not exists valor_ajustado_em       timestamptz;

comment on column public.acordos_titulos.valor_cobranca_ajustado is
  'Valor cobravel definido por Amanda/Fernanda. Quando preenchido, substitui o valor operacional do titulo. NUNCA sobrescreve valor_original/valor_em_aberto/saldo_corrigido.';
comment on column public.acordos_titulos.motivo_ajuste_valor is
  'Motivo do ajuste de valor cobravel. Obrigatorio ao definir.';
comment on column public.acordos_titulos.valor_ajustado_por is
  'E-mail de quem definiu o ajuste de valor cobravel.';
comment on column public.acordos_titulos.valor_ajustado_em is
  'Quando o ajuste de valor cobravel foi definido.';

-- Valor cobravel nao pode ser zero nem negativo. Zerar NAO e a forma de
-- cancelar cobranca -- cancelamento/FIES e outra frente. Remover o ajuste e
-- gravar NULL, pelo RPC.
alter table public.acordos_titulos
  drop constraint if exists acordos_titulos_valor_cobranca_ajustado_positivo;
alter table public.acordos_titulos
  add constraint acordos_titulos_valor_cobranca_ajustado_positivo
  check (valor_cobranca_ajustado is null or valor_cobranca_ajustado > 0)
  not valid;

-- ---------------------------------------------------------------------------
-- 2. HISTORICO -- cada alteracao, nao so o ultimo valor
-- ---------------------------------------------------------------------------
create table if not exists public.titulo_valor_ajuste_historico (
  id                   uuid primary key default gen_random_uuid(),
  titulo_id            uuid not null references public.acordos_titulos(id) on delete cascade,
  aluno_id             uuid,
  acao                 text not null check (acao in ('DEFINIR','REMOVER')),
  valor_base_anterior  numeric,
  ajuste_anterior      numeric,
  ajuste_novo          numeric,
  motivo               text,
  usuario_email        text not null,
  criado_em            timestamptz not null default now()
);

create index if not exists ix_titulo_valor_ajuste_hist_titulo
  on public.titulo_valor_ajuste_historico (titulo_id, criado_em desc);

comment on table public.titulo_valor_ajuste_historico is
  'Historico de cada definicao e remocao de valor cobravel ajustado. Remover tambem gera evento.';

alter table public.titulo_valor_ajuste_historico enable row level security;
revoke all on public.titulo_valor_ajuste_historico from public, anon;
grant select on public.titulo_valor_ajuste_historico to authenticated;

-- Leitura so para quem pode ajustar. Escrita nunca direta: so pelo RPC, que e
-- SECURITY DEFINER e roda como owner.
drop policy if exists titulo_valor_ajuste_hist_leitura on public.titulo_valor_ajuste_historico;
create policy titulo_valor_ajuste_hist_leitura
  on public.titulo_valor_ajuste_historico
  for select to authenticated
  using (public.crm_usuario_pode_ajustar_valor());

-- ---------------------------------------------------------------------------
-- 3. PORTAO -- quem pode ajustar
-- ---------------------------------------------------------------------------
-- Mesmo formato de `crm_usuario_pode_quitar_baixar`: nega o executor interno,
-- decide por papel quando nao ha JWT (cron/service_role) e, havendo JWT, quem
-- decide e a PESSOA -- inclusive dentro de SECURITY DEFINER, que e onde regra
-- de permissao costuma vazar.
--
-- Os dois e-mails sao os cadastrados no CRM: Amanda (perfil gerencia) e
-- Fernanda (perfil supervisor). `cobranca07@` e a Amanda Borges, do
-- administrativo -- outra pessoa, fora desta permissao de proposito.
create or replace function public.crm_usuario_pode_ajustar_valor()
returns boolean
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  email_logado text;
begin
  if current_user = 'reativa_responsavel_executor' then
    return false;
  end if;

  if auth.jwt() is null then
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;

  email_logado := lower(coalesce(auth.jwt() ->> 'email', ''));
  return email_logado in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br'
  );
end;
$function$;

revoke all on function public.crm_usuario_pode_ajustar_valor() from public;
grant execute on function public.crm_usuario_pode_ajustar_valor() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. ELEGIBILIDADE -- so titulo realmente cobravel
-- ---------------------------------------------------------------------------
-- Devolve NULL quando o titulo aceita ajuste, ou o codigo do bloqueio.
-- `tipo_boleto='Acordo'` fica de fora de proposito: o boleto do proprio acordo
-- nunca foi divida, e sao eles os 50 historicos que ficaram ABERTO apos
-- cancelamento. Eles nao podem entrar no saldo por causa desta frente.
create or replace function public.titulo_ajuste_valor_bloqueio(p_titulo_id uuid)
returns text
language sql
stable
set search_path to 'public'
as $function$
  select case
    when t.id is null then 'TITULO_NAO_ENCONTRADO'
    when coalesce(t.tipo_boleto,'') = 'Acordo' then 'TITULO_DE_ACORDO'
    when upper(coalesce(t.situacao,'')) = 'PAGO' then 'TITULO_PAGO'
    when upper(coalesce(t.situacao,'')) = 'CANCELADA' then 'TITULO_CANCELADO'
    when upper(coalesce(t.situacao,'')) = 'DUPLICADA' then 'TITULO_DUPLICADO'
    when upper(coalesce(t.situacao,'')) <> 'ABERTO' then 'TITULO_NAO_ABERTO'
    when lower(coalesce(t.status,'')) <> 'em_aberto' then 'TITULO_NAO_COBRAVEL'
    when t.acordo_id is not null then 'TITULO_EM_ACORDO'
    when exists (
      select 1 from public.acordo_titulo_vinculo v
      join public.acordos a on a.id = v.acordo_id
      where v.titulo_id = t.id and coalesce(v.ativo, true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
    ) then 'TITULO_EM_ACORDO_VIVO'
    when coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) <= 0 then 'TITULO_SEM_VALOR'
    else null
  end
  from public.acordos_titulos t where t.id = p_titulo_id;
$function$;

revoke all on function public.titulo_ajuste_valor_bloqueio(uuid) from public;
grant execute on function public.titulo_ajuste_valor_bloqueio(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. GUARDA DE TABELA -- operador comum nao muda estes campos por fora
-- ---------------------------------------------------------------------------
-- Esconder botao nao e protecao. Mesmo padrao de `_guard_resp_acordo`: a
-- escrita legitima vem do RPC, que liga um sinal de sessao; qualquer outra
-- rota que mexa nas 4 colunas e recusada.
create or replace function public.tg_titulo_ajuste_valor_protegido()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare v_mudou boolean;
begin
  if TG_OP = 'INSERT' then
    v_mudou := new.valor_cobranca_ajustado is not null
            or new.motivo_ajuste_valor is not null
            or new.valor_ajustado_por is not null
            or new.valor_ajustado_em is not null;
  else
    v_mudou := new.valor_cobranca_ajustado is distinct from old.valor_cobranca_ajustado
            or new.motivo_ajuste_valor     is distinct from old.motivo_ajuste_valor
            or new.valor_ajustado_por      is distinct from old.valor_ajustado_por
            or new.valor_ajustado_em       is distinct from old.valor_ajustado_em;
  end if;

  if not v_mudou then return new; end if;

  -- escrita vinda do RPC oficial
  if coalesce(current_setting('app.ajuste_valor_ok', true), 'off') = 'on' then
    return new;
  end if;

  -- backend sem pessoa: cron, service_role, manutencao
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  raise exception 'SEM_PERMISSAO_AJUSTAR_VALOR_COBRAVEL' using errcode = '42501';
end;
$function$;

drop trigger if exists trg_titulo_ajuste_valor_protegido on public.acordos_titulos;
create trigger trg_titulo_ajuste_valor_protegido
  before insert or update of valor_cobranca_ajustado, motivo_ajuste_valor, valor_ajustado_por, valor_ajustado_em
  on public.acordos_titulos
  for each row execute function public.tg_titulo_ajuste_valor_protegido();

-- ---------------------------------------------------------------------------
-- 6. RPC UNICA -- definir e remover
-- ---------------------------------------------------------------------------
-- p_valor NULL remove o ajuste. p_valor <= 0 e recusado: zerar nao e a forma de
-- cancelar cobranca.
create or replace function public.titulo_ajustar_valor_cobravel(
  p_titulo_id uuid,
  p_valor     numeric default null,
  p_motivo    text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_t         public.acordos_titulos%rowtype;
  v_bloqueio  text;
  v_base      numeric;
  v_anterior  numeric;
  v_motivo    text := nullif(btrim(coalesce(p_motivo,'')), '');
  v_acao      text := case when p_valor is null then 'REMOVER' else 'DEFINIR' end;
begin
  if not public.crm_usuario_pode_ajustar_valor() then
    raise exception 'Ajustar valor cobravel e exclusivo de Amanda e Fernanda.' using errcode = '42501';
  end if;
  if p_titulo_id is null then
    return jsonb_build_object('ok', false, 'erro', 'SEM_TITULO');
  end if;
  if p_valor is not null and p_valor <= 0 then
    return jsonb_build_object('ok', false, 'erro', 'VALOR_DEVE_SER_MAIOR_QUE_ZERO');
  end if;
  if v_acao = 'DEFINIR' and v_motivo is null then
    return jsonb_build_object('ok', false, 'erro', 'MOTIVO_OBRIGATORIO');
  end if;

  select * into v_t from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'TITULO_NAO_ENCONTRADO');
  end if;

  -- Remover so exige que exista ajuste: um titulo que ja saiu da elegibilidade
  -- (virou PAGO, por exemplo) ainda precisa poder ter o ajuste retirado.
  if v_acao = 'DEFINIR' then
    v_bloqueio := public.titulo_ajuste_valor_bloqueio(p_titulo_id);
    if v_bloqueio is not null then
      return jsonb_build_object('ok', false, 'erro', v_bloqueio);
    end if;
  elsif v_t.valor_cobranca_ajustado is null then
    return jsonb_build_object('ok', false, 'erro', 'SEM_AJUSTE_PARA_REMOVER');
  end if;

  v_base     := coalesce(v_t.saldo_corrigido, v_t.valor_em_aberto, v_t.valor_original, 0);
  v_anterior := v_t.valor_cobranca_ajustado;

  insert into public.titulo_valor_ajuste_historico
    (titulo_id, aluno_id, acao, valor_base_anterior, ajuste_anterior, ajuste_novo, motivo, usuario_email)
  values
    (p_titulo_id, v_t.aluno_id, v_acao, v_base, v_anterior, p_valor, v_motivo, v_email);

  perform set_config('app.ajuste_valor_ok', 'on', true);
  update public.acordos_titulos
     set valor_cobranca_ajustado = p_valor,
         motivo_ajuste_valor     = case when p_valor is null then null else v_motivo end,
         valor_ajustado_por      = case when p_valor is null then null else v_email end,
         valor_ajustado_em       = case when p_valor is null then null else now() end,
         atualizado_em           = now()
   where id = p_titulo_id;
  perform set_config('app.ajuste_valor_ok', 'off', true);

  if v_t.aluno_id is not null then
    begin perform public.recalcular_situacao_aluno(v_t.aluno_id, 'ajuste_valor_cobravel'); exception when others then null; end;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'AJUSTOU_VALOR_COBRAVEL', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('acao', v_acao, 'valor_base', v_base,
                             'ajuste_anterior', v_anterior, 'ajuste_novo', p_valor,
                             'motivo', v_motivo));

  return jsonb_build_object('ok', true, 'acao', v_acao, 'titulo_id', p_titulo_id,
                            'valor_base', v_base, 'ajuste_anterior', v_anterior,
                            'ajuste_novo', p_valor,
                            'valor_operacional', coalesce(p_valor, v_base));
end;
$function$;

revoke all on function public.titulo_ajustar_valor_cobravel(uuid, numeric, text) from public;
grant execute on function public.titulo_ajustar_valor_cobravel(uuid, numeric, text) to authenticated, service_role;

comment on function public.titulo_ajustar_valor_cobravel(uuid, numeric, text) is
  'Define (p_valor > 0) ou remove (p_valor NULL) o valor cobravel ajustado de um titulo. Exclusivo de Amanda e Fernanda. Nao altera valor_original, valor_em_aberto nem saldo_corrigido.';

-- ---------------------------------------------------------------------------
-- 7. LEITORES -- so os necessarios para o novo valor aparecer
-- ---------------------------------------------------------------------------
-- Tres funcoes, tres trocas cirurgicas. O corpo de cada uma e byte a byte o de
-- producao em 14/09/2026 (fotos em supabase/audits/), com UMA substituicao:
--
--   aluno_saldo_pendente_detalhe  saldo do aluno e ficha       2 ocorrencias
--   recalcular_situacao_aluno     saldo operacional do caso    2 ocorrencias
--   resumo_carteira_operador      carteira do operador         3 ocorrencias
--
-- Em todas, `valor_cobranca_ajustado` entra na FRENTE da regra atual -- a regra
-- atual continua valendo inteira quando nao ha ajuste.
--
-- OS 50 TITULOS HISTORICOS. `aluno_saldo_pendente_detalhe` e
-- `recalcular_situacao_aluno` ja excluem `tipo_boleto='Acordo'`, e
-- `resumo_carteira_operador` exclui titulo com linha em `acordo_titulo_vinculo`.
-- Alem disso, `titulo_ajuste_valor_bloqueio` recusa `tipo_boleto='Acordo'`, ou
-- seja: aqueles 50 nunca podem receber ajuste, e `coalesce(NULL, <regra atual>)`
-- devolve exatamente a regra atual. Eles nao entram no saldo por esta mudanca.
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

CREATE OR REPLACE FUNCTION public.resumo_carteira_operador(p_email text)
 RETURNS TABLE(qtd_alunos bigint, valor_em_aberto numeric, valor_a_vencer numeric, valor_vencido numeric, qtd_negociados bigint, valor_pago_mes numeric, honorario_mes numeric, proxima_meta_valor numeric, proxima_meta_pct numeric, falta_proxima_meta numeric, dias_uteis_restantes integer, precisa_por_dia numeric, no_topo boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_mes text := to_char(current_date,'YYYY-MM');
  v_fim date := (date_trunc('month',current_date) + interval '1 month' - interval '1 day')::date;
  v_m1v numeric; v_m1p numeric; v_m2v numeric; v_m2p numeric;
  v_m3v numeric; v_m3p numeric; v_m4v numeric; v_m4p numeric;
  v_hon numeric; v_pago numeric;
  v_prox_v numeric := null; v_prox_p numeric := null;
  v_dias int; v_topo boolean := false;
BEGIN
  SELECT * INTO r FROM (
    select
      count(distinct a.id) as qtd_alunos,
      coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido)), 0) as valor_em_aberto,
      coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido)) filter (where t.vencimento >= current_date), 0) as valor_a_vencer,
      coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido)) filter (where t.vencimento < current_date), 0) as valor_vencido,
      count(distinct a.id) filter (where a.status_jornada = 'ACORDO_FECHADO') as qtd_negociados
    from public.alunos a
    left join public.acordos_titulos t on t.cpf = a.cpf
      and upper(coalesce(t.situacao,''))='ABERTO' and lower(coalesce(t.status,''))<>'quitada'
      and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id=t.id)
    where a.responsavel_atual_email = p_email
      and not public.caso_encerrado_operacional(a.cpf,a.status_atual,a.status_acionamento,null::text,a.status_jornada)
      and coalesce(a.status_jornada,'') not in ('AGUARDANDO_BAIXA','BAIXA_REALIZADA')
      and coalesce(a.status_atual,'')   not in ('AGUARDANDO_BAIXA','BAIXA_REALIZADA')
  ) x;

  SELECT coalesce(sum(valor_pago),0), coalesce(sum(valor_honorario),0)
    INTO v_pago, v_hon
  FROM public.pagamentos
  WHERE lower(operador_email)=lower(p_email)
    AND to_char(data_pagamento,'YYYY-MM')=v_mes;

  SELECT m1_valor,m1_percentual,m2_valor,m2_percentual,m3_valor,m3_percentual,m4_valor,m4_percentual
    INTO v_m1v,v_m1p,v_m2v,v_m2p,v_m3v,v_m3p,v_m4v,v_m4p
  FROM public.metas_projecao WHERE mes_referencia=v_mes;
  v_m1v:=coalesce(v_m1v,0); v_m2v:=coalesce(v_m2v,0); v_m3v:=coalesce(v_m3v,0); v_m4v:=coalesce(v_m4v,0);

  -- proxima faixa nao atingida (menor limite acima do honorario atual)
  IF v_m1v>0 AND v_hon < v_m1v THEN v_prox_v:=v_m1v; v_prox_p:=v_m1p;
  ELSIF v_m2v>0 AND v_hon < v_m2v THEN v_prox_v:=v_m2v; v_prox_p:=v_m2p;
  ELSIF v_m3v>0 AND v_hon < v_m3v THEN v_prox_v:=v_m3v; v_prox_p:=v_m3p;
  ELSIF v_m4v>0 AND v_hon < v_m4v THEN v_prox_v:=v_m4v; v_prox_p:=v_m4p;
  ELSE v_topo:=true;
  END IF;

  SELECT count(*) INTO v_dias
  FROM generate_series(current_date, v_fim, interval '1 day') d
  WHERE extract(isodow FROM d) < 6;

  qtd_alunos := r.qtd_alunos; valor_em_aberto := r.valor_em_aberto;
  valor_a_vencer := r.valor_a_vencer; valor_vencido := r.valor_vencido;
  qtd_negociados := r.qtd_negociados;
  valor_pago_mes := v_pago; honorario_mes := v_hon;
  proxima_meta_valor := v_prox_v; proxima_meta_pct := v_prox_p;
  falta_proxima_meta := CASE WHEN v_prox_v IS NULL THEN 0 ELSE greatest(v_prox_v - v_hon, 0) END;
  dias_uteis_restantes := v_dias;
  precisa_por_dia := CASE WHEN v_prox_v IS NULL OR v_dias<=0 THEN 0
                         ELSE round(greatest(v_prox_v - v_hon,0)/v_dias, 2) END;
  no_topo := v_topo;
  RETURN NEXT;
END;
$function$;
