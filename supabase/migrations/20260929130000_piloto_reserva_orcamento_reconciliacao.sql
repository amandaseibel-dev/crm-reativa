-- PILOTO -- reserva no servidor, orçamento por chamada e reconciliação
-- ============================================================================
--
-- Quatro buracos que a revisão apontou, e todos eram reais:
--
--   1. duas abas pegavam o MESMO item e consultavam o mesmo aluno duas vezes;
--   2. o orçamento de requisições era conferido só ANTES do aluno, então uma
--      paginação longa passava por cima do teto;
--   3. se a consulta fosse gravada e o registro do item falhasse, o item ficava
--      PENDENTE para sempre -- e retomar refazia a chamada ao Prime;
--   4. nada validava que o item pertencia ao lote e ao aluno informado.
--
-- A correção comum às quatro: o servidor passa a RESERVAR o item antes da
-- consulta, e a reserva é a unidade de trabalho.

-- ---------------------------------------------------------------------------
-- 1. ESTADO DE RESERVA
-- ---------------------------------------------------------------------------
alter table public.prime_academico_piloto_item
  drop constraint if exists prime_academico_piloto_item_estado_check;

alter table public.prime_academico_piloto_item
  add constraint prime_academico_piloto_item_estado_check
  check (estado in ('PENDENTE','EM_PROCESSAMENTO','CONCLUIDO','FALHOU','PULADO'));

alter table public.prime_academico_piloto_item
  add column if not exists reservado_em timestamptz,
  add column if not exists tentativas integer not null default 0;

comment on column public.prime_academico_piloto_item.reservado_em is
  'Instante da reserva. EM_PROCESSAMENTO com reserva velha e retomavel: ou a consulta foi gravada (reconcilia) ou nao foi (volta para PENDENTE).';

-- ---------------------------------------------------------------------------
-- 2. RECONCILIAR -- antes de qualquer coisa, acertar o que ficou no meio
-- ---------------------------------------------------------------------------
-- Dois casos de item preso em EM_PROCESSAMENTO:
--
--   a) a consulta FOI gravada e o registro do item falhou (ou a aba morreu
--      entre uma coisa e outra). Aqui o trabalho já foi feito e já foi pago em
--      requisições -- refazer a chamada ao Prime seria gastar de novo. O item
--      vira CONCLUIDO com a consulta que existe, e a contagem de requisições
--      vem DELA, não de um chute;
--   b) não há consulta nenhuma depois da reserva: nada foi gasto, e o item
--      volta para PENDENTE.
--
-- A janela de 3 minutos é maior que qualquer consulta observada (a mais lenta
-- mediu ~4 s); serve só para não reconciliar um item que ainda está em voo.
create or replace function public.prime_academico_piloto_reconciliar(p_lote uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_recuperados integer := 0;
  v_devolvidos integer := 0;
begin
  -- (a) consulta gravada depois da reserva: fecha o item com ELA.
  with achados as (
    select i.id item_id, c.id consulta_id, coalesce(c.requisicoes, 1) req
      from public.prime_academico_piloto_item i
      join lateral (
        select c.id, c.requisicoes from public.prime_academico_consulta c
         where c.aluno_id = i.aluno_id
           and c.consultado_em >= i.reservado_em
         order by c.consultado_em desc, c.id desc limit 1
      ) c on true
     where i.lote_id = p_lote and i.estado = 'EM_PROCESSAMENTO'
       and i.reservado_em is not null
  )
  update public.prime_academico_piloto_item i
     set estado = 'CONCLUIDO', consulta_id = a.consulta_id,
         requisicoes = a.req, processado_em = now(),
         erro = 'reconciliado: consulta ja estava gravada'
    from achados a where i.id = a.item_id;
  get diagnostics v_recuperados = row_count;

  -- (b) sem consulta e com reserva velha: nada foi gasto, volta para a fila.
  update public.prime_academico_piloto_item i
     set estado = 'PENDENTE', reservado_em = null
   where i.lote_id = p_lote and i.estado = 'EM_PROCESSAMENTO'
     and i.reservado_em < now() - interval '3 minutes';
  get diagnostics v_devolvidos = row_count;

  return jsonb_build_object('reconciliados', v_recuperados, 'devolvidos', v_devolvidos);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. PRÓXIMO -- reserva atômica, e devolve o ORÇAMENTO restante
-- ---------------------------------------------------------------------------
-- `for update skip locked` é o que impede duas abas de pegarem o mesmo item:
-- a segunda não espera a primeira, simplesmente pula para o próximo. Sem isso,
-- as duas consultariam o mesmo aluno e gastariam o dobro.
create or replace function public.prime_academico_piloto_proximo(p_lote uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_lote public.prime_academico_piloto_lote;
  v_gastas integer;
  v_orcamento integer;
  v_pulados integer;
  v_rec jsonb;
  v_item public.prime_academico_piloto_item;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  select * into v_lote from public.prime_academico_piloto_lote where id = p_lote;
  if v_lote.id is null then
    return jsonb_build_object('parar', true, 'motivo', 'lote inexistente');
  end if;

  -- Reconciliar ANTES de olhar o orçamento: uma consulta paga e não
  -- contabilizada faria o teto parecer maior do que é.
  v_rec := public.prime_academico_piloto_reconciliar(p_lote);

  if v_lote.estado in ('CONCLUIDO','INTERROMPIDO') then
    return jsonb_build_object('parar', true, 'motivo', coalesce(v_lote.motivo, v_lote.estado),
                              'reconciliacao', v_rec);
  end if;

  -- Pula quem a ficha já consultou desde que o lote foi preparado.
  update public.prime_academico_piloto_item i
     set estado = 'PULADO', erro = 'ja consultado pela ficha depois de o lote ser preparado',
         requisicoes = 0, processado_em = now()
   where i.lote_id = p_lote and i.estado = 'PENDENTE'
     and exists (select 1 from public.prime_academico_consulta c where c.aluno_id = i.aluno_id);
  get diagnostics v_pulados = row_count;

  select coalesce(sum(requisicoes), 0) into v_gastas
    from public.prime_academico_piloto_item where lote_id = p_lote;
  v_orcamento := v_lote.limite_requisicoes - v_gastas;

  if v_orcamento <= 0 then
    update public.prime_academico_piloto_lote
       set estado = 'INTERROMPIDO', encerrado_em = now(),
           motivo = 'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes
     where id = p_lote;
    return jsonb_build_object('parar', true, 'reconciliacao', v_rec, 'pulados_agora', v_pulados,
      'motivo', 'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes);
  end if;

  -- RESERVA ATÔMICA.
  update public.prime_academico_piloto_item
     set estado = 'EM_PROCESSAMENTO', reservado_em = now(), tentativas = tentativas + 1
   where id = (
     select i.id from public.prime_academico_piloto_item i
      where i.lote_id = p_lote and i.estado = 'PENDENTE'
      order by i.ordem
      for update skip locked
      limit 1)
   returning * into v_item;

  if v_item.id is null then
    -- Só conclui se não houver ninguém em voo: um item reservado agora ainda
    -- vai virar CONCLUIDO, e fechar o lote aqui perderia esse resultado.
    if not exists (select 1 from public.prime_academico_piloto_item
                    where lote_id = p_lote and estado in ('PENDENTE','EM_PROCESSAMENTO')) then
      update public.prime_academico_piloto_lote
         set estado = 'CONCLUIDO', encerrado_em = now()
       where id = p_lote and estado <> 'INTERROMPIDO';
      return jsonb_build_object('parar', true, 'motivo', 'fila vazia', 'reconciliacao', v_rec);
    end if;
    return jsonb_build_object('parar', true, 'motivo', 'itens em processamento em outra aba',
                              'reconciliacao', v_rec);
  end if;

  update public.prime_academico_piloto_lote
     set estado = 'EM_ANDAMENTO' where id = p_lote and estado = 'PRONTO';

  return jsonb_build_object(
    'parar', false, 'item_id', v_item.id, 'aluno_id', v_item.aluno_id, 'ordem', v_item.ordem,
    'orcamento', v_orcamento, 'requisicoes_gastas', v_gastas,
    'limite_requisicoes', v_lote.limite_requisicoes,
    'pulados_agora', v_pulados, 'reconciliacao', v_rec);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. VALIDAR -- o servidor confere o par item↔aluno e devolve o orçamento
-- ---------------------------------------------------------------------------
-- Chamada pela Edge ANTES de gastar a primeira requisição. O orçamento vem
-- daqui, não do navegador: quem manda o pedido não pode escolher o próprio
-- teto.
create or replace function public.prime_academico_piloto_validar(
  p_item uuid, p_aluno_id uuid
) returns jsonb
language plpgsql
stable
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
  if v_item.id is null then
    return jsonb_build_object('ok', false, 'motivo', 'ITEM_INEXISTENTE');
  end if;
  if v_item.aluno_id <> p_aluno_id then
    return jsonb_build_object('ok', false, 'motivo', 'ITEM_NAO_E_DESTE_ALUNO');
  end if;
  if v_item.estado <> 'EM_PROCESSAMENTO' then
    return jsonb_build_object('ok', false, 'motivo', 'ITEM_NAO_RESERVADO:' || v_item.estado);
  end if;

  select * into v_lote from public.prime_academico_piloto_lote where id = v_item.lote_id;
  if v_lote.estado = 'INTERROMPIDO' then
    return jsonb_build_object('ok', false, 'motivo', 'LOTE_INTERROMPIDO');
  end if;

  select coalesce(sum(requisicoes), 0) into v_gastas
    from public.prime_academico_piloto_item where lote_id = v_item.lote_id;

  return jsonb_build_object('ok', true, 'lote_id', v_lote.id,
                            'orcamento', greatest(v_lote.limite_requisicoes - v_gastas, 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. REGISTRAR -- exige reserva, e valida o par
-- ---------------------------------------------------------------------------
drop function if exists public.prime_academico_piloto_registrar(uuid,uuid,integer,integer,text);

create or replace function public.prime_academico_piloto_registrar(
  p_item uuid, p_consulta_id uuid, p_requisicoes integer,
  p_http integer default null, p_erro text default null,
  p_aluno_id uuid default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_item public.prime_academico_piloto_item;
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
  -- IDEMPOTENTE: registrar de novo um item já fechado não duplica nem
  -- reescreve a contagem -- é o que faz a reconciliação ser segura.
  if v_item.estado in ('CONCLUIDO','PULADO') then
    return jsonb_build_object('parar', false, 'ja_registrado', true);
  end if;

  update public.prime_academico_piloto_item
     set estado = case when p_erro is null then 'CONCLUIDO' else 'FALHOU' end,
         consulta_id = p_consulta_id,
         requisicoes = greatest(coalesce(p_requisicoes, 1), 1),
         erro = p_erro, processado_em = now()
   where id = p_item;

  if p_http in (401, 403, 429) then
    v_parar := true;
    v_motivo := 'API respondeu ' || p_http || ' -- limitacao; lote interrompido';
  end if;

  update public.prime_academico_piloto_lote
     set estado = case when v_parar then 'INTERROMPIDO' else 'EM_ANDAMENTO' end,
         motivo = coalesce(v_motivo, motivo),
         encerrado_em = case when v_parar then now() else encerrado_em end
   where id = v_item.lote_id;

  if not v_parar and not exists (
      select 1 from public.prime_academico_piloto_item
       where lote_id = v_item.lote_id and estado in ('PENDENTE','EM_PROCESSAMENTO')) then
    update public.prime_academico_piloto_lote
       set estado = 'CONCLUIDO', encerrado_em = now() where id = v_item.lote_id;
  end if;

  return jsonb_build_object('parar', v_parar, 'motivo', v_motivo);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. PERMISSÕES
-- ---------------------------------------------------------------------------
revoke all on function public.prime_academico_piloto_reconciliar(uuid) from public, anon;
revoke all on function public.prime_academico_piloto_validar(uuid,uuid) from public, anon, authenticated;
revoke all on function public.prime_academico_piloto_registrar(uuid,uuid,integer,integer,text,uuid)
  from public, anon, authenticated;
grant execute on function public.prime_academico_piloto_reconciliar(uuid) to authenticated, service_role;
grant execute on function public.prime_academico_piloto_validar(uuid,uuid) to service_role;
grant execute on function public.prime_academico_piloto_registrar(uuid,uuid,integer,integer,text,uuid) to service_role;
