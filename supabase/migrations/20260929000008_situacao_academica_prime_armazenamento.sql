-- SITUAÇÃO ACADÊMICA CONSULTADA NO PRIME — armazenamento e leitura
-- ============================================================================
--
-- O QUE ISTO GUARDA, E POR QUE ASSIM.
--
-- A situação acadêmica do Prime vem de `students_search` → `items[].status`, e
-- **é por vínculo de curso**, não da pessoa: na sondagem de 28/09/2026 (amostra
-- de 6 alunos, 35 vínculos) `registration` repetiu-se idêntico em todas as
-- linhas do mesmo aluno, e os status dessas linhas divergem entre si. Ver
-- docs/integracoes/prime-api.md e prime-mapa-identificadores.md.
--
-- Consequência de desenho: guarda-se a RESPOSTA INTEIRA, linha por linha. Não
-- existe coluna de "situação do aluno" aqui, de propósito -- assim ninguém
-- consegue, mais tarde, ler uma linha e chamá-la de status da pessoa.
--
-- LINHAS SEMELHANTES SÃO PRESERVADAS. Na matrícula 222007757 três vínculos têm
-- curso, campus e turno IDÊNTICOS, com status "Reopção de Curso", "Cancelado" e
-- nulo. Qualquer unicidade por (curso, campus, turno) apagaria duas delas. A
-- chave é (consulta_id, ordem) -- `ordem` é a posição na resposta da API, e é
-- só isso que distingue linhas iguais.
--
-- IDENTIFICADORES SÃO INTERNOS, E O NOME DIZ ISSO. `id` das duas tabelas é uuid
-- nosso, gerado aqui. NÃO foi encontrado identificador estável do vínculo nos
-- endpoints e na amostra consultados, então nada nestas tabelas pode ser
-- apresentado como "id do Prime" -- nem em tela, nem em export, nem em matching.
--
-- O QUE ISTO NÃO FAZ: não escreve em `alunos`, não toca
-- `alunos.situacao_academica`, não tem trigger, não mexe em saldo, cobrança nem
-- em nada da Efetividade. É leitura registrada, e só.

-- ---------------------------------------------------------------------------
-- 1. CONSULTA -- uma linha por chamada à API, inclusive quando dá errado
-- ---------------------------------------------------------------------------
-- Os três desfechos são estados distintos e precisam ser distinguíveis na tela:
--
--   COM_VINCULOS        a API respondeu e trouxe linhas
--   SEM_RESULTADO       a API respondeu 200 com items vazio -- o CPF não foi
--                       encontrado naquela busca. NÃO é o mesmo que "não tem
--                       vínculo": o `search` é substring e falha em silêncio
--                       quando o CPF vai sem formatação (ver prime-api.md)
--   FALHA_COMUNICACAO   4xx/5xx/timeout/JSON ilegível -- não se sabe nada
--
-- Achatar os três em "sem informação" é o erro que esta tabela existe para
-- evitar: falha de rede viraria "o aluno não tem vínculo".
create table if not exists public.prime_academico_consulta (
  id                   uuid primary key default gen_random_uuid(),
  aluno_id             uuid not null references public.alunos(id) on delete cascade,
  cpf                  text not null,
  -- a matrícula que a API devolveu; guardada como informação, nunca como chave
  -- de vínculo
  registration         text,
  resultado            text not null
                       check (resultado in ('COM_VINCULOS','SEM_RESULTADO','FALHA_COMUNICACAO')),
  -- só preenchido em FALHA_COMUNICACAO; mensagem para a tela, sem credencial
  detalhe_falha        text,
  http_status          integer,
  total_items          integer,
  fonte                text not null default 'prime:students_search',
  consultado_em        timestamptz not null default now(),
  consultado_por_email text
);

comment on table public.prime_academico_consulta is
  'Uma linha por consulta a students_search. Guarda o desfecho (inclusive falha) com fonte e data. Não define situação do aluno.';

create index if not exists ix_prime_academico_consulta_aluno
  on public.prime_academico_consulta (aluno_id, consultado_em desc);

-- ---------------------------------------------------------------------------
-- 2. VÍNCULO -- uma linha por item de items[], na ordem em que a API devolveu
-- ---------------------------------------------------------------------------
create table if not exists public.prime_academico_vinculo (
  id            uuid primary key default gen_random_uuid(),
  consulta_id   uuid not null references public.prime_academico_consulta(id) on delete cascade,
  -- POSIÇÃO NA RESPOSTA. É o único campo que distingue vínculos com curso,
  -- campus e turno idênticos -- e eles existem (222007757). Não reordenar.
  ordem         integer not null,
  -- MATRÍCULA DESTA LINHA. Na amostra de 28/09/2026 ela se repetiu idêntica
  -- dentro de cada aluno, mas seis alunos não autorizam tratar isso como regra.
  -- Se um dia vierem matrículas diferentes na mesma resposta, guardar uma só no
  -- cabeçalho perderia a informação de qual vínculo pertence a qual.
  registration  text,
  curso         text,
  campus        text,
  turno         text,
  -- NULL = o Prime não informou. Não é "sem situação", e não se preenche por
  -- inferência. A tela mostra "Não informado pelo Prime".
  status        text,
  admission_year integer,
  -- boolean INDEPENDENTE de status: linha com status 'Mudança de Campus' veio
  -- graduated:true na matrícula 201008325. Não derivar um do outro.
  graduated     boolean,
  constraint uq_prime_academico_vinculo_ordem unique (consulta_id, ordem)
);

comment on table public.prime_academico_vinculo is
  'Um vínculo de curso por linha, na ordem da resposta. status NULL = não informado pelo Prime. Linhas semelhantes com status diferentes são preservadas.';

comment on column public.prime_academico_vinculo.ordem is
  'Posição na resposta da API. Único discriminador de vínculos com curso+campus+turno idênticos.';

comment on column public.prime_academico_vinculo.registration is
  'Matrícula desta linha, como a API devolveu. Preservada por linha justamente para o caso de a resposta trazer matrículas diferentes.';

comment on column public.prime_academico_consulta.registration is
  'Matrícula do cabeçalho: só preenchida quando TODAS as linhas concordam. Nula quando divergem — a informação por linha é que manda.';

-- ---------------------------------------------------------------------------
-- 3. RLS -- leitura para quem está logado; escrita só pelo backend
-- ---------------------------------------------------------------------------
alter table public.prime_academico_consulta enable row level security;
alter table public.prime_academico_vinculo  enable row level security;

-- Operador precisa LER na ficha: é dado operacional, e esconder produziria a
-- cobrança errada. Escrita não tem policy nenhuma -- só service_role entra, e
-- service_role passa por cima de RLS. Nada de `revoke` de authenticated: ver a
-- regra de 12/09 (restringir é portão interno, nunca revoke).
drop policy if exists p_prime_academico_consulta_ler on public.prime_academico_consulta;
create policy p_prime_academico_consulta_ler
  on public.prime_academico_consulta for select to authenticated using (true);

drop policy if exists p_prime_academico_vinculo_ler on public.prime_academico_vinculo;
create policy p_prime_academico_vinculo_ler
  on public.prime_academico_vinculo for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 4. LEITURA -- a última consulta de um aluno, com todos os vínculos
-- ---------------------------------------------------------------------------
-- Devolve `null` quando nunca se consultou: a tela usa isso para saber que
-- precisa consultar a API, que é diferente de "consultou e não veio nada".
create or replace function public.prime_academico_ultima(p_aluno_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $$
  with ultima as (
    select * from public.prime_academico_consulta
     where aluno_id = p_aluno_id
     order by consultado_em desc
     limit 1
  )
  select jsonb_build_object(
    'consulta_id',     u.id,
    'resultado',       u.resultado,
    'detalhe_falha',   u.detalhe_falha,
    'http_status',     u.http_status,
    'registration',    u.registration,
    'fonte',           u.fonte,
    'consultado_em',   u.consultado_em,
    'consultado_por',  u.consultado_por_email,
    'vinculos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'linha_id',       v.id,
               'ordem',          v.ordem,
               'registration',   v.registration,
               'curso',          v.curso,
               'campus',         v.campus,
               'turno',          v.turno,
               'status',         v.status,
               'admission_year', v.admission_year,
               'graduated',      v.graduated
             ) order by v.ordem)
        from public.prime_academico_vinculo v
       where v.consulta_id = u.id
    ), '[]'::jsonb)
  )
  from ultima u;
$$;

comment on function public.prime_academico_ultima(uuid) is
  'Última consulta acadêmica do aluno, com todos os vínculos na ordem da API. NULL = nunca consultado (≠ consultado sem resultado). linha_id/consulta_id são identificadores INTERNOS, nunca do Prime.';

-- ---------------------------------------------------------------------------
-- 5. ESCRITA -- só service_role, chamada pela Edge Function
-- ---------------------------------------------------------------------------
-- `p_vinculos` é o items[] cru, já sem os campos pessoais que não interessam
-- aqui (nome e CPF não são regravados por vínculo). A ORDEM do array é a ordem
-- da API e vira a coluna `ordem` -- por isso a leitura usa
-- `with ordinality`, e não um número que o chamador invente.
create or replace function public.prime_academico_registrar(
  p_aluno_id      uuid,
  p_cpf           text,
  p_registration  text,
  p_resultado     text,
  p_detalhe_falha text,
  p_http_status   integer,
  p_total_items   integer,
  p_vinculos      jsonb,
  p_email         text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Acesso negado: apenas service_role.' using errcode = '42501';
  end if;

  if p_resultado not in ('COM_VINCULOS','SEM_RESULTADO','FALHA_COMUNICACAO') then
    raise exception 'resultado invalido: %', p_resultado using errcode = '22023';
  end if;

  -- FALHA NÃO APAGA O QUE JÁ SE SABIA. Cada consulta é uma linha nova; a
  -- leitura pega a mais recente. Se hoje a API cair, a tela mostra a falha de
  -- hoje -- e o histórico de ontem continua na tabela, não é sobrescrito.
  insert into public.prime_academico_consulta
    (aluno_id, cpf, registration, resultado, detalhe_falha, http_status, total_items,
     consultado_por_email)
  values
    (p_aluno_id, p_cpf, nullif(p_registration,''), p_resultado,
     nullif(p_detalhe_falha,''), p_http_status, p_total_items, nullif(p_email,''))
  returning id into v_id;

  if p_resultado = 'COM_VINCULOS' and jsonb_typeof(p_vinculos) = 'array' then
    insert into public.prime_academico_vinculo
      (consulta_id, ordem, registration, curso, campus, turno, status, admission_year, graduated)
    select
      v_id,
      (t.ord)::int,
      nullif(t.item->>'registration',''),
      nullif(t.item->>'course',''),
      nullif(t.item->>'campus',''),
      nullif(t.item->>'shift',''),
      -- string vazia e nulo do JSON viram NULL: "não informado pelo Prime".
      nullif(t.item->>'status',''),
      case when jsonb_typeof(t.item->'admissionYear') = 'number'
           then (t.item->>'admissionYear')::int end,
      case when jsonb_typeof(t.item->'graduated') = 'boolean'
           then (t.item->>'graduated')::boolean end
    from jsonb_array_elements(p_vinculos) with ordinality as t(item, ord);
  end if;

  return v_id;
end;
$$;

comment on function public.prime_academico_registrar is
  'Grava uma consulta acadêmica e seus vínculos. service_role apenas. Não escreve em alunos, não altera situacao_academica, saldo nem cobrança.';

-- ---------------------------------------------------------------------------
-- 6. PERMISSÕES, EXPLÍCITAS
-- ---------------------------------------------------------------------------
-- Escritas assim, e não deixadas ao default privileges do projeto: o default é
-- conceder EXECUTE a todo mundo, e quem lê a migration depois não tem como
-- saber quem podia chamar o quê. Aqui está no arquivo.
--
-- A ESCRITA é só do backend. `revoke ... from public` tira de anon e de
-- authenticated junto (os dois herdam de PUBLIC), e o grant devolve só a
-- service_role. O `auth.role()` lá dentro continua valendo como segunda
-- tranca -- quem tiver a credencial ainda precisa estar com o papel certo.
revoke all on function public.prime_academico_registrar(uuid,text,text,text,text,integer,integer,jsonb,text) from public;
grant execute on function public.prime_academico_registrar(uuid,text,text,text,text,integer,integer,jsonb,text) to service_role;

-- A LEITURA é do operador logado: é dado operacional, e escondê-lo produziria a
-- cobrança errada. `security invoker` + policy de select mandam de verdade; este
-- grant só abre a porta da função.
--
-- NENHUM `revoke` de authenticated aqui -- restringir é portão interno, nunca
-- tirar EXECUTE de quem usa a tela (regra de 12/09/2026).
grant execute on function public.prime_academico_ultima(uuid) to authenticated, service_role;
