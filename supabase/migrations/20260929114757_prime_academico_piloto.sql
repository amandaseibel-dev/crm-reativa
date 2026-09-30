-- PILOTO MANUAL de consulta acadêmica -- fila, retomada e teto de requisições
-- ============================================================================
--
-- Para que existe: consultar ~2.500 alunos por recorte é volume contra um
-- sistema de terceiro. Antes de qualquer carga, um piloto de até 100 alunos,
-- UMA CHAMADA POR VEZ, com progresso gravado para retomar sem repetir e parada
-- imediata diante de limitação da API.
--
-- NÃO CRIA ROTINA. Não há cron, não há gatilho, não há disparo automático.
-- O lote só anda quando alguém da gestão pede o próximo item.
--
-- PAGINAÇÃO CONTA. Um aluno com 120 vínculos consome 3 requisições, não 1. O
-- teto do lote é de REQUISIÇÕES, não de alunos -- senão o limite combinado
-- seria furado sem ninguém perceber.

-- A coluna que faltava para poder contar: quantas requisições HTTP aquela
-- consulta consumiu, paginação inclusa.
alter table public.prime_academico_consulta
  add column if not exists requisicoes integer;

comment on column public.prime_academico_consulta.requisicoes is
  'Requisições HTTP à API do Prime que esta consulta consumiu, contando cada página. NULL = consulta anterior a esta contagem.';

-- ---------------------------------------------------------------------------
-- 1. LOTE
-- ---------------------------------------------------------------------------
create table if not exists public.prime_academico_piloto_lote (
  id                  uuid primary key default gen_random_uuid(),
  ano                 text not null,
  semestre            text,
  -- Dois tetos, e os dois valem. O de requisições é o que protege a API.
  limite_alunos       integer not null check (limite_alunos between 1 and 100),
  limite_requisicoes  integer not null check (limite_requisicoes between 1 and 1000),
  estado              text not null default 'PRONTO'
                      check (estado in ('PRONTO','EM_ANDAMENTO','CONCLUIDO','INTERROMPIDO')),
  motivo              text,
  criado_por_email    text,
  criado_em           timestamptz not null default now(),
  encerrado_em        timestamptz
);

comment on table public.prime_academico_piloto_lote is
  'Um lote de piloto. Só anda por pedido manual da gestão -- não há cron nem gatilho. Teto duplo: alunos e REQUISIÇÕES (paginação conta).';

-- ---------------------------------------------------------------------------
-- 2. ITEM -- um aluno, uma linha, processado um de cada vez
-- ---------------------------------------------------------------------------
create table if not exists public.prime_academico_piloto_item (
  id            uuid primary key default gen_random_uuid(),
  lote_id       uuid not null references public.prime_academico_piloto_lote(id) on delete cascade,
  ordem         integer not null,
  aluno_id      uuid not null references public.alunos(id) on delete cascade,
  estado        text not null default 'PENDENTE'
                check (estado in ('PENDENTE','CONCLUIDO','FALHOU','PULADO')),
  consulta_id   uuid references public.prime_academico_consulta(id),
  requisicoes   integer,
  erro          text,
  processado_em timestamptz,
  -- RETOMADA: o mesmo aluno nunca entra duas vezes no mesmo lote, e a chave
  -- por (lote, aluno) é o que garante que retomar não reprocessa o que já foi.
  constraint uq_piloto_item unique (lote_id, aluno_id)
);

create index if not exists ix_piloto_item_fila
  on public.prime_academico_piloto_item (lote_id, estado, ordem);

comment on table public.prime_academico_piloto_item is
  'Um aluno do lote. `estado` é o progresso: retomar pega o próximo PENDENTE, então consulta já concluída nunca se repete.';

alter table public.prime_academico_piloto_lote enable row level security;
alter table public.prime_academico_piloto_item enable row level security;

-- Leitura só para quem é gestão (é a mesma gente que pode disparar). Escrita
-- não tem policy: só service_role, que passa por cima de RLS.
drop policy if exists p_piloto_lote_ler on public.prime_academico_piloto_lote;
create policy p_piloto_lote_ler on public.prime_academico_piloto_lote
  for select to authenticated using (public.usuario_e_gestao());

drop policy if exists p_piloto_item_ler on public.prime_academico_piloto_item;
create policy p_piloto_item_ler on public.prime_academico_piloto_item
  for select to authenticated using (public.usuario_e_gestao());

-- ---------------------------------------------------------------------------
-- 3. CRIAR -- monta a fila, sem consultar nada
-- ---------------------------------------------------------------------------
-- Pega SÓ quem está em "Ainda não consultados" no recorte. Quem já tem consulta
-- não entra -- é isso que faz o piloto não repetir trabalho nem gastar
-- requisição à toa.
create or replace function public.prime_academico_piloto_criar(
  p_ano text, p_semestre text default null,
  p_limite_alunos integer default 100,
  p_limite_requisicoes integer default 300
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lote uuid;
  v_n integer;
  v_email text := lower(coalesce(auth.jwt() ->> 'email',''));
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  insert into public.prime_academico_piloto_lote
    (ano, semestre, limite_alunos, limite_requisicoes, criado_por_email)
  values (p_ano, p_semestre,
          greatest(1, least(coalesce(p_limite_alunos,100), 100)),
          greatest(1, least(coalesce(p_limite_requisicoes,300), 1000)),
          nullif(v_email,''))
  returning id into v_lote;

  insert into public.prime_academico_piloto_item (lote_id, ordem, aluno_id)
  select v_lote, row_number() over (order by u.cpf), u.aluno_id
    from public.carteira_academico_universo(p_ano, p_semestre) u
   where public.carteira_academico_grupo(u.aluno_id) = 'Ainda não consultados'
   limit (select limite_alunos from public.prime_academico_piloto_lote where id = v_lote);

  get diagnostics v_n = row_count;

  return jsonb_build_object('lote_id', v_lote, 'itens', v_n,
                            'aviso', 'Fila criada. Nenhuma consulta foi feita.');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. PRÓXIMO -- um por vez, e só se ainda couber no teto
-- ---------------------------------------------------------------------------
-- Devolve `null` quando acabou, quando o lote foi interrompido, ou quando o
-- teto de requisições já foi atingido. É aqui que o limite combinado vira
-- comportamento, em vez de recomendação.
create or replace function public.prime_academico_piloto_proximo(p_lote uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_lote public.prime_academico_piloto_lote;
  v_gastas integer;
  v_item public.prime_academico_piloto_item;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  select * into v_lote from public.prime_academico_piloto_lote where id = p_lote;
  if v_lote.id is null then return null; end if;
  if v_lote.estado in ('CONCLUIDO','INTERROMPIDO') then
    return jsonb_build_object('parar', true, 'motivo', coalesce(v_lote.motivo, v_lote.estado));
  end if;

  select coalesce(sum(requisicoes), 0) into v_gastas
    from public.prime_academico_piloto_item where lote_id = p_lote;
  if v_gastas >= v_lote.limite_requisicoes then
    return jsonb_build_object('parar', true, 'motivo',
      'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes);
  end if;

  select * into v_item from public.prime_academico_piloto_item
   where lote_id = p_lote and estado = 'PENDENTE' order by ordem limit 1;
  if v_item.id is null then
    return jsonb_build_object('parar', true, 'motivo', 'fila vazia');
  end if;

  return jsonb_build_object('parar', false, 'item_id', v_item.id,
                            'aluno_id', v_item.aluno_id, 'ordem', v_item.ordem,
                            'requisicoes_gastas', v_gastas,
                            'limite_requisicoes', v_lote.limite_requisicoes);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. REGISTRAR -- grava o resultado e decide se o lote continua
-- ---------------------------------------------------------------------------
-- LIMITAÇÃO DA API INTERROMPE O LOTE INTEIRO. 429 (rate limit) e 403 param
-- tudo na hora: insistir contra um sistema que acabou de dizer "pare" é como
-- se perde acesso. O lote fica INTERROMPIDO com o motivo escrito, e retomar
-- exige uma decisão humana.
create or replace function public.prime_academico_piloto_registrar(
  p_item uuid, p_consulta_id uuid, p_requisicoes integer,
  p_http integer default null, p_erro text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lote uuid;
  v_parar boolean := false;
  v_motivo text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Acesso negado: apenas service_role.' using errcode = '42501';
  end if;

  update public.prime_academico_piloto_item
     set estado = case when p_erro is null then 'CONCLUIDO' else 'FALHOU' end,
         consulta_id = p_consulta_id,
         requisicoes = greatest(coalesce(p_requisicoes, 1), 1),
         erro = p_erro,
         processado_em = now()
   where id = p_item
   returning lote_id into v_lote;

  if v_lote is null then
    raise exception 'item de piloto inexistente' using errcode = '22023';
  end if;

  if p_http in (401, 403, 429) then
    v_parar := true;
    v_motivo := 'API respondeu ' || p_http || ' -- limitacao; lote interrompido';
  end if;

  update public.prime_academico_piloto_lote
     set estado = case when v_parar then 'INTERROMPIDO' else 'EM_ANDAMENTO' end,
         motivo = coalesce(v_motivo, motivo),
         encerrado_em = case when v_parar then now() else encerrado_em end
   where id = v_lote;

  -- fila esvaziou sem interrupção: lote concluído
  if not v_parar and not exists (
      select 1 from public.prime_academico_piloto_item
       where lote_id = v_lote and estado = 'PENDENTE') then
    update public.prime_academico_piloto_lote
       set estado = 'CONCLUIDO', encerrado_em = now() where id = v_lote;
  end if;

  return jsonb_build_object('parar', v_parar, 'motivo', v_motivo);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. PAINEL -- progresso do lote
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
    'itens', (select count(*) from public.prime_academico_piloto_item i where i.lote_id = l.id),
    'concluidos', (select count(*) from public.prime_academico_piloto_item i where i.lote_id = l.id and i.estado='CONCLUIDO'),
    'falhas', (select count(*) from public.prime_academico_piloto_item i where i.lote_id = l.id and i.estado='FALHOU'),
    'pendentes', (select count(*) from public.prime_academico_piloto_item i where i.lote_id = l.id and i.estado='PENDENTE'),
    'requisicoes_gastas', (select coalesce(sum(i.requisicoes),0) from public.prime_academico_piloto_item i where i.lote_id = l.id)
  ) order by l.criado_em desc), '[]'::jsonb)
  into v_out
  from public.prime_academico_piloto_lote l
  where p_lote is null or l.id = p_lote;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. PERMISSÕES
-- ---------------------------------------------------------------------------
revoke all on function public.prime_academico_piloto_criar(text,text,integer,integer) from public, anon;
revoke all on function public.prime_academico_piloto_proximo(uuid) from public, anon;
revoke all on function public.prime_academico_piloto_painel(uuid) from public, anon;
-- a de escrita nem chega perto de authenticated
revoke all on function public.prime_academico_piloto_registrar(uuid,uuid,integer,integer,text)
  from public, anon, authenticated;

grant execute on function public.prime_academico_piloto_criar(text,text,integer,integer) to authenticated, service_role;
grant execute on function public.prime_academico_piloto_proximo(uuid) to authenticated, service_role;
grant execute on function public.prime_academico_piloto_painel(uuid) to authenticated, service_role;
grant execute on function public.prime_academico_piloto_registrar(uuid,uuid,integer,integer,text) to service_role;
