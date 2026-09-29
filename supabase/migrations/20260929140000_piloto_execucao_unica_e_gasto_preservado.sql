-- PILOTO -- uma execução por lote, gasto preservado e reconciliação protegida
-- ============================================================================
--
-- Três buracos que a revisão do SHA e133078 achou, e os três são reais:
--
--   1. duas abas recebiam o MESMO orçamento restante. A reserva impedia que
--      pegassem o mesmo ITEM, mas nada impedia que gastassem o mesmo saldo:
--      com 1 requisição sobrando, as duas começavam e o teto era furado.
--   2. requisição gasta sumia quando a gravação falhava -- e sumia de novo
--      quando o item voltava para a fila. O teto passava a contar menos do que
--      a API realmente recebeu.
--   3. `prime_academico_piloto_reconciliar` era SECURITY DEFINER sem checagem
--      interna: qualquer `authenticated` chamava e mexia em lote alheio.

-- ---------------------------------------------------------------------------
-- 1. EXECUÇÃO ÚNICA POR LOTE
-- ---------------------------------------------------------------------------
-- Uma aba "segura" o lote por um tempo curto e renova a cada item. Se a aba
-- morrer, a concessão vence sozinha e outra pode assumir -- sem precisar de
-- ninguém destravar nada à mão.
alter table public.prime_academico_piloto_lote
  add column if not exists execucao_id uuid,
  add column if not exists execucao_ate timestamptz;

comment on column public.prime_academico_piloto_lote.execucao_ate is
  'Concessao da execucao. Enquanto vale, so quem tem o execucao_id pede o proximo item. Vence sozinha se a aba morrer.';

-- ---------------------------------------------------------------------------
-- 2. GASTO PRESERVADO ENTRE TENTATIVAS
-- ---------------------------------------------------------------------------
-- `requisicoes` é o gasto da tentativa ATUAL (provisório na reserva, real no
-- registro). `gasto_anterior` acumula o que tentativas passadas já gastaram --
-- e requisição gasta não volta: a API recebeu a chamada, e o teto tem de
-- lembrar disso mesmo que o item seja refeito.
alter table public.prime_academico_piloto_item
  add column if not exists gasto_anterior integer not null default 0;

comment on column public.prime_academico_piloto_item.gasto_anterior is
  'Requisicoes que tentativas ANTERIORES deste item ja gastaram. Somado ao orcamento: gasto nao volta so porque o item foi refeito.';

-- O orçamento passa a ser contado por esta função, e não por `sum(requisicoes)`
-- espalhado em três lugares -- que era como as contagens divergiam.
create or replace function public.prime_academico_piloto_gastas(p_lote uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(sum(coalesce(requisicoes, 0) + gasto_anterior), 0)::int
    from public.prime_academico_piloto_item where lote_id = p_lote;
$$;

-- ---------------------------------------------------------------------------
-- 3. RECONCILIAR -- agora com portão
-- ---------------------------------------------------------------------------
-- Era SECURITY DEFINER sem checagem: `authenticated` entrava e mexia em lote
-- de qualquer um. Agora exige gestão (a tela) ou service_role (a Edge).
--
-- E a INTERRUPÇÃO POR LIMITAÇÃO vale aqui também: se a consulta encontrada for
-- uma falha 401/403/429, o lote para. Sem isto, um item reconciliado
-- silenciosamente ressuscitava um lote que a API já tinha mandado parar.
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
  v_limitou integer := 0;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  -- (a) consulta gravada depois da reserva: fecha o item com ELA, e a contagem
  --     vem da consulta -- nunca de um chute.
  with achados as (
    select i.id item_id, c.id consulta_id, coalesce(c.requisicoes, 1) req,
           c.resultado, c.http_status
      from public.prime_academico_piloto_item i
      join lateral (
        select c.id, c.requisicoes, c.resultado, c.http_status
          from public.prime_academico_consulta c
         where c.aluno_id = i.aluno_id and c.consultado_em >= i.reservado_em
         order by c.consultado_em desc, c.id desc limit 1
      ) c on true
     where i.lote_id = p_lote and i.estado = 'EM_PROCESSAMENTO'
       and i.reservado_em is not null
  ),
  fechados as (
    update public.prime_academico_piloto_item i
       set estado = case when a.resultado = 'FALHA_COMUNICACAO' then 'FALHOU' else 'CONCLUIDO' end,
           consulta_id = a.consulta_id,
           requisicoes = a.req,
           processado_em = now(),
           erro = 'reconciliado: consulta ja estava gravada'
      from achados a where i.id = a.item_id
      returning a.http_status
  )
  select count(*), count(*) filter (where http_status in (401,403,429))
    into v_recuperados, v_limitou from fechados;

  -- LIMITAÇÃO ENCONTRADA NA RECONCILIAÇÃO interrompe o lote. A API já disse
  -- "pare" -- reconciliar não pode servir de porta dos fundos para continuar.
  if v_limitou > 0 then
    update public.prime_academico_piloto_lote
       set estado = 'INTERROMPIDO', encerrado_em = now(),
           execucao_id = null, execucao_ate = null,
           motivo = 'limitacao da API encontrada na reconciliacao (401/403/429)'
     where id = p_lote and estado <> 'INTERROMPIDO';
  end if;

  -- (b) sem consulta e com reserva velha: o item volta para a fila, mas o que
  --     ele já gastou FICA CONTADO. Zerar aqui faria o teto acreditar que
  --     aquelas chamadas nunca aconteceram.
  update public.prime_academico_piloto_item
     set estado = 'PENDENTE',
         gasto_anterior = gasto_anterior + coalesce(requisicoes, 0),
         requisicoes = null,
         reservado_em = null
   where lote_id = p_lote and estado = 'EM_PROCESSAMENTO'
     and reservado_em < now() - interval '3 minutes';
  get diagnostics v_devolvidos = row_count;

  return jsonb_build_object('reconciliados', v_recuperados, 'devolvidos', v_devolvidos,
                            'limitacao', v_limitou > 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. INICIAR -- toma a execução do lote
-- ---------------------------------------------------------------------------
create or replace function public.prime_academico_piloto_iniciar(p_lote uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare v_lote public.prime_academico_piloto_lote; v_id uuid;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  select * into v_lote from public.prime_academico_piloto_lote where id = p_lote for update;
  if v_lote.id is null then
    return jsonb_build_object('ok', false, 'motivo', 'lote inexistente');
  end if;
  if v_lote.estado in ('CONCLUIDO','INTERROMPIDO') then
    return jsonb_build_object('ok', false, 'motivo', coalesce(v_lote.motivo, v_lote.estado));
  end if;
  if v_lote.execucao_ate is not null and v_lote.execucao_ate > now() then
    return jsonb_build_object('ok', false, 'motivo',
      'ja existe uma execucao ativa neste lote (outra aba). Aguarde ' ||
      ceil(extract(epoch from (v_lote.execucao_ate - now())))::int || 's ou pause la.');
  end if;

  v_id := gen_random_uuid();
  update public.prime_academico_piloto_lote
     set execucao_id = v_id, execucao_ate = now() + interval '90 seconds',
         estado = case when estado = 'PRONTO' then 'EM_ANDAMENTO' else estado end
   where id = p_lote;

  return jsonb_build_object('ok', true, 'execucao_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. PRÓXIMO -- exige a execução, DEBITA o orçamento na reserva
-- ---------------------------------------------------------------------------
-- O débito provisório de 1 requisição no momento da reserva é o que fecha o
-- buraco do orçamento: a partir daí qualquer outro leitor já vê o saldo menor.
-- O registro depois troca esse 1 pelo gasto real.
drop function if exists public.prime_academico_piloto_proximo(uuid);

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
  v_orcamento integer;
  v_pulados integer;
  v_rec jsonb;
  v_item public.prime_academico_piloto_item;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  v_rec := public.prime_academico_piloto_reconciliar(p_lote);

  select * into v_lote from public.prime_academico_piloto_lote where id = p_lote for update;
  if v_lote.id is null then
    return jsonb_build_object('parar', true, 'motivo', 'lote inexistente');
  end if;
  if v_lote.estado in ('CONCLUIDO','INTERROMPIDO') then
    return jsonb_build_object('parar', true, 'motivo', coalesce(v_lote.motivo, v_lote.estado),
                              'reconciliacao', v_rec);
  end if;

  -- SÓ QUEM TEM A EXECUÇÃO PEDE ITEM. Sem isto, duas abas alternavam pedidos
  -- no mesmo lote e cada uma achava que o orçamento era todo dela.
  if v_lote.execucao_id is null or v_lote.execucao_ate <= now() then
    return jsonb_build_object('parar', true, 'motivo', 'execucao expirada; inicie o lote de novo',
                              'reconciliacao', v_rec);
  end if;
  if p_execucao is null or p_execucao <> v_lote.execucao_id then
    return jsonb_build_object('parar', true, 'motivo', 'outra execucao esta conduzindo este lote',
                              'reconciliacao', v_rec);
  end if;

  update public.prime_academico_piloto_item i
     set estado = 'PULADO', erro = 'ja consultado pela ficha depois de o lote ser preparado',
         requisicoes = 0, processado_em = now()
   where i.lote_id = p_lote and i.estado = 'PENDENTE'
     and exists (select 1 from public.prime_academico_consulta c where c.aluno_id = i.aluno_id);
  get diagnostics v_pulados = row_count;

  v_gastas := public.prime_academico_piloto_gastas(p_lote);
  v_orcamento := v_lote.limite_requisicoes - v_gastas;

  if v_orcamento <= 0 then
    update public.prime_academico_piloto_lote
       set estado = 'INTERROMPIDO', encerrado_em = now(),
           execucao_id = null, execucao_ate = null,
           motivo = 'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes
     where id = p_lote;
    return jsonb_build_object('parar', true, 'reconciliacao', v_rec, 'pulados_agora', v_pulados,
      'motivo', 'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes);
  end if;

  -- RESERVA + DÉBITO PROVISÓRIO, na mesma transação.
  update public.prime_academico_piloto_item
     set estado = 'EM_PROCESSAMENTO', reservado_em = now(),
         tentativas = tentativas + 1, requisicoes = 1
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

  -- renova a concessão a cada item entregue
  update public.prime_academico_piloto_lote
     set execucao_ate = now() + interval '90 seconds' where id = p_lote;

  return jsonb_build_object(
    'parar', false, 'item_id', v_item.id, 'aluno_id', v_item.aluno_id, 'ordem', v_item.ordem,
    -- o orçamento já vem LÍQUIDO do débito provisório desta reserva
    'orcamento', v_lote.limite_requisicoes - public.prime_academico_piloto_gastas(p_lote) + 1,
    'requisicoes_gastas', v_gastas, 'limite_requisicoes', v_lote.limite_requisicoes,
    'pulados_agora', v_pulados, 'reconciliacao', v_rec);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. VALIDAR -- orçamento líquido, já com o débito da própria reserva
-- ---------------------------------------------------------------------------
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
  if v_item.id is null then return jsonb_build_object('ok', false, 'motivo', 'ITEM_INEXISTENTE'); end if;
  if v_item.aluno_id <> p_aluno_id then
    return jsonb_build_object('ok', false, 'motivo', 'ITEM_NAO_E_DESTE_ALUNO'); end if;
  if v_item.estado <> 'EM_PROCESSAMENTO' then
    return jsonb_build_object('ok', false, 'motivo', 'ITEM_NAO_RESERVADO:' || v_item.estado); end if;

  select * into v_lote from public.prime_academico_piloto_lote where id = v_item.lote_id;
  if v_lote.estado = 'INTERROMPIDO' then
    return jsonb_build_object('ok', false, 'motivo', 'LOTE_INTERROMPIDO'); end if;

  v_gastas := public.prime_academico_piloto_gastas(v_item.lote_id);
  -- soma de volta o 1 provisório deste item: ele é o orçamento DESTA chamada,
  -- não uma dívida a descontar dela.
  return jsonb_build_object('ok', true, 'lote_id', v_lote.id,
    'orcamento', greatest(v_lote.limite_requisicoes - v_gastas + coalesce(v_item.requisicoes, 0), 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. PAUSAR devolve a execução
-- ---------------------------------------------------------------------------
create or replace function public.prime_academico_piloto_pausar(p_lote uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;
  update public.prime_academico_piloto_lote
     set estado = 'PRONTO', execucao_id = null, execucao_ate = null
   where id = p_lote and estado = 'EM_ANDAMENTO';
  return jsonb_build_object('ok', found);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. PAINEL -- passa a usar a contagem única
-- ---------------------------------------------------------------------------
create or replace function public.prime_academico_piloto_painel(p_lote uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_out jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lote_id', l.id, 'recorte', case when l.ano='2026' then l.ano||'/'||coalesce(l.semestre,'1') else l.ano end,
    'estado', l.estado, 'motivo', l.motivo,
    'criado_em', l.criado_em, 'criado_por', l.criado_por_email, 'encerrado_em', l.encerrado_em,
    'limite_alunos', l.limite_alunos, 'limite_requisicoes', l.limite_requisicoes,
    'execucao_ativa', (l.execucao_ate is not null and l.execucao_ate > now()),
    'itens', (select count(*) from public.prime_academico_piloto_item i where i.lote_id = l.id),
    'concluidos', (select count(*) from public.prime_academico_piloto_item i where i.lote_id = l.id and i.estado='CONCLUIDO'),
    'falhas', (select count(*) from public.prime_academico_piloto_item i where i.lote_id = l.id and i.estado='FALHOU'),
    'pendentes', (select count(*) from public.prime_academico_piloto_item i where i.lote_id = l.id and i.estado in ('PENDENTE','EM_PROCESSAMENTO')),
    'requisicoes_gastas', public.prime_academico_piloto_gastas(l.id)
  ) order by l.criado_em desc), '[]'::jsonb)
  into v_out
  from public.prime_academico_piloto_lote l
  where p_lote is null or l.id = p_lote;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. PERMISSÕES
-- ---------------------------------------------------------------------------
revoke all on function public.prime_academico_piloto_gastas(uuid) from public, anon;
revoke all on function public.prime_academico_piloto_reconciliar(uuid) from public, anon;
revoke all on function public.prime_academico_piloto_iniciar(uuid) from public, anon;
revoke all on function public.prime_academico_piloto_proximo(uuid, uuid) from public, anon;
grant execute on function public.prime_academico_piloto_gastas(uuid) to authenticated, service_role;
grant execute on function public.prime_academico_piloto_reconciliar(uuid) to authenticated, service_role;
grant execute on function public.prime_academico_piloto_iniciar(uuid) to authenticated, service_role;
grant execute on function public.prime_academico_piloto_proximo(uuid, uuid) to authenticated, service_role;
