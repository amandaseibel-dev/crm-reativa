-- Ficha zerada sai de todas as telas + aluno sem débito é encerrado.
--
-- Pergunta da Amanda (04/09/2026): "caso com a ficha zerada mas com valor no
-- borderô conta como valor?". Na carteira não contava; mas o card do Funil
-- ("Ainda em aberto") somava `casos.total_em_aberto`, um snapshot que ninguém
-- zera quando o título é pago ou cancelado, e a Penetração por Ano aceitava
-- o aluno na base ativa só por esse snapshot. Medido em prod: R$ 4,5 mi de
-- snapshot em 922 casos com saldo real zero; 3.026 casos com saldo real zero
-- cujo ALUNO seguia com status "vivo" (AGUARDANDO_BAIXA na maioria: a
-- confirmação foi resolvida e ninguém fechou o aluno depois).
--
-- Decisão da Amanda: "todas as telas devem sair esse valor de borderô; se o
-- valor zerou e não consta débito deve encerrar o aluno".
--
-- O que esta migration faz:
--   1. casos_encerrar_zerados_sem_debito(): rotina em massa (sem chamar
--      caso_saldo_operacional linha a linha) que, para quem tem saldo real
--      zero e nenhuma pendência (confirmação/baixa):
--        a) zera casos.total_em_aberto e alunos.valor_em_aberto;
--        b) encerra caso e aluno (SEM_SALDO_EM_ABERTO; QUITADO quando o caso
--           já tem quitado_em), registrando movimentação.
--      Não toca jurídico/cancelamento/suspensão. Não cria solicitação de
--      confirmação: quem tem operador, nunca passou pela confirmação e não
--      está quitado continua sendo tratado pela rotina diária
--      retirar_zerados_reais_sem_saldo(), que encaminha para a fila de
--      confirmação (crédito do operador).
--   2. cron horário (:32, depois de reavaliar_encerramento :30).
--   3. funil_historico_recuperacao: "Ainda em aberto" passa a ser o saldo
--      canônico (títulos vivos + parcelas abertas) da base NÃO encerrada.
--   4. _penetracao_ano_montar: base ativa exige título/parcela viva e caso
--      não encerrado; saldo vem dos títulos vivos, não do snapshot.

-- ---------------------------------------------------------------------------
-- 1) Rotina
-- ---------------------------------------------------------------------------
create or replace function public.casos_encerrar_zerados_sem_debito(
  p_limite integer default null,
  p_origem text default 'cron'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '180s'
as $$
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

  -- Saldo real por aluno, replicando aluno_saldo_pendente_detalhe /
  -- caso_saldo_operacional em massa (validado 1:1 em prod: 4.740 zerados,
  -- 13.088 com saldo, zero divergência).
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

  -- a) Snapshot: sem débito, o valor de borderô não pode aparecer em tela nenhuma.
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

  -- b) Encerramento. Fora: jurídico/cancelamento/suspensão (decisão da gestão)
  --    e quem tem operador, não está quitado e nunca passou pela confirmação
  --    (a rotina diária encaminha para a fila de confirmação).
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

  -- Aluno: QUITADO quando algum caso dele já tem quitação registrada e o
  -- saldo por CPF confere; senão SEM_SALDO_EM_ABERTO. Os dois contam como
  -- encerrado em caso_encerrado_operacional.
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
$$;

revoke all on function public.casos_encerrar_zerados_sem_debito(integer, text) from public, anon;
grant execute on function public.casos_encerrar_zerados_sem_debito(integer, text) to authenticated, service_role;

comment on function public.casos_encerrar_zerados_sem_debito(integer, text) is
  'Saldo real zero e sem pendência: zera o snapshot (total_em_aberto) e encerra caso e aluno. Roda de hora em hora (:32). Não mexe em jurídico/cancelamento/suspensão.';

-- ---------------------------------------------------------------------------
-- 2) Cron horário (só onde pg_cron existe)
-- ---------------------------------------------------------------------------
do $$
declare v_n int;
begin
  -- Dinâmico de propósito: sem pg_cron (staging) o plpgsql nem pode preparar
  -- uma referência a cron.job.
  if to_regclass('cron.job') is not null then
    execute $q$select count(*) from cron.job where jobname = 'casos_encerrar_zerados_horario'$q$ into v_n;
    if v_n = 0 then
      execute $q$select cron.schedule('casos_encerrar_zerados_horario', '32 * * * *',
        'select public.casos_encerrar_zerados_sem_debito(null, ''cron'');')$q$;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Funil: "Ainda em aberto (base ativa hoje)" = saldo canônico da base não encerrada
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.funil_historico_recuperacao()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total integer;
  v_ativo integer;
  v_recuperado integer;
  v_suspenso integer;
  v_termos integer;
  v_valor_aberto numeric;
  v_valor_recuperado_total numeric;
  v_grupo_ativo text[] := ARRAY['Em cobrança','CONTATAR','MENSAGEM_ENVIADA','EM_ATENDIMENTO','ALUNO_EM_NEGOCIACAO_24H','AGUARDANDO_COMPROVANTE','NAO_LOCALIZADO','RETORNAR_DEPOIS','SEM_RETORNO','LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO','SOLICITADO_LINK','Novo caso'];
  -- SEM_SALDO_EM_ABERTO / SALDO_ZERO_CONFIRMADO / ENCERRADO: sem débito, já saíram da base.
  v_grupo_recuperado text[] := ARRAY['QUITADO_MANUAL','QUITADO','BAIXA_REALIZADA','ACORDO_FECHADO','AGUARDANDO_BAIXA','ELOGIO_ATENDIMENTO','SEM_SALDO_EM_ABERTO','SALDO_ZERO_CONFIRMADO','ENCERRADO'];
  v_grupo_suspenso text[] := ARRAY['CANCELAMENTO_COBRANCA','JURIDICO','SUSPENSAO_COBRANCA','BAIXA_DEVOLVIDA'];
  v_grupo_termos text[] := ARRAY['TERMO_LIBERADO_AUTOMATICO_GOV','TERMO_ENVIADO_ALUNO','Termo recebido - liberado','TERMO_RECEBIDO_LIBERADO','Termo rejeitado','Enviado ao financeiro','Aguardando envio financeiro'];
BEGIN
  SELECT count(*) INTO v_total FROM public.alunos;
  SELECT count(*) INTO v_ativo FROM public.alunos WHERE status_jornada = ANY(v_grupo_ativo) OR status_jornada IS NULL;
  SELECT count(*) INTO v_recuperado FROM public.alunos WHERE status_jornada = ANY(v_grupo_recuperado);
  SELECT count(*) INTO v_suspenso FROM public.alunos WHERE status_jornada = ANY(v_grupo_suspenso);
  SELECT count(*) INTO v_termos FROM public.alunos WHERE status_jornada = ANY(v_grupo_termos);

  -- Ajusta ativo pra nao contar quem caiu em outro grupo mas tambem tinha
  -- status nulo (evita dupla contagem -- soma deve bater com o total).
  v_ativo := v_total - v_recuperado - v_suspenso - v_termos;

  -- Saldo CANONICO (mesma regra de aluno_saldo_pendente_detalhe), so da base
  -- nao encerrada. Antes somava casos.total_em_aberto, snapshot que ninguem
  -- zera quando o titulo e pago/cancelado: R$ 6,76 mi de casos encerrados
  -- entravam no card (04/09/2026).
  WITH ativos AS (
    SELECT DISTINCT c.aluno_id
      FROM public.casos c
     WHERE c.aluno_id IS NOT NULL
       AND NOT coalesce(c.encerrado_operacional, false)
  ), mens AS (
    SELECT coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 0) v
      FROM public.acordos_titulos t
      JOIN ativos x ON x.aluno_id = t.aluno_id
     WHERE upper(coalesce(t.situacao,'')) IN ('ABERTO','NEGOCIADO')
       AND coalesce(lower(t.status),'') <> 'quitada'
       AND coalesce(t.tipo_boleto,'') <> 'Acordo'
       AND NOT EXISTS (
         SELECT 1 FROM public.acordo_titulo_vinculo v
           JOIN public.acordos a ON a.id = v.acordo_id
          WHERE v.titulo_id = t.id AND coalesce(v.ativo, true)
            AND upper(coalesce(a.status,'')) NOT IN ('CANCELADO','CANCELADA'))
  ), parc AS (
    SELECT coalesce(sum(coalesce(p.valor,0)), 0) v
      FROM public.parcelas p
      JOIN public.acordos a ON a.id = p.acordo_id
      JOIN ativos x ON x.aluno_id = a.aluno_id
     WHERE upper(coalesce(a.status,'')) NOT IN ('CANCELADO','CANCELADA')
       AND upper(coalesce(p.status,'')) NOT IN ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
  )
  SELECT round((SELECT v FROM mens) + (SELECT v FROM parc), 2) INTO v_valor_aberto;

  SELECT COALESCE(sum(valor_pago), 0) INTO v_valor_recuperado_total
  FROM public.pagamentos WHERE retroativo = false;

  RETURN jsonb_build_object(
    'total', v_total,
    'ativo', v_ativo,
    'recuperado', v_recuperado,
    'suspenso', v_suspenso,
    'termos', v_termos,
    'valor_aberto', v_valor_aberto,
    'valor_recuperado_total', v_valor_recuperado_total
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4) Penetração por Ano: base ativa sem o snapshot
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._penetracao_ano_montar(p_ini timestamp with time zone, p_fim timestamp with time zone, p_filtros jsonb, p_hoje date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '90s'
AS $function$
declare
  v_unidade text := nullif(p_filtros->>'unidade','');
  v_curso text := nullif(p_filtros->>'curso','');
  v_sit text := nullif(p_filtros->>'situacao_academica','');
  v_operador text := nullif(p_filtros->>'operador_email','');
  v_criticidade text := nullif(p_filtros->>'criticidade','');
  v_carteira text := nullif(p_filtros->>'carteira','');
  v_fidel text := nullif(p_filtros->>'fidelizacao','');
  v_saldo_min numeric := nullif(p_filtros->>'saldo_min','')::numeric;
  v_saldo_max numeric := nullif(p_filtros->>'saldo_max','')::numeric;
  v_venc_min numeric := nullif(p_filtros->>'saldo_vencido_min','')::numeric;
  v_venc_max numeric := nullif(p_filtros->>'saldo_vencido_max','')::numeric;
  v_pv_min int := nullif(p_filtros->>'parcelas_vencidas_min','')::int;
  v_atraso_min int := nullif(p_filtros->>'atraso_min','')::int;
  v_atraso_max int := nullif(p_filtros->>'atraso_max','')::int;
  v_com_acordo text := nullif(p_filtros->>'com_acordo','');
  v_situacoes jsonb := case when jsonb_typeof(p_filtros->'situacoes')='array' then p_filtros->'situacoes' else '[]'::jsonb end;
begin
  drop table if exists tmp_pen_tit;
  create temporary table tmp_pen_tit on commit drop as
  select t.aluno_id,
         bool_or(t.vencimento < p_hoje) as tem_venc,
         bool_or(t.vencimento >= p_hoje) as tem_fut,
         round(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento < p_hoje)::numeric,2) as saldo_venc,
         round(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento >= p_hoje)::numeric,2) as saldo_fut,
         min(t.vencimento) filter (where t.vencimento < p_hoje) as venc_mais_antigo
  from public.acordos_titulos t
  where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
    and coalesce(lower(t.status),'') not in ('quitada')
    and t.vencimento is not null
    and not exists (select 1 from public.acordo_titulo_vinculo v join public.acordos a on a.id=v.acordo_id
      where v.titulo_id=t.id and coalesce(v.ativo,true) and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
    and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
  group by t.aluno_id;

  drop table if exists tmp_pen_parc;
  create temporary table tmp_pen_parc on commit drop as
  select a.aluno_id,
         bool_or(p.status='VENCIDA') as tem_parc_venc,
         bool_or(p.status='A_VENCER') as tem_parc_fut,
         bool_or(p.is_entrada and p.status='VENCIDA') as tem_entrada_venc,
         bool_or(p.status='A_VENCER' and p.vencimento = p_hoje) as tem_parc_hoje,
         count(*) filter (where p.status='VENCIDA')::int as qtd_parc_venc,
         min(p.vencimento) filter (where p.status='VENCIDA') as venc_parc_antiga,
         min(p.vencimento) filter (where p.status='A_VENCER' and p.vencimento >= p_hoje) as prox_parc,
         round(sum(p.valor) filter (where p.status='VENCIDA')::numeric,2) as saldo_parc_venc,
         round(sum(p.valor) filter (where p.status='A_VENCER')::numeric,2) as saldo_parc_fut
  from public.acordos a join public.parcelas p on p.acordo_id=a.id and p.status in ('VENCIDA','A_VENCER')
  where a.status='ATIVO' group by a.aluno_id;

  drop table if exists tmp_pen_aflags;
  create temporary table tmp_pen_aflags on commit drop as
  select a.aluno_id, count(*) filter (where a.status='ATIVO')::int as cnt_ativo,
         bool_or(a.status='CANCELADO') as tem_cancelado, bool_or(a.status='QUITADO') as tem_quitado,
         bool_or(a.status='ATIVO' and coalesce(a.entrada_paga,false)=false and coalesce(a.valor_entrada,0)>0
                 and a.data_entrada is not null and a.data_entrada < p_hoje) as tem_entrada_venc_ac
  from public.acordos a group by a.aluno_id;

  drop table if exists tmp_pen_negoc;
  create temporary table tmp_pen_negoc on commit drop as
  select distinct v.titulo_id, t2.aluno_id
  from public.acordo_titulo_vinculo v
  join public.acordos a on a.id=v.acordo_id and coalesce(v.ativo,true) and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
  join public.acordos_titulos t2 on t2.id = v.titulo_id;

  -- Base ativa: aluno com titulo ou parcela VIVA e caso nao encerrado. Antes
  -- tambem entrava quem so tinha casos.total_em_aberto > 0 (snapshot que
  -- ninguem zera): 248 alunos sem divida inflavam a base e derrubavam a
  -- penetracao (04/09/2026). saldo_total tambem passa a ser o saldo vivo.
  drop table if exists tmp_pen_base;
  create temporary table tmp_pen_base on commit drop as
  select a.id as aluno_id,
         (coalesce(tt.saldo_venc,0)+coalesce(tt.saldo_fut,0)+coalesce(pp.saldo_parc_venc,0)+coalesce(pp.saldo_parc_fut,0)) as saldo_total,
         c.criticidade, c.operador_email,
         (c.data_retorno is not null and c.data_retorno > p_hoje) as em_retorno,
         a.unidade, a.curso, a.situacao_academica, a.data_ultimo_acionamento,
         (a.data_ultimo_acionamento is not null and a.data_ultimo_acionamento::date + 10 >= p_hoje) as fidel_ativa,
         coalesce(tt.tem_venc,false) as mens_venc, coalesce(tt.tem_fut,false) as mens_fut,
         coalesce(tt.saldo_venc,0) as saldo_mens_venc, coalesce(tt.saldo_fut,0) as saldo_mens_fut,
         tt.venc_mais_antigo as mens_venc_antigo,
         coalesce(pp.tem_parc_venc,false) as ac_parc_venc, coalesce(pp.tem_parc_fut,false) as ac_parc_fut,
         (coalesce(pp.tem_entrada_venc,false) or coalesce(af.tem_entrada_venc_ac,false)) as ac_entrada_venc,
         coalesce(pp.tem_parc_hoje,false) as ac_parc_hoje,
         coalesce(pp.qtd_parc_venc,0) as qtd_parc_venc, coalesce(pp.saldo_parc_venc,0) as saldo_ac_venc,
         coalesce(pp.saldo_parc_fut,0) as saldo_ac_fut, pp.venc_parc_antiga, pp.prox_parc,
         coalesce(af.cnt_ativo,0) as acordos_ativos, coalesce(af.tem_cancelado,false) as tem_cancelado,
         coalesce(af.tem_quitado,false) as tem_quitado,
         exists (select 1 from tmp_pen_negoc ng where ng.aluno_id=a.id) as mens_negociada,
         (case when coalesce(af.cnt_ativo,0)=0 then 'SEM_ACORDO'
               when coalesce(pp.tem_parc_venc,false) and pp.venc_parc_antiga < (p_hoje-30) then 'QUEBRADO'
               when coalesce(pp.tem_parc_venc,false) then 'VENCIDO' else 'EM_DIA' end) as acordo_situacao,
         (coalesce(tt.saldo_venc,0)+coalesce(pp.saldo_parc_venc,0)) as saldo_vencido_total,
         (p_hoje - least(coalesce(tt.venc_mais_antigo,'9999-12-31'::date), coalesce(pp.venc_parc_antiga,'9999-12-31'::date))) as dias_atraso,
         (case when public.normalizar_status_acionamento(a.situacao_operacional)='AGUARDANDO CONFIRMACAO' then true
               when exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id=a.id::text
                            and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) then true
               else false end) as bloqueado_conf
  from public.alunos a
  join public.casos c on c.aluno_id = a.id
  left join tmp_pen_tit tt on tt.aluno_id = a.id
  left join tmp_pen_parc pp on pp.aluno_id = a.id
  left join tmp_pen_aflags af on af.aluno_id = a.id
  where coalesce(a.status_jornada,'') not in ('QUITADO','QUITADO_MANUAL')
    and coalesce(a.status_atual,'') not in ('QUITADO','QUITADO_MANUAL')
    and not public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
    and not coalesce(c.encerrado_operacional,false)
    and not coalesce(c.nao_acionar,false)
    and (tt.aluno_id is not null or pp.aluno_id is not null)
    and (v_unidade is null or a.unidade=v_unidade)
    and (v_curso is null or a.curso=v_curso)
    and (v_sit is null or a.situacao_academica=v_sit)
    and (v_criticidade is null or c.criticidade=v_criticidade)
    and (v_operador is null or c.operador_email=v_operador)
    and (v_carteira is null or (v_carteira='livre' and c.operador_email is null) or (v_carteira='atribuido' and c.operador_email is not null))
    and (v_saldo_min is null or (coalesce(tt.saldo_venc,0)+coalesce(tt.saldo_fut,0)+coalesce(pp.saldo_parc_venc,0)+coalesce(pp.saldo_parc_fut,0)) >= v_saldo_min)
    and (v_saldo_max is null or (coalesce(tt.saldo_venc,0)+coalesce(tt.saldo_fut,0)+coalesce(pp.saldo_parc_venc,0)+coalesce(pp.saldo_parc_fut,0)) <= v_saldo_max);

  if v_fidel='ativa' then delete from tmp_pen_base where not fidel_ativa; end if;
  if v_fidel='expirada' then delete from tmp_pen_base where fidel_ativa; end if;
  if v_venc_min is not null then delete from tmp_pen_base where saldo_vencido_total < v_venc_min; end if;
  if v_venc_max is not null then delete from tmp_pen_base where saldo_vencido_total > v_venc_max; end if;
  if v_pv_min is not null then delete from tmp_pen_base where qtd_parc_venc < v_pv_min; end if;
  if v_atraso_min is not null then delete from tmp_pen_base where coalesce(dias_atraso,-1) < v_atraso_min; end if;
  if v_atraso_max is not null then delete from tmp_pen_base where coalesce(dias_atraso,2147483647) > v_atraso_max; end if;
  if v_com_acordo='com' then delete from tmp_pen_base where acordos_ativos=0; end if;
  if v_com_acordo='sem' then delete from tmp_pen_base where acordos_ativos>0; end if;

  if jsonb_array_length(v_situacoes) > 0 then
    delete from tmp_pen_base b where not (
         (v_situacoes ? 'mens_vencida' and b.mens_venc)
      or (v_situacoes ? 'mens_a_vencer' and b.mens_fut)
      or (v_situacoes ? 'mens_em_dia' and b.mens_fut and not b.mens_venc)
      or (v_situacoes ? 'mens_vencida_sem_acordo' and b.mens_venc and b.acordos_ativos=0)
      or (v_situacoes ? 'mens_negociada' and b.mens_negociada)
      or (v_situacoes ? 'somente_originais' and (b.mens_venc or b.mens_fut) and not b.mens_negociada)
      or (v_situacoes ? 'sem_mensalidade_ativa' and not b.mens_venc and not b.mens_fut)
      or (v_situacoes ? 'acordo_em_dia' and b.acordo_situacao='EM_DIA')
      or (v_situacoes ? 'acordo_parcela_vencida' and b.ac_parc_venc)
      or (v_situacoes ? 'acordo_entrada_vencida' and b.ac_entrada_venc)
      or (v_situacoes ? 'acordo_parcela_hoje' and b.ac_parc_hoje)
      or (v_situacoes ? 'acordo_parcela_a_vencer' and b.ac_parc_fut)
      or (v_situacoes ? 'acordo_prox_3' and b.prox_parc is not null and b.prox_parc <= p_hoje+3)
      or (v_situacoes ? 'acordo_prox_5' and b.prox_parc is not null and b.prox_parc <= p_hoje+5)
      or (v_situacoes ? 'acordo_prox_7' and b.prox_parc is not null and b.prox_parc <= p_hoje+7)
      or (v_situacoes ? 'acordo_quebrado' and b.acordo_situacao='QUEBRADO')
      or (v_situacoes ? 'acordo_cancelado' and b.tem_cancelado and b.acordos_ativos=0)
      or (v_situacoes ? 'acordo_quitado' and b.tem_quitado and b.acordos_ativos=0)
      or (v_situacoes ? 'sem_acordo_ativo' and b.acordos_ativos=0)
    );
  end if;

  drop table if exists tmp_pen_debt;
  create temporary table tmp_pen_debt on commit drop as
    select t.aluno_id, extract(year from t.vencimento)::int as ano,
           case when t.vencimento < p_hoje then coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) else 0 end as mens_venc,
           case when t.vencimento >= p_hoje then coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) else 0 end as mens_fut,
           0::numeric as ac_venc, 0::numeric as ac_fut, 0 as qtd_pv
    from public.acordos_titulos t join tmp_pen_base b on b.aluno_id=t.aluno_id
    where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO') and coalesce(lower(t.status),'') not in ('quitada') and t.vencimento is not null
      and not exists (select 1 from public.acordo_titulo_vinculo v join public.acordos a on a.id=v.acordo_id
        where v.titulo_id=t.id and coalesce(v.ativo,true) and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
      and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
  union all
    select a.aluno_id, extract(year from p.vencimento)::int as ano, 0::numeric, 0::numeric,
           case when p.status='VENCIDA' then p.valor else 0 end, case when p.status='A_VENCER' then p.valor else 0 end,
           case when p.status='VENCIDA' then 1 else 0 end
    from public.acordos a join public.parcelas p on p.acordo_id=a.id and p.status in ('VENCIDA','A_VENCER')
    join tmp_pen_base b on b.aluno_id=a.aluno_id
    where a.status='ATIVO' and p.vencimento is not null;

  drop table if exists tmp_pen_ba;
  create temporary table tmp_pen_ba on commit drop as
  select b.aluno_id, d.ano,
         round(coalesce(sum(d.mens_venc),0)::numeric,2) as saldo_mens_venc,
         round(coalesce(sum(d.mens_fut),0)::numeric,2) as saldo_mens_fut,
         round(coalesce(sum(d.ac_venc),0)::numeric,2) as saldo_ac_venc,
         round(coalesce(sum(d.ac_fut),0)::numeric,2) as saldo_ac_fut,
         coalesce(sum(d.qtd_pv),0)::int as qtd_parc_venc,
         b.bloqueado_conf, b.em_retorno, b.data_ultimo_acionamento, b.acordo_situacao, b.saldo_total
  from tmp_pen_base b left join tmp_pen_debt d on d.aluno_id=b.aluno_id
  group by b.aluno_id, d.ano, b.bloqueado_conf, b.em_retorno, b.data_ultimo_acionamento, b.acordo_situacao, b.saldo_total;

  drop table if exists tmp_pen_manual;
  create temporary table tmp_pen_manual on commit drop as
  select m.aluno_id::text as aid, count(*)::int as n, max(m.registrado_em) as ult
  from public.aluno_movimentacoes m
  where public.eh_tipo_acionamento(m.tipo) and m.tipo not in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')
    and coalesce(upper(m.registrado_por_email),'') <> 'SISTEMA'
    and (p_ini is null or m.registrado_em >= p_ini) and (p_fim is null or m.registrado_em < p_fim)
    and exists (select 1 from tmp_pen_base b where b.aluno_id::text = m.aluno_id::text)
  group by m.aluno_id::text;

  -- Acoes massivas: em prod o registro e SO aluno_movimentacoes
  -- (registrar_acao_massiva). As tabelas acoes_massivas_agendamentos /
  -- acoes_massivas_destinatarios nao existem em prod (04/09/2026) e a versao
  -- anterior desta funcao quebrava aqui -- a tela Penetracao por Ano estava
  -- fora do ar. Se um dia existirem, entram por SQL dinamico.
  drop table if exists tmp_pen_massivo_ev;
  create temporary table tmp_pen_massivo_ev on commit drop as
    select m.aluno_id::text as aid, null::int as ano_exp, m.registrado_em as ts
    from public.aluno_movimentacoes m
    where m.tipo in ('ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')
      and (p_ini is null or m.registrado_em >= p_ini) and (p_fim is null or m.registrado_em < p_fim)
      and exists (select 1 from tmp_pen_base b where b.aluno_id::text = m.aluno_id::text);
  if to_regclass('public.acoes_massivas_destinatarios') is not null
     and to_regclass('public.acoes_massivas_agendamentos') is not null then
    execute $dyn$
      insert into tmp_pen_massivo_ev (aid, ano_exp, ts)
      select d.aluno_id::text, nullif(g.filtros->>'ano_vencimento','')::int, coalesce(d.enviado_em,d.criado_em)
      from public.acoes_massivas_destinatarios d join public.acoes_massivas_agendamentos g on g.id=d.campanha_id
      where d.status in ('ENVIADO','PREPARADO') and g.status not in ('RASCUNHO','AGENDADO','CANCELADO','FALHOU')
        and ($1 is null or coalesce(d.enviado_em,d.criado_em) >= $1) and ($2 is null or coalesce(d.enviado_em,d.criado_em) < $2)
        and exists (select 1 from tmp_pen_base b where b.aluno_id::text = d.aluno_id::text)
    $dyn$ using p_ini, p_fim;
  end if;

  drop table if exists tmp_pen_massivo;
  create temporary table tmp_pen_massivo on commit drop as
  select aid, count(*)::int as n, max(ts) as ult from tmp_pen_massivo_ev group by aid;

  drop table if exists tmp_pen_acted;
  create temporary table tmp_pen_acted on commit drop as
    select ba.aluno_id, ba.ano, 'M'::text as canal from tmp_pen_ba ba join tmp_pen_manual mm on mm.aid=ba.aluno_id::text
  union
    select ba.aluno_id, ba.ano, 'X'::text from tmp_pen_ba ba join tmp_pen_massivo_ev me on me.aid=ba.aluno_id::text
    where me.ano_exp is null or me.ano_exp is not distinct from ba.ano
       or not exists (select 1 from tmp_pen_ba bx where bx.aluno_id=ba.aluno_id and bx.ano is not distinct from me.ano_exp);
end;
$function$;
