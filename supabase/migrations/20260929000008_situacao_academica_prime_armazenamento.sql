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
-- LINHAS SEMELHANTES SÃO PRESERVADAS. Há alunos com três vínculos de curso,
-- campus e turno IDÊNTICOS e status diferentes, um deles nulo -- medido e
-- registrado em docs/integracoes/prime-mapa-identificadores.md. Qualquer
-- unicidade por (curso, campus, turno) apagaria duas delas. A
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
--   COM_VINCULOS          a API respondeu, paginou até o fim, e trouxe linhas
--   SEM_RESULTADO         a API respondeu 200 com items vazio -- o CPF não foi
--                         encontrado naquela busca. NÃO é o mesmo que "não tem
--                         vínculo": o `search` é substring e falha em silêncio
--                         quando o CPF vai sem formatação (ver prime-api.md)
--   PAGINACAO_INCOMPLETA  respondeu e trouxe linhas, mas bateu no teto de
--                         páginas sem provar que acabou. Há dado, e ele NÃO
--                         pode ser apresentado como lista completa -- chamar
--                         isto de COM_VINCULOS afirmaria um total que não se
--                         mediu
--   FALHA_COMUNICACAO     4xx/5xx/timeout/JSON ilegível -- não se sabe nada
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
                       check (resultado in ('COM_VINCULOS','SEM_RESULTADO',
                                            'PAGINACAO_INCOMPLETA','FALHA_COMUNICACAO')),
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
  -- campus e turno idênticos -- e eles existem. Não reordenar.
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
  -- boolean INDEPENDENTE de status: há linha com status 'Mudança de Campus' e
  -- graduated true (ver docs/integracoes/prime-api.md). Não derivar um do outro.
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
-- 3. RLS -- ler a consulta exige poder ler a FICHA
-- ---------------------------------------------------------------------------
-- A primeira versão usava `using (true)` para `authenticated`. Isso dava a
-- qualquer usuário logado a situação acadêmica de qualquer aluno, sem passar
-- pela mesma autorização que a ficha exige -- e o painel de TV, que é um
-- usuário logado e está explicitamente barrado de ler `alunos`, passaria.
--
-- A regra agora é encadeada: **vê a consulta quem consegue ver a ficha**. O
-- `exists` abaixo roda com as policies de `public.alunos` aplicadas (RLS vale
-- dentro de subconsulta de policy), então este bloco herda automaticamente o
-- que `alunos_select` disser -- hoje `not eh_painel()`, e o que vier depois,
-- sem precisar editar esta migration de novo.
alter table public.prime_academico_consulta enable row level security;
alter table public.prime_academico_vinculo  enable row level security;

-- Escrita não tem policy nenhuma, de propósito: só service_role entra, e
-- service_role passa por cima de RLS. Nada de `revoke` de authenticated nas
-- TABELAS -- restringir é portão interno (regra de 12/09/2026).
drop policy if exists p_prime_academico_consulta_ler on public.prime_academico_consulta;
create policy p_prime_academico_consulta_ler
  on public.prime_academico_consulta for select to authenticated
  using (exists (select 1 from public.alunos a where a.id = aluno_id));

-- O vínculo segue a consulta, que segue a ficha.
drop policy if exists p_prime_academico_vinculo_ler on public.prime_academico_vinculo;
create policy p_prime_academico_vinculo_ler
  on public.prime_academico_vinculo for select to authenticated
  using (exists (select 1 from public.prime_academico_consulta c where c.id = consulta_id));

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- 4a. Os vínculos de uma consulta, na ordem da API
-- ---------------------------------------------------------------------------
-- Extraída porque a leitura monta dois blocos (a última e a última boa) e
-- repetir o `jsonb_agg` nos dois convidava os dois a divergirem com o tempo.
create or replace function public.prime_academico_vinculos_de(p_consulta_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'linha_id',       v.id,
           'ordem',          v.ordem,
           'registration',   v.registration,
           'curso',          v.curso,
           'campus',         v.campus,
           'turno',          v.turno,
           'status',         v.status,
           'admission_year', v.admission_year,
           'graduated',      v.graduated
         ) order by v.ordem), '[]'::jsonb)
    from public.prime_academico_vinculo v
   where v.consulta_id = p_consulta_id;
$$;

-- 4. LEITURA -- a última consulta, MAIS a última que deu certo
-- ---------------------------------------------------------------------------
-- Devolve `null` quando nunca se consultou: a tela usa isso para saber que
-- precisa consultar, que é diferente de "consultou e não veio nada".
--
-- POR QUE VÊM DUAS. Se a tentativa mais recente falhou, mostrar só ela apaga da
-- tela o que já se sabia -- e apaga de vez, porque recarregar a página relê do
-- banco e encontra a falha de novo. O aviso da falha tem de conviver com o
-- último dado bom, inclusive depois de fechar e reabrir a ficha.
--
-- "COMPLETA" É O CRITÉRIO, e ele é estrito: `resultado in ('COM_VINCULOS',
-- 'SEM_RESULTADO')`. São os dois casos em que a API respondeu E se paginou até
-- o fim -- ou seja, em que a lista devolvida é a lista inteira.
--
-- PAGINAÇÃO INCOMPLETA NÃO ENTRA AQUI. Ela trouxe dado de verdade, mas dado
-- PARCIAL: promovê-la a "última boa" faria uma lista reconhecidamente truncada
-- ocupar o lugar de uma lista completa mais antiga, e ninguém veria a troca. O
-- parcial aparece à parte, rotulado como incompleto, sem se misturar com este
-- bloco.
--
-- `ultima_boa` vem `null` quando nunca houve consulta completa.
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
     order by consultado_em desc, id desc
     limit 1
  ),
  boa as (
    select * from public.prime_academico_consulta
     where aluno_id = p_aluno_id
       and resultado in ('COM_VINCULOS','SEM_RESULTADO')
     order by consultado_em desc, id desc
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
    'vinculos',        public.prime_academico_vinculos_de(u.id),
    -- Só vem quando é OUTRA consulta: se a mais recente já deu certo, repetir
    -- o mesmo objeto aqui faria a tela achar que há duas coisas para mostrar.
    'ultima_boa', (
      select jsonb_build_object(
               'consulta_id',    b.id,
               'resultado',      b.resultado,
               'registration',   b.registration,
               'consultado_em',  b.consultado_em,
               'consultado_por', b.consultado_por_email,
               'vinculos',       public.prime_academico_vinculos_de(b.id)
             )
        from boa b where b.id <> u.id
    )
  )
  from ultima u;
$$;

comment on function public.prime_academico_ultima(uuid) is
  'Última consulta do aluno e, quando a última falhou ou veio incompleta, também a última COMPLETA (COM_VINCULOS ou SEM_RESULTADO). NULL = nunca consultado (≠ consultado sem resultado). linha_id/consulta_id são identificadores INTERNOS, nunca do Prime.';

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

  if p_resultado not in ('COM_VINCULOS','SEM_RESULTADO',
                         'PAGINACAO_INCOMPLETA','FALHA_COMUNICACAO') then
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

  -- PAGINACAO_INCOMPLETA também grava as linhas: o dado parcial é dado, e
  -- jogá-lo fora deixaria a tela sem nada tendo o que mostrar.
  if p_resultado in ('COM_VINCULOS','PAGINACAO_INCOMPLETA')
     and jsonb_typeof(p_vinculos) = 'array' then
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
-- A ESCRITA é só do backend.
--
-- CORREÇÃO DE UMA AFIRMAÇÃO ERRADA que estava aqui: `revoke ... from public`
-- NÃO tira de `anon` e de `authenticated`. O default privileges do Supabase
-- concede EXECUTE **diretamente** a esses papéis, e concessão direta não
-- desaparece quando se revoga de PUBLIC. Sem revogar dos três nominalmente,
-- qualquer usuário logado podia chamar a RPC de escrita -- só seria barrado lá
-- dentro pelo `auth.role()`, que é a segunda tranca, não a única.
revoke all on function public.prime_academico_registrar(uuid,text,text,text,text,integer,integer,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.prime_academico_registrar(uuid,text,text,text,text,integer,integer,jsonb,text)
  to service_role;

-- A LEITURA é do operador logado: é dado operacional, e escondê-lo produziria a
-- cobrança errada. `security invoker` + policy de select mandam de verdade; este
-- grant só abre a porta da função.
--
-- NENHUM `revoke` de authenticated aqui -- restringir é portão interno, nunca
-- tirar EXECUTE de quem usa a tela (regra de 12/09/2026).
revoke all on function public.prime_academico_ultima(uuid) from public, anon;
grant execute on function public.prime_academico_ultima(uuid) to authenticated, service_role;

-- A auxiliar segue a mesma regra da leitura. `security invoker`, então a RLS
-- das tabelas continua mandando mesmo para quem tem EXECUTE.
revoke all on function public.prime_academico_vinculos_de(uuid) from public, anon;
grant execute on function public.prime_academico_vinculos_de(uuid) to authenticated, service_role;
