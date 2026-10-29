-- FILA MANUAL DE PAGAMENTOS: DUAS ACOES DE FINALIZACAO -- FEITO E REJEITAR
--
-- A fila tinha UMA finalizacao, `conciliacao_encerrar`, com observacao livre e
-- sem categoria. A gestao pediu duas saidas distintas, cada uma com motivo
-- estruturado:
--
--   FEITO     -- a conferencia terminou e o caso esta resolvido/classificado.
--   REJEITAR  -- a hipotese do sistema esta errada ou nao pode ser aceita.
--
-- AS DUAS SO ESCREVEM A DECISAO DA FILA. Nao baixam parcela, nao mexem em
-- acordo, saldo, mensalidade, nao criam vinculo financeiro e NAO DESFAZEM
-- PAGAMENTO. Rejeitar e uma decisao de revisao, nao um estorno -- isso esta
-- dito no codigo, na auditoria (`sem_efeito_financeiro`) e no retorno.
--
-- POR QUE VALORES NOVOS EM `decisao`, E POR QUE ISSO E SEGURO
-- Auditei quem le a coluna antes de mexer: **19 funcoes filtram por
-- `decisao is null`** -- e e so isso que define "pendente". Nenhuma ramifica
-- lendo o valor de outra; as 5 que citam valores especificos citam apenas os
-- que elas proprias escrevem. `pagamentos_sem_aluno` faz
-- `left join ... and f.decisao is null`, entao a linha sai da fila ativa
-- sozinha. Nenhuma view depende da coluna, e o front nao usa nenhum valor
-- literalmente. Acrescentar FEITO e REJEITADO nao muda o comportamento de nada
-- que ja existe.
--
-- CATALOGO FIXO, por decisao da gestao em 23/09/2026: as opcoes vivem numa
-- restricao do banco, nao numa tabela editavel. Impede valor inventado e deixa
-- a lista auditavel. Mudar a lista exige migration -- que e o preco aceito.
--
-- `conciliacao_encerrar` CONTINUA EXISTINDO: sai da tela, mas segue disponivel
-- para as rotinas e para nao invalidar os 6 casos ja encerrados por ela.

-- === 1. CATALOGOS ===========================================================

alter table public.fila_pagamento_sem_vinculo
  add column if not exists conclusao       text,
  add column if not exists motivo_rejeicao text;

comment on column public.fila_pagamento_sem_vinculo.conclusao is
  'Conclusao escolhida no FEITO. Catalogo fechado; NULL em qualquer outra decisao.';
comment on column public.fila_pagamento_sem_vinculo.motivo_rejeicao is
  'Motivo obrigatorio do REJEITAR. Catalogo fechado; NULL em qualquer outra decisao.';

alter table public.fila_pagamento_sem_vinculo
  drop constraint if exists fila_pag_conclusao_valida;
alter table public.fila_pagamento_sem_vinculo
  add constraint fila_pag_conclusao_valida check (
    conclusao is null or conclusao = any (array[
      'ENTRADA_DE_ACORDO',        -- confirmado como entrada de acordo
      'PARCELA_DE_ACORDO',        -- confirmado como parcela de acordo
      'JA_TRATADO',               -- pagamento ja tratado corretamente
      'SEM_IMPACTO_FINANCEIRO',   -- sem impacto financeiro atual
      'OUTRO_CONFIRMADO'          -- outro motivo confirmado (exige observacao)
    ]));

alter table public.fila_pagamento_sem_vinculo
  drop constraint if exists fila_pag_motivo_rejeicao_valido;
alter table public.fila_pagamento_sem_vinculo
  add constraint fila_pag_motivo_rejeicao_valido check (
    motivo_rejeicao is null or motivo_rejeicao = any (array[
      'NAO_E_ENTRADA_DE_ACORDO',  -- nao e entrada de acordo
      'NAO_PERTENCE_AO_ACORDO',   -- nao pertence ao acordo indicado
      'SEM_ESTRUTURA_SUFICIENTE', -- pagamento sem estrutura suficiente
      'DOCUMENTO_INCOMPATIVEL',   -- boleto/documento incompativel
      'VALOR_INCOMPATIVEL',       -- valor incompativel
      'OUTRO'                     -- outro (exige observacao)
    ]));

-- === 2. DECISAO ACEITA OS DOIS ESTADOS NOVOS ================================

alter table public.fila_pagamento_sem_vinculo
  drop constraint if exists fila_pagamento_sem_vinculo_decisao_check;
alter table public.fila_pagamento_sem_vinculo
  add constraint fila_pagamento_sem_vinculo_decisao_check check (
    decisao is null or decisao = any (array[
      'VINCULADO','DESCARTADO','AGUARDANDO_TERCEIRO',
      'RESOLVIDO_AUTOMATICO','ENCERRADO_GESTAO',
      'FEITO','REJEITADO']));

-- COERENCIA, NO BANCO E NAO SO NA RPC. Um FEITO sem conclusao ou um REJEITADO
-- sem motivo e exatamente o que a gestao pediu para nao existir -- entao a
-- regra mora na tabela, onde nenhum caminho de escrita escapa dela.
alter table public.fila_pagamento_sem_vinculo
  drop constraint if exists fila_pag_decisao_coerente;
alter table public.fila_pagamento_sem_vinculo
  add constraint fila_pag_decisao_coerente check (
    case
      when decisao = 'FEITO'     then conclusao is not null and motivo_rejeicao is null
      when decisao = 'REJEITADO' then motivo_rejeicao is not null and conclusao is null
      else conclusao is null and motivo_rejeicao is null
    end);

-- === 3. AS DUAS ACOES =======================================================

create or replace function public.conciliacao_feito(
  p_pagamento_id uuid,
  p_conclusao    text,
  p_observacao   text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_email text; v_n int := 0; v_st text; v_antes jsonb; v_obs text;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Concluir pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  if coalesce(trim(p_conclusao),'') = '' then
    raise exception 'FEITO exige a conclusao escolhida.' using errcode = '23514';
  end if;
  v_obs := nullif(trim(coalesce(p_observacao,'')), '');
  -- "Outro" sem explicacao nao conclui nada: viraria uma linha encerrada que
  -- ninguem consegue reler depois.
  if p_conclusao = 'OUTRO_CONFIRMADO' and v_obs is null then
    raise exception 'A conclusao "outro motivo confirmado" exige observacao.' using errcode = '23514';
  end if;

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO'); end if;
  if v_st = 'BAIXADO' then return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO'); end if;

  select jsonb_build_object(
           'status_conciliacao', v_st,
           'conciliacao_motivo', (select p.conciliacao_motivo from public.pagamentos p where p.id = p_pagamento_id),
           'fila', (select jsonb_build_object('motivo', f.motivo, 'status_conciliacao', f.status_conciliacao,
                      'detectado_em', f.detectado_em, 'observacao', f.observacao, 'decisao', f.decisao,
                      'quantidade_tentativas', f.quantidade_tentativas,
                      'primeira_tentativa_em', f.primeira_tentativa_em)
                      from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id))
    into v_antes;

  if not exists (select 1 from public.fila_pagamento_sem_vinculo f
                  where f.pagamento_id = p_pagamento_id and f.decisao is null) then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PENDENCIA_ABERTA',
      'status_conciliacao', v_st, 'estado_anterior', v_antes);
  end if;

  -- A UNICA ESCRITA E A DECISAO DA FILA.
  update public.fila_pagamento_sem_vinculo
     set decisao = 'FEITO',
         conclusao = p_conclusao,
         decidido_por = coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao'),
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'concluido pela gestao (' || p_conclusao || ')'
           || case when v_obs is null then '' else ': ' || v_obs end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'CONCLUSAO_ABORTADA: a linha da fila mudou durante a conclusao (% linhas)', v_n;
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CONCILIACAO_FEITO_PELA_GESTAO', 'fila_pagamento_sem_vinculo', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'estado_anterior', v_antes,
                             'conclusao', p_conclusao, 'observacao', v_obs,
                             'decisao', 'FEITO', 'sem_efeito_financeiro', true));

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n,
                            'decisao', 'FEITO', 'conclusao', p_conclusao, 'estado_anterior', v_antes);
end;
$fn$;

create or replace function public.conciliacao_rejeitar(
  p_pagamento_id uuid,
  p_motivo       text,
  p_observacao   text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_email text; v_n int := 0; v_st text; v_antes jsonb; v_obs text;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Rejeitar pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  -- MOTIVO OBRIGATORIO, conforme a gestao pediu: rejeitar sem dizer por que
  -- fecha a linha e perde a informacao que justificou fechar.
  if coalesce(trim(p_motivo),'') = '' then
    raise exception 'REJEITAR exige motivo.' using errcode = '23514';
  end if;
  v_obs := nullif(trim(coalesce(p_observacao,'')), '');
  if p_motivo = 'OUTRO' and v_obs is null then
    raise exception 'O motivo "outro" exige observacao.' using errcode = '23514';
  end if;

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO'); end if;
  if v_st = 'BAIXADO' then return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO'); end if;

  select jsonb_build_object(
           'status_conciliacao', v_st,
           'conciliacao_motivo', (select p.conciliacao_motivo from public.pagamentos p where p.id = p_pagamento_id),
           'fila', (select jsonb_build_object('motivo', f.motivo, 'status_conciliacao', f.status_conciliacao,
                      'detectado_em', f.detectado_em, 'observacao', f.observacao, 'decisao', f.decisao,
                      'quantidade_tentativas', f.quantidade_tentativas,
                      'primeira_tentativa_em', f.primeira_tentativa_em)
                      from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id))
    into v_antes;

  if not exists (select 1 from public.fila_pagamento_sem_vinculo f
                  where f.pagamento_id = p_pagamento_id and f.decisao is null) then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PENDENCIA_ABERTA',
      'status_conciliacao', v_st, 'estado_anterior', v_antes);
  end if;

  -- REJEITAR NAO APAGA E NAO DESFAZ PAGAMENTO. A unica escrita e a decisao.
  update public.fila_pagamento_sem_vinculo
     set decisao = 'REJEITADO',
         motivo_rejeicao = p_motivo,
         decidido_por = coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao'),
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'rejeitado pela gestao (' || p_motivo || ')'
           || case when v_obs is null then '' else ': ' || v_obs end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'REJEICAO_ABORTADA: a linha da fila mudou durante a rejeicao (% linhas)', v_n;
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CONCILIACAO_REJEITADA_PELA_GESTAO', 'fila_pagamento_sem_vinculo', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'estado_anterior', v_antes,
                             'motivo_rejeicao', p_motivo, 'observacao', v_obs,
                             'decisao', 'REJEITADO', 'sem_efeito_financeiro', true,
                             'pagamento_preservado', true));

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n,
                            'decisao', 'REJEITADO', 'motivo_rejeicao', p_motivo, 'estado_anterior', v_antes);
end;
$fn$;

revoke all on function public.conciliacao_feito(uuid, text, text) from public;
revoke all on function public.conciliacao_rejeitar(uuid, text, text) from public;
grant execute on function public.conciliacao_feito(uuid, text, text) to authenticated;
grant execute on function public.conciliacao_rejeitar(uuid, text, text) to authenticated;
