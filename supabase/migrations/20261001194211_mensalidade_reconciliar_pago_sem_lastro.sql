-- G2 / etapa 4 de 4 -- SANEAMENTO DO LOTE HISTORICO (RPC CRIADA, NAO EXECUTADA)
--
-- Esta versao CRIA a rotina. NAO a chama. A execucao e um passo separado, com
-- autorizacao propria, exatamente como foi feito em 30/09/2026 com o lote dos 64.
--
-- LOTE CONGELADO em 01/10/2026 (reconferido as 18:26 UTC, hash identico):
--   491 titulos | 145 alunos | 145 acordos | R$ 831.136,87
--   hash do conjunto de ids: 5178651c5f5af0d68e9757c1af5bc296
--
-- CRITERIO (quatro clausulas -- a quarta e o discriminador que separa E1 de A/A2):
--   1. situacao='PAGO' e o acordo (pela coluna OU pelo vinculo ativo) esta ATIVO
--   2. tipo_boleto <> 'Acordo'
--   3. existe evento acordos ATIVO->QUITADO com criado_em identico ao evento do
--      titulo e audit_log.id MENOR (ordem dos gatilhos AFTER = causalidade)
--   4. o titulo tem UM UNICO evento de virada para PAGO
--
-- Sem a clausula 4 o criterio devolve 495/146/146/R$ 833.379,33; os 4 excedentes
-- (1 aluno, 1 acordo, R$ 2.242,46) tem PAGO anterior ao evento causal e sao A/A2.
-- As tres definicoes possiveis do elo acordo-titulo (so coluna, so vinculo, uniao)
-- convergem para o MESMO conjunto e o MESMO hash.
--
-- FORA DO LOTE, por decisao da gestao: E2 (18), F (8), A (8), A2 (5), C (17/18) e
-- o caso Suelen. Os 8 F nao tem evento de virada no audit_log -- para eles nenhuma
-- proveniencia retroativa e construivel, so inferencia.
--
-- COMO FUNCIONA: para cada titulo grava a proveniencia retroativa -- ACORDO_QUITADO
-- com o _em do evento causal REAL, nao now() -- e depois chama
-- titulo_reabrir_quitacao_por_acordo, que reconfere as NOVE guardas por titulo e
-- decide. A rotina NAO decide o destino de nenhum titulo: so prova a causalidade,
-- grava a proveniencia e entrega a porta.

create or replace function public.mensalidade_reconciliar_pago_sem_lastro(p_confirmar boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lote text;
  v_qtd int; v_alunos int; v_acordos int; v_soma numeric; v_hash text;
  v_vinc int; v_ac_parc int; v_prov int; v_enc int; v_nao_quitada int;
  v_t uuid; v_ok int := 0; v_r jsonb;
  v_pago_antes int;  v_pago_depois int;
  v_neg_antes int;   v_neg_depois int;
  v_val_antes numeric; v_val_depois numeric;
  v_parc_antes int;  v_parc_depois int;
  v_vinc_antes int;  v_vinc_depois int;
  v_pag_antes int;   v_pag_depois int;
  v_ac_antes int;    v_ac_depois int;
  v_bx_antes int;    v_bx_depois int;
  v_saldo_antes numeric; v_saldo_depois numeric;
  v_mudou int;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  v_lote := 'PAGO_SEM_LASTRO_' || to_char(now(), 'YYYYMMDDHH24MISS');

  -- -------------------------------------------------------------------------
  -- 1) A POPULACAO, materializada por ID antes de qualquer escrita
  -- -------------------------------------------------------------------------
  create temp table _mrpsl_alvo on commit drop as
  with g2 as (
    select t.id as titulo_id, t.aluno_id, t.documento, t.tipo_boleto,
           coalesce(t.valor_original, 0) as valor_original,
           coalesce(t.acordo_id, vv.acordo_id) as acordo_id
      from public.acordos_titulos t
      left join public.acordo_titulo_vinculo vv
             on vv.titulo_id = t.id and coalesce(vv.ativo, true)
      left join public.acordos ac on ac.id = t.acordo_id
      left join public.acordos av on av.id = vv.acordo_id
     where upper(coalesce(t.situacao,'')) = 'PAGO'
       and (upper(coalesce(ac.status,'')) = 'ATIVO' or upper(coalesce(av.status,'')) = 'ATIVO')
  ),
  vt as (
    select l.registro_id::uuid as titulo_id, max(l.id) as ev_id, count(*) as n_ev
      from public.audit_log l
     where l.tabela = 'acordos_titulos'
       and l.dados_depois ->> 'situacao' = 'PAGO'
       and coalesce(l.dados_antes ->> 'situacao','') <> 'PAGO'
       and l.registro_id::uuid in (select titulo_id from g2)
     group by 1
  ),
  et as (
    select vt.titulo_id, vt.ev_id, vt.n_ev, l.criado_em
      from vt join public.audit_log l on l.id = vt.ev_id
  ),
  ea as (
    select l.registro_id::uuid as acordo_id, l.id as ev_id, l.criado_em
      from public.audit_log l
     where l.tabela = 'acordos'
       and l.dados_depois ->> 'status' = 'QUITADO'
       and coalesce(l.dados_antes ->> 'status','') = 'ATIVO'
  )
  select g.titulo_id, g.aluno_id, g.acordo_id, g.documento, g.valor_original,
         et.criado_em as quitado_em, et.ev_id as audit_id_titulo,
         (select a.ev_id from ea a
           where a.acordo_id = g.acordo_id and a.criado_em = et.criado_em and a.ev_id < et.ev_id
           order by a.ev_id desc limit 1) as audit_id_acordo
    from g2 g
    join et on et.titulo_id = g.titulo_id
   where coalesce(g.tipo_boleto,'') <> 'Acordo'
     and et.n_ev = 1
     and exists (select 1 from ea a
                  where a.acordo_id = g.acordo_id
                    and a.criado_em = et.criado_em
                    and a.ev_id < et.ev_id);

  -- -------------------------------------------------------------------------
  -- 2) GUARDAS DE ABERTURA -- qualquer divergencia aborta sem escrever nada
  -- -------------------------------------------------------------------------
  select count(*), count(distinct aluno_id), count(distinct acordo_id),
         round(coalesce(sum(valor_original),0),2),
         md5(string_agg(titulo_id::text, ',' order by titulo_id))
    into v_qtd, v_alunos, v_acordos, v_soma, v_hash
    from _mrpsl_alvo;

  select count(*) into v_vinc
    from public.acordo_titulo_vinculo v
   where coalesce(v.ativo, true) and v.titulo_id in (select titulo_id from _mrpsl_alvo);

  select count(distinct p.acordo_id) into v_ac_parc
    from public.parcelas p
   where p.acordo_id in (select acordo_id from _mrpsl_alvo)
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA');

  select count(*) filter (where t.origem_liquidacao is not null),
         count(*) filter (where t.origem_encerramento is not null),
         count(*) filter (where lower(coalesce(t.status,'')) <> 'quitada')
    into v_prov, v_enc, v_nao_quitada
    from public.acordos_titulos t
   where t.id in (select titulo_id from _mrpsl_alvo);

  if v_qtd    <> 491       then raise exception 'ABORTADO G1: % titulos, esperado 491', v_qtd; end if;
  if v_alunos <> 145       then raise exception 'ABORTADO G2: % alunos, esperado 145', v_alunos; end if;
  if v_acordos<> 145       then raise exception 'ABORTADO G3: % acordos, esperado 145', v_acordos; end if;
  if v_soma   <> 831136.87 then raise exception 'ABORTADO G4: soma %, esperado 831136.87', v_soma; end if;
  if v_hash   <> '5178651c5f5af0d68e9757c1af5bc296'
                           then raise exception 'ABORTADO G5: hash % -- o conjunto de ids mudou', v_hash; end if;
  if v_vinc   <> 491       then raise exception 'ABORTADO G6: % vinculos vivos, esperado 491', v_vinc; end if;
  if v_ac_parc<> 145       then raise exception 'ABORTADO G7: % acordos com parcela viva, esperado 145', v_ac_parc; end if;
  if v_prov   <> 0         then raise exception 'ABORTADO G8: % com origem_liquidacao -- nao sobrescrever proveniencia', v_prov; end if;
  if v_enc    <> 0         then raise exception 'ABORTADO G9: % com origem_encerramento -- saida administrativa tem porta propria', v_enc; end if;
  if v_nao_quitada <> 0    then raise exception 'ABORTADO G10: % sem status quitada -- par de colunas incoerente', v_nao_quitada; end if;
  if exists (select 1 from _mrpsl_alvo where audit_id_acordo is null)
                           then raise exception 'ABORTADO G11: titulo sem evento causal do acordo identificado'; end if;

  -- -------------------------------------------------------------------------
  -- 3) FOTOGRAFIA ANTES
  -- -------------------------------------------------------------------------
  select count(*) filter (where upper(coalesce(situacao,'')) = 'PAGO'),
         count(*) filter (where upper(coalesce(situacao,'')) = 'NEGOCIADO'),
         round(coalesce(sum(coalesce(valor_original,0)),0),2)
    into v_pago_antes, v_neg_antes, v_val_antes
    from public.acordos_titulos;
  select count(*) into v_parc_antes from public.parcelas;
  select count(*) into v_vinc_antes from public.acordo_titulo_vinculo;
  select count(*) into v_pag_antes  from public.pagamentos;
  select count(*) into v_ac_antes   from public.acordos;
  select count(*) into v_bx_antes   from public.baixas_pagamento;
  select round(coalesce(sum(public.saldo_cobravel_aluno(a.aluno_id)),0),2) into v_saldo_antes
    from (select distinct aluno_id from _mrpsl_alvo) a;

  if not p_confirmar then
    return jsonb_build_object(
      'ok', true, 'modo', 'PREVIA -- nada escrito', 'lote', v_lote,
      'titulos', v_qtd, 'alunos', v_alunos, 'acordos', v_acordos,
      'soma_valor_original', v_soma, 'hash_ids', v_hash,
      'vinculos_vivos', v_vinc, 'acordos_com_parcela_viva', v_ac_parc,
      'pago_global_antes', v_pago_antes, 'negociado_global_antes', v_neg_antes,
      'saldo_cobravel_dos_alunos', v_saldo_antes);
  end if;

  -- -------------------------------------------------------------------------
  -- 4) BACKUP LOGICO -- linha inteira, para reversao por id exato.
  --    Nao ha PITR neste projeto: o rollback E este backup.
  -- -------------------------------------------------------------------------
  if to_regclass('public._backup_pago_sem_lastro_20261001') is null then
    create table public._backup_pago_sem_lastro_20261001 as
      select t.*, v_lote as lote_backup, now() as backup_em
        from public.acordos_titulos t
       where t.id in (select titulo_id from _mrpsl_alvo);
    revoke insert, update, delete, truncate, references, trigger
      on public._backup_pago_sem_lastro_20261001 from authenticated;
  else
    raise exception 'ABORTADO: _backup_pago_sem_lastro_20261001 ja existe -- lote ja foi executado';
  end if;

  -- -------------------------------------------------------------------------
  -- 5) PROVENIENCIA RETROATIVA + PORTA, titulo por titulo
  -- -------------------------------------------------------------------------
  for v_t in select titulo_id from _mrpsl_alvo order by titulo_id loop
    -- A proveniencia e gravada SO onde a causalidade esta provada: o _em e o
    -- instante do evento causal REAL, nao now().
    update public.acordos_titulos t
       set origem_liquidacao     = 'ACORDO_QUITADO',
           origem_liquidacao_ref = a.acordo_id::text,
           origem_liquidacao_em  = a.quitado_em
      from _mrpsl_alvo a
     where t.id = v_t and a.titulo_id = v_t;

    -- A PORTA decide. Ela reconfere as nove guardas e chama titulo_reavaliar.
    v_r := public.titulo_reabrir_quitacao_por_acordo(v_t);
    if coalesce(v_r ->> 'ok','') <> 'true' then
      raise exception 'ABORTADO no titulo %: %', v_t, v_r;
    end if;
    v_ok := v_ok + 1;
  end loop;

  if v_ok <> 491 then
    raise exception 'ABORTADO: % titulos reabertos, esperado 491', v_ok;
  end if;

  -- -------------------------------------------------------------------------
  -- 6) POS-CONDICOES
  -- -------------------------------------------------------------------------
  select count(*) filter (where upper(coalesce(situacao,'')) = 'PAGO'),
         count(*) filter (where upper(coalesce(situacao,'')) = 'NEGOCIADO'),
         round(coalesce(sum(coalesce(valor_original,0)),0),2)
    into v_pago_depois, v_neg_depois, v_val_depois
    from public.acordos_titulos;
  select count(*) into v_parc_depois from public.parcelas;
  select count(*) into v_vinc_depois from public.acordo_titulo_vinculo;
  select count(*) into v_pag_depois  from public.pagamentos;
  select count(*) into v_ac_depois   from public.acordos;
  select count(*) into v_bx_depois   from public.baixas_pagamento;
  select round(coalesce(sum(public.saldo_cobravel_aluno(a.aluno_id)),0),2) into v_saldo_depois
    from (select distinct aluno_id from _mrpsl_alvo) a;

  select count(*) into v_mudou
    from public.acordos_titulos t
   where t.id in (select titulo_id from _mrpsl_alvo)
     and upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
     and lower(coalesce(t.status,''))   = 'vinculada'
     and t.origem_liquidacao is null;

  if v_mudou <> 491 then raise exception 'ABORTADO P1: % em NEGOCIADO/vinculada com trinca limpa, esperado 491', v_mudou; end if;
  if v_pago_depois <> v_pago_antes - 491 then raise exception 'ABORTADO P2: PAGO global % -> %, esperado -491', v_pago_antes, v_pago_depois; end if;
  if v_neg_depois  <> v_neg_antes  + 491 then raise exception 'ABORTADO P3: NEGOCIADO global % -> %, esperado +491', v_neg_antes, v_neg_depois; end if;
  if v_val_depois  <> v_val_antes        then raise exception 'ABORTADO P4: soma valor_original mudou: % -> %', v_val_antes, v_val_depois; end if;
  if v_parc_depois <> v_parc_antes       then raise exception 'ABORTADO P5: contagem de parcelas mudou'; end if;
  if v_vinc_depois <> v_vinc_antes       then raise exception 'ABORTADO P6: contagem de vinculos mudou'; end if;
  if v_pag_depois  <> v_pag_antes        then raise exception 'ABORTADO P7: contagem de pagamentos mudou'; end if;
  if v_ac_depois   <> v_ac_antes         then raise exception 'ABORTADO P8: contagem de acordos mudou'; end if;
  if v_bx_depois   <> v_bx_antes         then raise exception 'ABORTADO P9: contagem de baixas mudou'; end if;
  if v_saldo_depois<> v_saldo_antes      then raise exception 'ABORTADO P10: saldo cobravel dos alunos mudou: % -> %', v_saldo_antes, v_saldo_depois; end if;

  return jsonb_build_object(
    'ok', true, 'modo', 'EXECUTADO', 'lote', v_lote,
    'titulos_reabertos', v_ok, 'alunos', v_alunos, 'acordos', v_acordos,
    'soma_valor_original', v_soma, 'hash_ids', v_hash,
    'pago_global', jsonb_build_array(v_pago_antes, v_pago_depois),
    'negociado_global', jsonb_build_array(v_neg_antes, v_neg_depois),
    'saldo_cobravel_dos_alunos', jsonb_build_array(v_saldo_antes, v_saldo_depois),
    'backup', '_backup_pago_sem_lastro_20261001');
end;
$function$;

comment on function public.mensalidade_reconciliar_pago_sem_lastro(boolean) is
  'Saneamento do lote G2 (491 titulos PAGO com acordo ATIVO, hash 5178651c5f5af0d68e9757c1af5bc296). p_confirmar=false devolve a previa sem escrever. Grava proveniencia retroativa ACORDO_QUITADO com o _em do evento causal real e delega a decisao a titulo_reabrir_quitacao_por_acordo. Onze guardas de abertura e dez pos-condicoes; qualquer divergencia aborta a transacao inteira. CRIADA EM 01/10/2026, NAO EXECUTADA.';
