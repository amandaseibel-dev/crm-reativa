-- PILOTO -- autorização POR PÁGINA, e execução velha não mexe mais em nada
-- ============================================================================
--
-- O débito provisório de 1 na reserva fechava o buraco do orçamento entre
-- ALUNOS, mas não entre PÁGINAS: autorizado o aluno, a Edge paginava à vontade
-- e só no fim se descobria quanto tinha gasto. E uma execução antiga, mesmo
-- depois de outra assumir, ainda conseguia fechar itens.
--
-- Agora cada página pede autorização, e a autorização É o débito -- na mesma
-- transação. Negada, a chamada não acontece.

-- ---------------------------------------------------------------------------
-- 1. AUTORIZAR PÁGINA -- valida a execução e debita, atomicamente
-- ---------------------------------------------------------------------------
-- `for update` no lote serializa duas autorizações concorrentes: a segunda
-- espera a primeira somar, então nunca as duas leem o mesmo saldo. É o que
-- impede duas páginas de passarem com uma requisição restante.
create or replace function public.prime_academico_piloto_autorizar_pagina(
  p_item uuid, p_aluno_id uuid, p_execucao uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_item public.prime_academico_piloto_item;
  v_lote public.prime_academico_piloto_lote;
  v_gastas integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Acesso negado: apenas service_role.' using errcode = '42501';
  end if;

  select * into v_item from public.prime_academico_piloto_item where id = p_item;
  if v_item.id is null then return jsonb_build_object('ok', false, 'motivo', 'ITEM_INEXISTENTE'); end if;
  if v_item.aluno_id <> p_aluno_id then
    return jsonb_build_object('ok', false, 'motivo', 'ITEM_NAO_E_DESTE_ALUNO'); end if;
  if v_item.estado <> 'EM_PROCESSAMENTO' then
    return jsonb_build_object('ok', false, 'motivo', 'ITEM_NAO_RESERVADO:' || v_item.estado); end if;

  -- trava o lote: a soma abaixo tem de ser vista por uma autorização de cada vez
  select * into v_lote from public.prime_academico_piloto_lote
   where id = v_item.lote_id for update;

  if v_lote.estado = 'INTERROMPIDO' then
    return jsonb_build_object('ok', false, 'motivo', 'LOTE_INTERROMPIDO'); end if;
  if v_lote.execucao_id is null or v_lote.execucao_ate <= now() then
    return jsonb_build_object('ok', false, 'motivo', 'EXECUCAO_EXPIRADA'); end if;
  if p_execucao is null or p_execucao <> v_lote.execucao_id then
    return jsonb_build_object('ok', false, 'motivo', 'EXECUCAO_SUPERADA'); end if;

  v_gastas := public.prime_academico_piloto_gastas(v_item.lote_id);
  if v_gastas >= v_lote.limite_requisicoes then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_ORCAMENTO',
      'gastas', v_gastas, 'limite', v_lote.limite_requisicoes);
  end if;

  -- A AUTORIZAÇÃO É O DÉBITO. Some antes de a chamada sair: se a Edge morrer
  -- no meio, a requisição fica contada -- a API teria recebido de qualquer
  -- jeito, e contar a menos é o erro caro.
  update public.prime_academico_piloto_item
     set requisicoes = coalesce(requisicoes, 0) + 1
   where id = p_item;

  -- renova a concessão: uma paginação longa não pode perder o lote no meio
  update public.prime_academico_piloto_lote
     set execucao_ate = now() + interval '90 seconds' where id = v_lote.id;

  return jsonb_build_object('ok', true,
    'restante', v_lote.limite_requisicoes - (v_gastas + 1));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. REGISTRAR -- execução velha não fecha item
-- ---------------------------------------------------------------------------
drop function if exists public.prime_academico_piloto_registrar(uuid,uuid,integer,integer,text,uuid);

create or replace function public.prime_academico_piloto_registrar(
  p_item uuid, p_consulta_id uuid, p_requisicoes integer,
  p_http integer default null, p_erro text default null,
  p_aluno_id uuid default null, p_execucao uuid default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_item public.prime_academico_piloto_item;
  v_lote public.prime_academico_piloto_lote;
  v_parar boolean := false;
  v_motivo text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Acesso negado: apenas service_role.' using errcode = '42501';
  end if;

  select * into v_item from public.prime_academico_piloto_item where id = p_item for update;
  if v_item.id is null then
    raise exception 'item de piloto inexistente' using errcode = '22023';
  end if;
  if p_aluno_id is not null and v_item.aluno_id <> p_aluno_id then
    raise exception 'item nao pertence a este aluno' using errcode = '22023';
  end if;

  select * into v_lote from public.prime_academico_piloto_lote where id = v_item.lote_id;

  -- EXECUÇÃO VELHA NÃO FECHA ITEM. Depois que outra aba assumiu, a anterior
  -- ainda podia chegar atrasada e marcar CONCLUIDO por cima -- inclusive
  -- ressuscitando um lote que já tinha parado. O gasto dela já foi contado
  -- pela autorização de página; o que se recusa aqui é o fechamento.
  if p_execucao is not null
     and (v_lote.execucao_id is null or p_execucao <> v_lote.execucao_id) then
    return jsonb_build_object('parar', true, 'recusado', true, 'motivo', 'EXECUCAO_SUPERADA');
  end if;

  if v_item.estado in ('CONCLUIDO','PULADO') then
    return jsonb_build_object('parar', false, 'ja_registrado', true);
  end if;

  update public.prime_academico_piloto_item
     set estado = case when p_erro is null then 'CONCLUIDO' else 'FALHOU' end,
         consulta_id = p_consulta_id,
         -- nunca ABAIXO do que a autorização por página já debitou: o gasto
         -- real é o maior entre o contado e o informado.
         requisicoes = greatest(coalesce(p_requisicoes, 0), coalesce(requisicoes, 0), 1),
         erro = p_erro, processado_em = now()
   where id = p_item;

  if p_http in (401, 403, 429) then
    v_parar := true;
    v_motivo := 'API respondeu ' || p_http || ' -- limitacao; lote interrompido';
  end if;

  update public.prime_academico_piloto_lote
     set estado = case when v_parar then 'INTERROMPIDO' else 'EM_ANDAMENTO' end,
         motivo = coalesce(v_motivo, motivo),
         execucao_id = case when v_parar then null else execucao_id end,
         execucao_ate = case when v_parar then null else execucao_ate end,
         encerrado_em = case when v_parar then now() else encerrado_em end
   where id = v_item.lote_id;

  if not v_parar and not exists (
      select 1 from public.prime_academico_piloto_item
       where lote_id = v_item.lote_id and estado in ('PENDENTE','EM_PROCESSAMENTO')) then
    update public.prime_academico_piloto_lote
       set estado = 'CONCLUIDO', encerrado_em = now(), execucao_id = null, execucao_ate = null
     where id = v_item.lote_id;
  end if;

  return jsonb_build_object('parar', v_parar, 'motivo', v_motivo);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. PRÓXIMO -- um item em voo por lote, e sem débito provisório
-- ---------------------------------------------------------------------------
-- O débito saiu daqui: quem debita agora é a autorização de página. E entra a
-- trava que faltava -- NENHUM item novo enquanto houver consulta em andamento
-- no lote. Sem ela, um `proximo` chamado duas vezes em sequência colocava dois
-- alunos em voo ao mesmo tempo.
create or replace function public.prime_academico_piloto_proximo(
  p_lote uuid, p_execucao uuid default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_lote public.prime_academico_piloto_lote;
  v_gastas integer;
  v_pulados integer;
  v_rec jsonb;
  v_item public.prime_academico_piloto_item;
  v_em_voo integer;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  v_rec := public.prime_academico_piloto_reconciliar(p_lote);

  select * into v_lote from public.prime_academico_piloto_lote where id = p_lote for update;
  if v_lote.id is null then
    return jsonb_build_object('parar', true, 'motivo', 'lote inexistente'); end if;
  if v_lote.estado in ('CONCLUIDO','INTERROMPIDO') then
    return jsonb_build_object('parar', true, 'motivo', coalesce(v_lote.motivo, v_lote.estado),
                              'reconciliacao', v_rec); end if;
  if v_lote.execucao_id is null or v_lote.execucao_ate <= now() then
    return jsonb_build_object('parar', true, 'motivo', 'execucao expirada; inicie o lote de novo',
                              'reconciliacao', v_rec); end if;
  if p_execucao is null or p_execucao <> v_lote.execucao_id then
    return jsonb_build_object('parar', true, 'motivo', 'outra execucao esta conduzindo este lote',
                              'reconciliacao', v_rec); end if;

  -- UM DE CADA VEZ, no lote inteiro.
  select count(*) into v_em_voo from public.prime_academico_piloto_item
   where lote_id = p_lote and estado = 'EM_PROCESSAMENTO';
  if v_em_voo > 0 then
    return jsonb_build_object('parar', true, 'motivo',
      'ja existe consulta em andamento neste lote', 'reconciliacao', v_rec);
  end if;

  update public.prime_academico_piloto_item i
     set estado = 'PULADO', erro = 'ja consultado pela ficha depois de o lote ser preparado',
         requisicoes = 0, processado_em = now()
   where i.lote_id = p_lote and i.estado = 'PENDENTE'
     and exists (select 1 from public.prime_academico_consulta c where c.aluno_id = i.aluno_id);
  get diagnostics v_pulados = row_count;

  v_gastas := public.prime_academico_piloto_gastas(p_lote);
  if v_lote.limite_requisicoes - v_gastas <= 0 then
    update public.prime_academico_piloto_lote
       set estado = 'INTERROMPIDO', encerrado_em = now(), execucao_id = null, execucao_ate = null,
           motivo = 'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes
     where id = p_lote;
    return jsonb_build_object('parar', true, 'reconciliacao', v_rec, 'pulados_agora', v_pulados,
      'motivo', 'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes);
  end if;

  update public.prime_academico_piloto_item
     set estado = 'EM_PROCESSAMENTO', reservado_em = now(),
         tentativas = tentativas + 1, requisicoes = 0
   where id = (
     select i.id from public.prime_academico_piloto_item i
      where i.lote_id = p_lote and i.estado = 'PENDENTE'
      order by i.ordem for update skip locked limit 1)
   returning * into v_item;

  if v_item.id is null then
    if not exists (select 1 from public.prime_academico_piloto_item
                    where lote_id = p_lote and estado in ('PENDENTE','EM_PROCESSAMENTO')) then
      update public.prime_academico_piloto_lote
         set estado = 'CONCLUIDO', encerrado_em = now(), execucao_id = null, execucao_ate = null
       where id = p_lote and estado <> 'INTERROMPIDO';
      return jsonb_build_object('parar', true, 'motivo', 'fila vazia', 'reconciliacao', v_rec);
    end if;
    return jsonb_build_object('parar', true, 'motivo', 'itens em processamento em outra aba',
                              'reconciliacao', v_rec);
  end if;

  update public.prime_academico_piloto_lote
     set execucao_ate = now() + interval '90 seconds' where id = p_lote;

  return jsonb_build_object(
    'parar', false, 'item_id', v_item.id, 'aluno_id', v_item.aluno_id, 'ordem', v_item.ordem,
    'orcamento', v_lote.limite_requisicoes - v_gastas,
    'requisicoes_gastas', v_gastas, 'limite_requisicoes', v_lote.limite_requisicoes,
    'pulados_agora', v_pulados, 'reconciliacao', v_rec);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. PERMISSÕES
-- ---------------------------------------------------------------------------
revoke all on function public.prime_academico_piloto_autorizar_pagina(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.prime_academico_piloto_registrar(uuid,uuid,integer,integer,text,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.prime_academico_piloto_autorizar_pagina(uuid,uuid,uuid) to service_role;
grant execute on function public.prime_academico_piloto_registrar(uuid,uuid,integer,integer,text,uuid,uuid) to service_role;
