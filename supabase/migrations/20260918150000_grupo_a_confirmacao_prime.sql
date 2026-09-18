-- GRUPO A: SUSPENSAO POR TITULO + CONFERENCIA PRIME
--
-- Regra fechada pela gestao em 18/09/2026:
--   * o portador 195 e informacao por CPF e NAO prova divida de um titulo;
--   * a data de liquidacao da Prime sozinha NAO prova pagamento;
--   * so o GRUPO A (liquidacao real por data + portador 195 no proprio boleto +
--     CPF coerente + sem conflito + corroboracao independente -- pagamento
--     ReATIVA no dia ou valor pago acima do bruto) interrompe a cobranca do
--     titulo e vai para confirmacao humana. Premissa 6 segue valendo: a baixa
--     financeira depende de decisao humana registrada.
--
-- O QUE ESTA MIGRATION FAZ, NA ORDEM APROVADA:
--   1. TRAVAS -- um estado de titulo EM_CONFIRMACAO (status em_confirmacao)
--      que tira SO o titulo da cobranca: nao marca PAGO, nao zera valor, nao
--      quita o aluno, nao encerra o caso, nao usa nao_acionar, nao afeta as
--      outras mensalidades. Caso cujo unico saldo esta em confirmacao nao
--      ocupa vaga, nao e redistribuido e nao perde o responsavel.
--   2. FILA HUMANA E DECISOES -- reaproveita a Conferencia Prime
--      (prime_conferencia_decisao, _fila, _confirmar, _rejeitar, _baixar) e a
--      liga a regra do grupo A. Confirmar A1 = baixa oficial com origem
--      registrada; A2 que o acordo cobre = vinculo ao acordo existente;
--      rejeitar = o titulo volta a ser cobrado.
--   3. A SUSPENSAO NAO RODA AQUI. Ela e a funcao
--      prime_conferencia_detectar_grupo_a(p_aplicar), chamada a parte.
--      Nenhum titulo entra em EM_CONFIRMACAO por esta migration.

begin;

-- ===== 0. ESTRUTURA =========================================================

-- A decisao da Conferencia Prime ganha o que a fila precisa mostrar e o que a
-- auditoria precisa guardar. PENDENTE = titulo em EM_CONFIRMACAO aguardando
-- decisao; VINCULADO = A2 confirmado por vinculo ao acordo.
alter table public.prime_conferencia_decisao
  add column if not exists motivo_entrada       text,
  add column if not exists aluno_id             uuid,
  add column if not exists cpf                  text,
  add column if not exists documento            text,
  add column if not exists valor                numeric,
  add column if not exists evidencia            jsonb,
  add column if not exists evidencia_chave      text,
  add column if not exists corroboracao         text,
  add column if not exists subgrupo             text,
  add column if not exists acordo_id            uuid,
  add column if not exists acordo_numero        text,
  add column if not exists revisao_obrigatoria  boolean not null default false,
  add column if not exists operador_no_momento  text,
  add column if not exists detectado_em         timestamptz,
  add column if not exists situacao_anterior    text,
  add column if not exists status_anterior      text;

-- PENDENTE ainda nao foi decidido: decidido_em so existe depois da decisao.
alter table public.prime_conferencia_decisao alter column decidido_em drop not null;

alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_decisao_check;
alter table public.prime_conferencia_decisao add constraint prime_conferencia_decisao_decisao_check
  check (decisao = any (array['PENDENTE','CONFIRMADO','VINCULADO','REJEITADO']));

alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_subgrupo_check;
alter table public.prime_conferencia_decisao add constraint prime_conferencia_decisao_subgrupo_check
  check (subgrupo is null or subgrupo = any (array['A1','A2_COBRE','A2_NAO_COBRE','A2_INCONCLUSIVO']));

create index if not exists ix_prime_conferencia_decisao_pendente
  on public.prime_conferencia_decisao (aluno_id) where decisao = 'PENDENTE';

-- Indices minusculos (so os titulos em confirmacao): a regra de vaga e
-- consultada dentro do gatilho de teto, caso a caso -- tem de ser barata.
create index if not exists ix_acordos_titulos_em_confirmacao_aluno
  on public.acordos_titulos (aluno_id) where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';

-- O caso que so deve titulo aguardando a Conferencia Prime nao tem divida
-- exigivel hoje: nao ocupa vaga, nao e redistribuido, nao perde o responsavel.
-- "So deve isso" = nenhuma mensalidade exigivel (a mesma regra de
-- aluno_saldo_pendente_detalhe) e nenhuma parcela de acordo em aberto.
create or replace function public.caso_aguarda_confirmacao_financeira(p_aluno_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
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
                        and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO'));
$function$;

-- ===== 1. TRAVAS DE SEGURANCA ===============================================

-- 1a. situacao EM_CONFIRMACAO sempre com status em_confirmacao
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
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$function$;

-- 1b. EM_CONFIRMACAO so entra e so sai por decisao da Conferencia Prime.
-- Qualquer outro caminho que tente reabrir o titulo -- reimportacao do bordero,
-- titulo_reavaliar, edicao manual -- e COAGIDO de volta, sem derrubar a operacao
-- que o chamou (a mesma escolha de titulo_liquidado_na_origem_e_terminal). A
-- chave e transacional (set_config ... true): so as funcoes da conferencia a
-- ligam, dentro da propria transacao, e ela morre com a transacao.
create or replace function public._titulo_em_confirmacao_protegido()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_oficial boolean := coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on';
  v_novo    text := upper(coalesce(new.situacao,''));
  v_velho   text := case when tg_op = 'UPDATE' then upper(coalesce(old.situacao,'')) else '' end;
begin
  if v_oficial then
    return new;
  end if;

  if v_novo = 'EM_CONFIRMACAO' and v_velho <> 'EM_CONFIRMACAO' then
    raise exception 'EM_CONFIRMACAO_SO_PELA_CONFERENCIA_PRIME: o titulo % so entra em confirmacao pela deteccao do grupo A.',
      coalesce(new.documento, '?') using errcode = 'P0001';
  end if;

  if v_velho = 'EM_CONFIRMACAO'
     and (v_novo <> 'EM_CONFIRMACAO'
          or lower(coalesce(new.status,'')) <> lower(coalesce(old.status,''))
          or new.aluno_id is distinct from old.aluno_id
          or new.acordo_id is distinct from old.acordo_id) then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('sistema', 'TITULO_EM_CONFIRMACAO_ALTERACAO_RECUSADA', 'acordos_titulos', old.id,
            jsonb_build_object('documento', old.documento,
                               'tentou_situacao', new.situacao, 'tentou_status', new.status,
                               'tentou_aluno_id', new.aluno_id, 'tentou_acordo_id', new.acordo_id));
    new.situacao  := old.situacao;
    new.status    := old.status;
    new.aluno_id  := old.aluno_id;
    new.acordo_id := old.acordo_id;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_titulo_em_confirmacao_protegido on public.acordos_titulos;
create trigger trg_titulo_em_confirmacao_protegido
  before insert or update on public.acordos_titulos
  for each row execute function public._titulo_em_confirmacao_protegido();

-- 1c. entrar em confirmacao nao dispara a quitacao automatica do aluno
CREATE OR REPLACE FUNCTION public._trg_auto_quitar_titulo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

-- 1d. aluno com titulo em confirmacao nunca e quitado automaticamente
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

  -- Titulo aguardando a Conferencia Prime nao e divida quitada: o aluno
  -- espera a decisao, nao vira QUITADO.
  if exists (select 1 from public.acordos_titulos
              where aluno_id = v_aluno and upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') then
    return;
  end if;

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

-- 1e. saldo pendente: em confirmacao nao entra no total, mas e pendencia
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
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

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

-- 1f. a reavaliacao horaria nao fecha caso com titulo em confirmacao
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
       -- titulo aguardando a Conferencia Prime: o caso espera a decisao aberto
       and not exists (select 1 from public.acordos_titulos tc
                        where tc.aluno_id = c.aluno_id
                          and upper(coalesce(tc.situacao,'')) = 'EM_CONFIRMACAO')
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

-- 1g. o encerramento de zerados nao encerra quem tem titulo em confirmacao
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
     -- titulo aguardando a Conferencia Prime: o aluno nao esta zerado,
     -- esta esperando decisao -- o caso fica aberto, com o responsavel
     and not exists (select 1 from public.acordos_titulos tc
                      where tc.aluno_id = z.aluno_id
                        and upper(coalesce(tc.situacao,'')) = 'EM_CONFIRMACAO')
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

-- 1h. saldo zero so por titulo em confirmacao vira AGUARDANDO_CONFIRMACAO, nunca QUITADO
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

-- 1i. a trava terminal da liquidacao oficial coage em vez de dar erro (registro_id e uuid)
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
  values ('sistema', 'TITULO_LIQUIDADO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,
          jsonb_build_object('documento', old.documento, 'tentou', v_tentou,
                             'origem_liquidacao_ref', old.origem_liquidacao_ref,
                             'acordo_id_novo', new.acordo_id));
  return new;
end;
$function$;

-- ===== 1-bis. CARTEIRA: SEM VAGA, SEM REDISTRIBUICAO, RESPONSAVEL PRESERVADO ====

-- protegido = nao conta no teto nem na reposicao, nao move, nao solta pela fidelizacao
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

-- contagem da carteira ativa (KPI e assumir_caso_livre_aluno)
CREATE OR REPLACE FUNCTION public.contar_carteira_ativa(p_email text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::int FROM public.casos c
   WHERE (p_email IS NULL OR c.operador_email = p_email)
     AND (p_email IS NOT NULL OR c.operador_email IS NOT NULL)
     AND c.encerrado_operacional = false
     -- caso que so espera a Conferencia Prime nao ocupa vaga
     AND NOT public.caso_aguarda_confirmacao_financeira(c.aluno_id);
$function$;

-- o limite de 500 ao assumir nao conta caso que so espera a conferencia
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
  v_count := (select count(*) from public.casos where operador_email = v_email
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id));
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
  if (select count(*) from public.casos where operador_email = v_email
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id)) > 500 then
    raise exception 'ROLLBACK: operador ficaria com mais de 500 casos.';
  end if;
  return query select true, 'Atendimento assumido. Acione dentro do prazo operacional para iniciar a fidelizacao de 10 dias.', v_liberado;
end;
$function$;

-- o nivelamento progressivo nao tira nem entrega caso que so espera a conferencia
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
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_aguarda_confirmacao_financeira(aluno_id) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto DESC NULLS LAST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND NOT public.caso_aguarda_confirmacao_financeira(aluno_id) AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
        IF v_pool_id IS NOT NULL THEN
          UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_caso.id;
          UPDATE public.casos SET operador_email = v_op.operador_email, caso_atualizado_por = 'job_nivelamento_progressivo', caso_atualizado_em = now() WHERE id = v_pool_id;
          v_total := v_total + 1;
        END IF;
      END LOOP;
    ELSIF v_op.media < v_media_alvo - v_margem THEN
      FOR v_caso IN SELECT id FROM public.casos WHERE operador_email = v_op.operador_email AND quitado_em IS NULL AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND coalesce(status_acionamento,'') NOT ILIKE '%ACORDO%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_dentro_prazo_fidelizacao(data_ultimo_acionamento) AND NOT public.caso_aguarda_confirmacao_financeira(aluno_id) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_max_trocas_por_operador LOOP
        SELECT id INTO v_pool_id FROM public.casos WHERE operador_email IS NULL AND aluno_id IS NOT NULL AND quitado_em IS NULL AND NOT public.caso_aguarda_confirmacao_financeira(aluno_id) AND coalesce(status_acionamento,'') NOT ILIKE '%CANCEL%' AND coalesce(status_acionamento,'') NOT ILIKE '%JURIDIC%' AND NOT internal.matricula_em_fidelizacao(aluno_id, matricula) AND NOT public.caso_encerrado_operacional(cpf_limpo, status_atual, status_acionamento, status_financeiro, status_jornada) ORDER BY abs(coalesce(total_em_aberto,0) - v_media_alvo) ASC LIMIT 1;
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

-- o reforco do teto de 500 nao conta caso que so espera a conferencia
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
      -- caso que so espera a Conferencia Prime nao ocupa vaga
      AND NOT public.caso_aguarda_confirmacao_financeira(aluno_id)
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

-- ===== 2. FILA HUMANA E DECISOES (CONFERENCIA PRIME) =========================

-- A REGRA DO GRUPO A, num lugar so. Usada na deteccao e de novo no momento da
-- decisao (a evidencia e reconferida, nao a da deteccao). Criterios fechados:
--   liquidacao real  : liquidado_em > vencimento + 30 e >= importacao no CRM
--   nao e artefato   : liquidado_em <> dia da importacao
--   portador         : o PROPRIO boleto esta no 195 (nao o CPF)
--   CPF coerente     : CPF do boleto = CPF da ficha
--   sem conflito     : 2a coleta nao traz outra data real; nenhum acordo do
--                      aluno cancelado na janela sem acordo vivo junto
--   corroboracao     : pagamento ReATIVA do mesmo CPF no dia (+-1) OU
--                      valor pago na Prime acima do valor bruto
-- A2 (acordo vivo criado +-15 dias da liquidacao, sem vinculo) e classificado
-- pelo elo ja provado aluno + data de liquidacao = um acordo: acordo unico,
-- um so grupo de data, razao valor do acordo / lote do dia entre 0,25 e 1,60.
create or replace function public.prime_grupo_a_candidatos(p_titulo_ids uuid[] default null)
 returns table(titulo_id uuid, aluno_id uuid, cpf text, documento text, valor numeric, vencimento date,
               importado_em date, liquidado_em date, portador integer, valor_bruto numeric, valor_pago numeric,
               liquidado_em_2a_coleta date, corroboracao text, subgrupo text, acordo_id uuid, acordo_numero text,
               razao numeric, revisao_obrigatoria boolean, evidencia jsonb, evidencia_chave text)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '300s'
as $function$
  with alvo_aluno as (
    select distinct t.aluno_id from public.acordos_titulos t
     where p_titulo_ids is not null and t.id = any(p_titulo_ids) and t.aluno_id is not null
  ),
  cob as materialized (
    select t.id, t.aluno_id, t.documento, t.vencimento, t.created_at::date as imp,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v,
           lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') as cpf_a
      from public.acordos_titulos t
      join public.alunos al on al.id = t.aluno_id
     where coalesce(t.tipo_boleto,'') <> 'Acordo'
       and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
       and coalesce(lower(t.status),'') <> 'quitada'
       and (p_titulo_ids is null or t.aluno_id in (select aa.aluno_id from alvo_aluno aa))
       and not exists (select 1 from public.acordo_titulo_vinculo v
                         join public.acordos ac on ac.id = v.acordo_id
                        where v.titulo_id = t.id and coalesce(v.ativo, true)
                          and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA'))
  ),
  ex as (
    select distinct on (e.boleto) e.boleto, e.liquidado_em, e.portador, e.valor_bruto, e.valor_pago,
           lpad(regexp_replace(coalesce(e.cpf,''), '\D', '', 'g'), 11, '0') as cpf_p
      from public.prime_extrato e
     where e.boleto in (select c.documento from cob c) and e.liquidado_em is not null
     order by e.boleto, e.coletado_em desc
  ),
  f as materialized (
    select c.*, ex.liquidado_em as liq, ex.portador as port, ex.valor_bruto as b, ex.valor_pago as p, ex.cpf_p,
      (select max(ts.liquidado_em) from public.prime_titulo_semestre ts where ts.boleto = c.documento) as liq_s,
      exists (select 1 from public.pagamentos pg
               where lpad(regexp_replace(coalesce(pg.cpf,''), '\D', '', 'g'), 11, '0') = c.cpf_a
                 and pg.data_pagamento between ex.liquidado_em - 1 and ex.liquidado_em + 1) as pag,
      exists (select 1 from public.acordos ac
               where ac.aluno_id = c.aluno_id and upper(coalesce(ac.status,'')) in ('ATIVO','QUITADO')
                 and ac.criado_em::date between ex.liquidado_em - 15 and ex.liquidado_em + 15) as ac_vivo,
      exists (select 1 from public.acordos ac
               where ac.aluno_id = c.aluno_id and upper(coalesce(ac.status,'')) = 'CANCELADO'
                 and ac.criado_em::date between ex.liquidado_em - 15 and ex.liquidado_em + 15) as ac_canc
      from cob c join ex on ex.boleto = c.documento
     where ex.liquidado_em > c.vencimento + 30
       and ex.liquidado_em >= c.imp
  ),
  a as materialized (
    select f.* from f
     where f.port = 195
       and f.cpf_p = f.cpf_a
       and f.liq <> f.imp
       and not (f.liq_s is not null and f.liq_s <> f.liq and f.liq_s > f.vencimento + 30)
       and not (f.ac_canc and not f.ac_vivo)
       and (f.pag or f.p > f.b + 0.005)
  ),
  -- lote do dia: todas as mensalidades do aluno liquidadas na Prime na mesma data
  lote as (
    select x.aluno_id, x.liq, sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) as soma
      from (select distinct a.aluno_id, a.liq from a where a.ac_vivo) x
      join public.acordos_titulos t on t.aluno_id = x.aluno_id and coalesce(t.tipo_boleto,'') <> 'Acordo'
      join lateral (select e.liquidado_em from public.prime_extrato e
                     where e.boleto = t.documento and e.liquidado_em is not null
                     order by e.coletado_em desc limit 1) e2 on e2.liquidado_em = x.liq
     group by 1, 2
  ),
  k as (
    select a.*,
      (select count(*) from public.acordos ac
        where ac.aluno_id = a.aluno_id and upper(coalesce(ac.status,'')) in ('ATIVO','QUITADO')
          and ac.criado_em::date between a.liq - 15 and a.liq + 15) as n_ac,
      (select ac.id from public.acordos ac
        where ac.aluno_id = a.aluno_id and upper(coalesce(ac.status,'')) in ('ATIVO','QUITADO')
          and ac.criado_em::date between a.liq - 15 and a.liq + 15
        order by abs(ac.criado_em::date - a.liq), ac.id limit 1) as ac_id,
      (select count(distinct z.liq) from a z where z.aluno_id = a.aluno_id and z.ac_vivo) as grupos,
      lo.soma
    from a left join lote lo on lo.aluno_id = a.aluno_id and lo.liq = a.liq
  ),
  kk as (
    select k.*, ac.valor_total, ac.criado_em::date as ac_em, coalesce(ac.numero_acordo::text,'') as ac_num,
      (select count(*) from public.acordo_titulo_vinculo v where v.acordo_id = ac.id and coalesce(v.ativo, true)) as n_vinc,
      (select min(e4.liquidado_em)
         from public.acordo_titulo_vinculo v
         join public.acordos_titulos t4 on t4.id = v.titulo_id
         join lateral (select e.liquidado_em from public.prime_extrato e
                        where e.boleto = t4.documento and e.liquidado_em is not null
                        order by e.coletado_em desc limit 1) e4 on true
        where v.acordo_id = ac.id and coalesce(v.ativo, true)) as liq_vinc,
      round(ac.valor_total / nullif(k.soma, 0), 3) as razao,
      exists (select 1 from public.acordos acx where acx.aluno_id = k.aluno_id
                and upper(coalesce(acx.status,'')) in ('CANCELADO','CANCELADA')) as canc_historico
    from k left join public.acordos ac on ac.id = k.ac_id
  ),
  sg as (
    select kk.*,
      case when not kk.ac_vivo then 'A1'
           when kk.n_ac > 1 then 'A2_INCONCLUSIVO'
           when kk.vencimento >= kk.ac_em then 'A2_NAO_COBRE'
           when kk.n_vinc > 0 and kk.liq_vinc is not null and abs(kk.liq_vinc - kk.liq) > 3 then 'A2_NAO_COBRE'
           when kk.grupos > 1 then 'A2_INCONCLUSIVO'
           when kk.razao between 0.25 and 1.60 then 'A2_COBRE'
           else 'A2_INCONCLUSIVO' end as sub
    from kk
  )
  select sg.id, sg.aluno_id, sg.cpf_a, sg.documento, sg.v, sg.vencimento, sg.imp, sg.liq, sg.port, sg.b, sg.p, sg.liq_s,
         case when sg.pag then 'PAGAMENTO_REATIVA' else 'VALOR_PAGO_ACIMA_DO_BRUTO' end,
         sg.sub,
         case when sg.sub = 'A1' then null else sg.ac_id end,
         case when sg.sub = 'A1' then null else sg.ac_num end,
         case when sg.sub = 'A1' then null else sg.razao end,
         sg.canc_historico,
         jsonb_build_object(
           'regra', 'liquidado_em > vencimento+30; >= importacao; <> dia da importacao; boleto no portador 195; CPF do boleto = CPF da ficha; sem conflito; pagamento ReATIVA no dia ou valor pago > bruto',
           'documento', sg.documento, 'vencimento', sg.vencimento, 'importado_em', sg.imp,
           'liquidado_em', sg.liq, 'portador', sg.port, 'valor_bruto', sg.b, 'valor_pago', sg.p,
           'liquidado_em_2a_coleta', sg.liq_s, 'cpf_confere', true,
           'pagamento_reativa_no_dia', sg.pag, 'acordo_vivo_na_janela', sg.ac_vivo,
           'acordo_numero', case when sg.sub = 'A1' then null else sg.ac_num end,
           'razao_acordo_lote', case when sg.sub = 'A1' then null else sg.razao end,
           'acordo_cancelado_no_historico', sg.canc_historico),
         md5(concat_ws('|', sg.documento, sg.liq, sg.port, sg.b, sg.p, sg.liq_s))
    from sg
   where p_titulo_ids is null or sg.id = any(p_titulo_ids);
$function$;

-- DETECCAO E SUSPENSAO. Com p_aplicar = false so mede (nada e escrito). Com
-- p_aplicar = true: registra a decisao PENDENTE com a evidencia, poe o titulo em
-- EM_CONFIRMACAO, grava a movimentacao e recalcula a ficha. Nao entram de novo:
-- titulo ja decidido (confirmado/vinculado), ja pendente, ou rejeitado com a
-- MESMA evidencia -- so fato novo (outra chave) recoloca um rejeitado.
create or replace function public.prime_conferencia_detectar_grupo_a(
  p_aplicar boolean default false, p_titulo_ids uuid[] default null, p_limite integer default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '300s'
as $function$
declare
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_res    jsonb;
  v_n      int := 0;
  v_alunos uuid[];
begin
  -- gestao, service_role ou rotina interna (sem JWT)
  if auth.jwt() is not null
     and not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  drop table if exists _grupo_a;
  create temp table _grupo_a on commit drop as
  select c.*, t.situacao as situacao_atual, t.status as status_atual,
         (select k.operador_email from public.casos k
           where k.aluno_id = c.aluno_id and not coalesce(k.encerrado_operacional, false)
           order by k.caso_atualizado_em desc nulls last limit 1) as operador
    from public.prime_grupo_a_candidatos(p_titulo_ids) c
    join public.acordos_titulos t on t.id = c.titulo_id
   where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and not exists (select 1 from public.prime_conferencia_decisao d
                      where d.titulo_id = c.titulo_id
                        and (d.decisao in ('CONFIRMADO','VINCULADO','PENDENTE')
                             or (d.decisao = 'REJEITADO'
                                 and (d.evidencia_chave is null or d.evidencia_chave = c.evidencia_chave))));

  if p_limite is not null then
    delete from _grupo_a g
     where g.titulo_id not in (select x.titulo_id from _grupo_a x order by x.valor desc, x.titulo_id limit p_limite);
  end if;

  select jsonb_build_object(
    'aplicado', p_aplicar,
    'titulos', count(*), 'alunos', count(distinct aluno_id), 'valor', coalesce(round(sum(valor), 2), 0),
    'A1', count(*) filter (where subgrupo = 'A1'),
    'A1_valor', coalesce(round(sum(valor) filter (where subgrupo = 'A1'), 2), 0),
    'A2_COBRE', count(*) filter (where subgrupo = 'A2_COBRE'),
    'A2_COBRE_valor', coalesce(round(sum(valor) filter (where subgrupo = 'A2_COBRE'), 2), 0),
    'A2_NAO_COBRE', count(*) filter (where subgrupo = 'A2_NAO_COBRE'),
    'A2_NAO_COBRE_valor', coalesce(round(sum(valor) filter (where subgrupo = 'A2_NAO_COBRE'), 2), 0),
    'A2_INCONCLUSIVO', count(*) filter (where subgrupo = 'A2_INCONCLUSIVO'),
    'A2_INCONCLUSIVO_valor', coalesce(round(sum(valor) filter (where subgrupo = 'A2_INCONCLUSIVO'), 2), 0),
    'revisao_obrigatoria', count(*) filter (where revisao_obrigatoria),
    'com_operador', count(*) filter (where operador is not null))
  into v_res from _grupo_a;

  if not p_aplicar then
    return v_res;
  end if;

  perform set_config('conferencia_prime.decisao', 'on', true);

  insert into public.prime_conferencia_decisao
    (titulo_id, decisao, motivo, decidido_por, decidido_em, motivo_entrada, aluno_id, cpf, documento, valor,
     evidencia, evidencia_chave, corroboracao, subgrupo, acordo_id, acordo_numero, revisao_obrigatoria,
     operador_no_momento, detectado_em, situacao_anterior, status_anterior)
  select g.titulo_id, 'PENDENTE', null, null, null, 'LIQUIDACAO_PRIME_CORROBORADA', g.aluno_id, g.cpf, g.documento, g.valor,
         g.evidencia, g.evidencia_chave, g.corroboracao, g.subgrupo, g.acordo_id, g.acordo_numero, g.revisao_obrigatoria,
         g.operador, now(), g.situacao_atual, g.status_atual
    from _grupo_a g
  on conflict (titulo_id) do update
    set decisao = 'PENDENTE', motivo = null, decidido_por = null, decidido_em = null,
        motivo_entrada = excluded.motivo_entrada, aluno_id = excluded.aluno_id, cpf = excluded.cpf,
        documento = excluded.documento, valor = excluded.valor, evidencia = excluded.evidencia,
        evidencia_chave = excluded.evidencia_chave, corroboracao = excluded.corroboracao,
        subgrupo = excluded.subgrupo, acordo_id = excluded.acordo_id, acordo_numero = excluded.acordo_numero,
        revisao_obrigatoria = excluded.revisao_obrigatoria, operador_no_momento = excluded.operador_no_momento,
        detectado_em = excluded.detectado_em, situacao_anterior = excluded.situacao_anterior,
        status_anterior = excluded.status_anterior;

  update public.acordos_titulos t
     set situacao = 'EM_CONFIRMACAO', atualizado_em = now()
    from _grupo_a g
   where t.id = g.titulo_id;
  get diagnostics v_n = row_count;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  select g.aluno_id::text, 'TITULO_EM_CONFIRMACAO_PRIME',
         'Titulo ' || coalesce(g.documento,'?') || ' (venc. ' || to_char(g.vencimento,'DD/MM/YYYY')
           || ') saiu da cobranca e aguarda a Conferencia Prime: liquidado na Prime em '
           || to_char(g.liquidado_em,'DD/MM/YYYY') || ', corroborado por ' || g.corroboracao
           || '. Nada foi baixado; o valor do titulo foi mantido.',
         coalesce(g.situacao_atual,'(sem)'), 'EM_CONFIRMACAO', 'Sistema',
         coalesce(nullif(v_email,''), 'conferencia_prime@sistema'), now(), g.valor
    from _grupo_a g;

  select array_agg(distinct g.aluno_id) into v_alunos from _grupo_a g;
  if v_alunos is not null then
    perform public.recalcular_situacao_aluno(x, 'conferencia_prime_suspensao') from unnest(v_alunos) x;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_SUSPENSAO_GRUPO_A', 'acordos_titulos',
          v_res || jsonb_build_object('suspensos', v_n));

  perform set_config('conferencia_prime.decisao', 'off', true);
  return v_res || jsonb_build_object('suspensos', v_n);
end;
$function$;

-- A FILA: so o que a deteccao colocou em confirmacao e ainda espera decisao.
-- Nunca mais a data crua da Prime. A2 primeiro (risco de cobranca dupla).
drop function if exists public.prime_conferencia_fila();
create function public.prime_conferencia_fila()
 returns table(titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text, vencimento date,
               valor numeric, liquidado_em date, portador integer, corroboracao text, subgrupo text,
               acordo_id uuid, acordo_numero text, acordo_status text, razao numeric,
               revisao_obrigatoria boolean, operador_responsavel text, outras_dividas boolean,
               detectado_em timestamptz, evidencia jsonb)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;
  return query
  select d.titulo_id, d.aluno_id, al.nome, d.cpf, d.documento, t.vencimento, d.valor,
         (d.evidencia->>'liquidado_em')::date, (d.evidencia->>'portador')::int,
         d.corroboracao, d.subgrupo, d.acordo_id, d.acordo_numero, ac.status,
         (d.evidencia->>'razao_acordo_lote')::numeric, d.revisao_obrigatoria,
         al.responsavel_atual_email,
         not public.caso_aguarda_confirmacao_financeira(d.aluno_id),
         d.detectado_em, d.evidencia
    from public.prime_conferencia_decisao d
    join public.acordos_titulos t on t.id = d.titulo_id
    left join public.alunos al on al.id = d.aluno_id
    left join public.acordos ac on ac.id = d.acordo_id
   where d.decisao = 'PENDENTE'
   order by (coalesce(d.subgrupo,'') like 'A2%') desc, d.valor desc, d.titulo_id;
end;
$function$;

-- CONFIRMAR A2 QUE O ACORDO COBRE: vinculo ao acordo existente, pelo fluxo
-- oficial (vincular_titulos_acordo). Nao cria acordo, nao cria parcela, nao da
-- baixa independente: a divida fica so nas parcelas do acordo.
create or replace function public.prime_conferencia_vincular(
  p_titulo_id uuid, p_acordo_id uuid default null, p_observacao text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs    text := nullif(btrim(coalesce(p_observacao,'')), '');
  v_titulo public.acordos_titulos%rowtype;
  v_dec    public.prime_conferencia_decisao%rowtype;
  v_acordo uuid;
  v_num    text;
  v_res    jsonb;
begin
  if not (public.crm_usuario_pode_quitar_baixar() or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'SEM_PERMISSAO: seu usuário não pode vincular título a acordo por aqui.';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;
  if upper(coalesce(v_titulo.situacao,'')) <> 'EM_CONFIRMACAO' then
    raise exception 'NAO_ESTA_EM_CONFIRMACAO: so se vincula por aqui titulo que a Conferencia Prime colocou em confirmacao.';
  end if;

  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE';
  end if;
  -- So o A2 que o acordo cobre vincula direto ao acordo da deteccao. Qualquer
  -- outro (A2 inconclusivo, A2 que nao cobre, A1 que ganhou acordo depois)
  -- so com o acordo escolhido por gente e motivo escrito.
  v_acordo := coalesce(p_acordo_id, v_dec.acordo_id);
  if coalesce(v_dec.subgrupo,'') <> 'A2_COBRE' and (p_acordo_id is null or length(coalesce(v_obs,'')) < 10) then
    raise exception 'ESCOLHA_O_ACORDO_E_O_MOTIVO: titulo % exige o acordo escolhido e motivo explicito (minimo 10 caracteres).', coalesce(v_dec.subgrupo,'?');
  end if;
  if v_dec.revisao_obrigatoria and length(coalesce(v_obs,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: aluno com acordo cancelado no historico -- escreva o motivo da decisao (minimo 10 caracteres).';
  end if;
  if v_acordo is null then
    raise exception 'ACORDO_NAO_INFORMADO';
  end if;
  select coalesce(numero_acordo::text,'') into v_num
    from public.acordos where id = v_acordo and aluno_id = v_titulo.aluno_id;
  if not found then
    raise exception 'ACORDO_DE_OUTRO_ALUNO: o acordo informado nao e deste aluno.';
  end if;

  perform set_config('conferencia_prime.decisao', 'on', true);
  v_res := public.vincular_titulos_acordo(array[p_titulo_id], v_acordo);
  perform set_config('conferencia_prime.decisao', 'off', true);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'VINCULO_FALHOU: %', v_res::text;
  end if;

  update public.prime_conferencia_decisao
     set decisao = 'VINCULADO', motivo = v_obs, decidido_por = nullif(v_email,''),
         decidido_em = now(), acordo_id = v_acordo, acordo_numero = v_num
   where titulo_id = p_titulo_id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (v_titulo.aluno_id::text, 'TITULO_VINCULADO_CONFERENCIA_PRIME',
          'Titulo ' || coalesce(v_titulo.documento,'?') || ' vinculado ao acordo ' || v_num
            || ' pela Conferencia Prime: a divida fica so nas parcelas do acordo.'
            || coalesce(' ' || v_obs, ''),
          'EM_CONFIRMACAO', upper(coalesce(v_res->>'estado_titulo','')), v_email, v_email, now(),
          coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido, v_titulo.valor_em_aberto, v_titulo.valor_original, 0));

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_VINCULO', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('acordo_id', v_acordo, 'acordo_numero', v_num, 'subgrupo', v_dec.subgrupo,
                             'observacao', v_obs, 'evidencia', v_dec.evidencia, 'resultado', v_res));

  perform public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_vinculo');
  return v_res || jsonb_build_object('decisao', 'VINCULADO', 'acordo_numero', v_num);
end;
$function$;

CREATE OR REPLACE FUNCTION public.prime_conferencia_baixar(p_titulo_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs       text := nullif(btrim(coalesce(p_observacao,'')), '');
  v_titulo    public.acordos_titulos%rowtype;
  v_dec       public.prime_conferencia_decisao%rowtype;
  v_ev        record;
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

  if upper(coalesce(v_titulo.situacao,'')) = 'PAGO' then
    return jsonb_build_object('ja_processado', true, 'status', v_titulo.status, 'situacao', v_titulo.situacao);
  end if;

  -- Premissa 6: so baixa o que a deteccao do grupo A pos em confirmacao e que
  -- ainda espera decisao humana. Nunca mais a data crua da Prime.
  if upper(coalesce(v_titulo.situacao,'')) <> 'EM_CONFIRMACAO' then
    raise exception 'NAO_ESTA_EM_CONFIRMACAO: so se baixa por aqui titulo que a Conferencia Prime colocou em confirmacao.';
  end if;

  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE';
  end if;

  if v_dec.subgrupo = 'A2_COBRE' then
    raise exception 'USE_O_VINCULO: o acordo % cobre este titulo -- confirme pelo vinculo ao acordo, nao por baixa.', coalesce(v_dec.acordo_numero,'?');
  end if;
  if (v_dec.revisao_obrigatoria or v_dec.subgrupo in ('A2_NAO_COBRE','A2_INCONCLUSIVO'))
     and length(coalesce(v_obs,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: este titulo exige revisao humana -- escreva o motivo da decisao (minimo 10 caracteres).';
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

  -- A evidencia e conferida DE NOVO, agora -- nao vale a da deteccao.
  select * into v_ev from public.prime_grupo_a_candidatos(array[p_titulo_id]) limit 1;
  if not found then
    raise exception 'EVIDENCIA_NAO_CONFIRMA: a liquidacao deste titulo nao se sustenta mais na Prime -- rejeite para voltar a cobrar.';
  end if;
  if v_ev.subgrupo = 'A2_COBRE' and v_dec.subgrupo <> 'A2_COBRE' then
    raise exception 'CLASSIFICACAO_MUDOU: hoje o acordo % cobre este titulo -- vincule ao acordo em vez de baixar.', coalesce(v_ev.acordo_numero,'?');
  end if;

  v_valor := round(coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido,
                            v_titulo.valor_em_aberto, v_titulo.valor_original, 0), 2);

  perform set_config('conferencia_prime.decisao', 'on', true);
  update public.acordos_titulos
     set situacao = 'PAGO', status = 'quitada',
         origem_liquidacao     = 'PRIME_LIQUIDACAO_OFICIAL',
         origem_liquidacao_ref = 'conferencia_prime:' || p_titulo_id::text,
         origem_liquidacao_em  = now(),
         motivo_ajuste = coalesce(motivo_ajuste,'')
           || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
           || 'baixado pela Conferencia Prime: liquidado na Prime em ' || to_char(v_ev.liquidado_em, 'DD/MM/YYYY')
           || ', corroborado por ' || v_ev.corroboracao || '; decisao de ' || coalesce(nullif(v_email,''), 'sistema'),
         atualizado_em = now()
   where id = p_titulo_id;
  perform set_config('conferencia_prime.decisao', 'off', true);

  update public.prime_conferencia_decisao
     set decisao = 'CONFIRMADO', motivo = v_obs, decidido_por = nullif(v_email,''), decidido_em = now(),
         evidencia = coalesce(evidencia, '{}'::jsonb) || jsonb_build_object('reconferida_na_decisao', v_ev.evidencia)
   where titulo_id = p_titulo_id;

  if v_titulo.aluno_id is not null then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_titulo.aluno_id::text,
      'BAIXA_CONFERENCIA_PRIME',
      concat_ws(' ',
        'Titulo', btrim(coalesce(v_titulo.documento,'')),
        'venc.', to_char(v_titulo.vencimento, 'DD/MM/YYYY'),
        'baixado por conferencia com a Prime (liquidado em',
        to_char(v_ev.liquidado_em, 'DD/MM/YYYY') || ', corroborado por ' || v_ev.corroboracao || ').',
        v_obs
      ),
      'EM_CONFIRMACAO', 'PAGO', v_email, now(), v_valor
    );
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_BAIXA', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('documento', v_titulo.documento, 'valor', v_valor, 'subgrupo', v_dec.subgrupo,
                             'observacao', v_obs, 'evidencia_deteccao', v_dec.evidencia,
                             'evidencia_decisao', v_ev.evidencia));

  if v_titulo.aluno_id is not null then
    perform public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_baixa');
  end if;

  return jsonb_build_object('ja_processado', false, 'titulo_id', p_titulo_id, 'decisao', 'CONFIRMADO',
                            'valor_baixado', v_valor, 'liquidado_em', v_ev.liquidado_em);
end;
$function$;

CREATE OR REPLACE FUNCTION public.prime_conferencia_confirmar(p_titulo_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sub text;
begin
  -- A2 que o acordo cobre confirma por VINCULO (a divida fica so nas parcelas
  -- do acordo); o resto confirma pela baixa oficial, que reconfere a evidencia.
  select subgrupo into v_sub from public.prime_conferencia_decisao
   where titulo_id = p_titulo_id and decisao = 'PENDENTE';
  if v_sub = 'A2_COBRE' then
    return public.prime_conferencia_vincular(p_titulo_id, null, p_observacao) || jsonb_build_object('ok', true);
  end if;
  return coalesce(public.prime_conferencia_baixar(p_titulo_id, p_observacao), '{}'::jsonb) || jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.prime_conferencia_rejeitar(p_titulo_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_motivo text := nullif(btrim(coalesce(p_motivo,'')), '');
  v_titulo public.acordos_titulos%rowtype;
  v_dec    public.prime_conferencia_decisao%rowtype;
  v_valor  numeric;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  if length(coalesce(v_motivo,'')) < 5 then
    raise exception 'MOTIVO_OBRIGATORIO: diga por que a liquidacao nao vale (minimo 5 caracteres).';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;

  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE: so se rejeita o que esta na fila da Conferencia Prime.';
  end if;

  v_valor := round(coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido,
                            v_titulo.valor_em_aberto, v_titulo.valor_original, 0), 2);

  -- O titulo volta a ser cobrado: ABERTO, exigivel, com o mesmo valor.
  if upper(coalesce(v_titulo.situacao,'')) = 'EM_CONFIRMACAO' then
    perform set_config('conferencia_prime.decisao', 'on', true);
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto', atualizado_em = now()
     where id = p_titulo_id;
    perform set_config('conferencia_prime.decisao', 'off', true);

    if v_titulo.aluno_id is not null then
      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
      values (v_titulo.aluno_id::text, 'TITULO_CONFIRMACAO_REJEITADA',
              'Titulo ' || coalesce(v_titulo.documento,'?') || ' voltou para a cobranca: a Conferencia Prime rejeitou a liquidacao. Motivo: ' || v_motivo,
              'EM_CONFIRMACAO', 'ABERTO', v_email, v_email, now(), v_valor);
    end if;
  end if;

  -- A chave da evidencia fica: a mesma evidencia nao recoloca o titulo em
  -- confirmacao. So um fato novo (outra chave) o traz de volta para a fila.
  update public.prime_conferencia_decisao
     set decisao = 'REJEITADO', motivo = v_motivo, decidido_por = nullif(v_email,''), decidido_em = now()
   where titulo_id = p_titulo_id;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_REJEICAO', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('documento', v_titulo.documento, 'valor', v_valor, 'subgrupo', v_dec.subgrupo,
                             'motivo', v_motivo, 'evidencia_chave', v_dec.evidencia_chave,
                             'evidencia', v_dec.evidencia));

  if v_titulo.aluno_id is not null then
    perform public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_rejeicao');
  end if;

  return jsonb_build_object('ok', true, 'decisao', 'REJEITADO', 'titulo_id', p_titulo_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.prime_conferencia_rejeitar_lote(p_titulo_ids uuid[], p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_ids uuid[];
  v_id  uuid;
  v_n   int := 0;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  v_ids := array(select distinct x from unnest(coalesce(p_titulo_ids, '{}'::uuid[])) x where x is not null);
  if array_length(v_ids, 1) is null then
    return jsonb_build_object('ok', false, 'motivo', 'LISTA_VAZIA');
  end if;

  -- um a um pelo mesmo caminho do individual: volta a ABERTO, registra, recalcula
  foreach v_id in array v_ids loop
    perform public.prime_conferencia_rejeitar(v_id, p_motivo);
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'rejeitados', v_n);
end;
$function$;

-- ===== 3. PERMISSOES ==========================================================
-- As telas chamam como authenticated; o portao de cada funcao decide quem pode
-- (gestao / quem pode quitar-baixar). A regra do grupo A em si so e chamada
-- por dentro (funcoes SECURITY DEFINER), nunca direto pela tela.
revoke all on function public.caso_aguarda_confirmacao_financeira(uuid) from public, anon;
revoke all on function public.prime_grupo_a_candidatos(uuid[]) from public, anon, authenticated;
revoke all on function public.prime_conferencia_detectar_grupo_a(boolean, uuid[], integer) from public, anon;
revoke all on function public.prime_conferencia_fila() from public, anon;
revoke all on function public.prime_conferencia_vincular(uuid, uuid, text) from public, anon;

grant execute on function public.caso_aguarda_confirmacao_financeira(uuid) to authenticated, service_role;
grant execute on function public.prime_grupo_a_candidatos(uuid[]) to service_role;
grant execute on function public.prime_conferencia_detectar_grupo_a(boolean, uuid[], integer) to authenticated, service_role;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;
grant execute on function public.prime_conferencia_vincular(uuid, uuid, text) to authenticated, service_role;

commit;
