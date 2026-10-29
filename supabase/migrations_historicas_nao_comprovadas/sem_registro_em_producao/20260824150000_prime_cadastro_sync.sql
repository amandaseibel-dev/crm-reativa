-- ============================================================================
-- Integração Ulbra Prime API -> CRM  |  FASE 1: enriquecimento de CADASTRO
-- ============================================================================
-- A Prime API é SOMENTE-LEITURA (o servidor responde `allow: GET` em todas as
-- rotas) e contém APENAS títulos já liquidados. Por isso esta fase NÃO toca em
-- nada financeiro: não dá baixa, não cria acordo, não mexe em saldo, parcela,
-- título ou situação operacional. Ela preenche exclusivamente dados CADASTRAIS
-- que hoje são ajustados à mão e deixam a base defasada.
--
-- Por que o financeiro fica de fora (medido em 2026-08-24, produção):
--   * o portador 166 (SANTANDER REATIVA, onde vivem os acordos) NUNCA devolve
--     uma parcela -- +9.000 parcelas varridas, zero ocorrência;
--   * /agreements vem vazio em 100% dos alunos testados;
--   * a Prime marca a mensalidade como paga quando o aluno NEGOCIA e NÃO
--     reverte quando o acordo é CANCELADO -- 12 de 13 alunos que "pareciam
--     pagos" tinham acordo cancelado e dívida viva.
-- Ver a memória `prime-baixa-automatica-proibida-acordo-cancelado`.
--
-- MODELO DE ESCRITA: espelho + aplicação separada.
--   1. `prime_cadastro_sync` guarda o que a Prime devolveu (espelho fiel).
--   2. `prime_cadastro_aplicar()` copia para `alunos` SOMENTE campo vazio.
-- Nunca sobrescreve dado preenchido por pessoa. Toda escrita é auditada.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Espelho do cadastro vindo da Prime (PII: RLS deny-all, acesso só via RPC)
-- ----------------------------------------------------------------------------
create table if not exists public.prime_cadastro_sync (
  cpf                text primary key,                 -- só dígitos, 11 chars
  registration       text not null,                    -- matrícula na Prime
  nome               text,
  rg                 text,
  telefones          text[]  not null default '{}',    -- só os >= 10 dígitos
  endereco           jsonb,                            -- street/number/district/city/state/zipCode
  curso              text,
  campus             text,
  turno              text,
  status_academico   text,
  contrato_vigente   boolean not null default false,   -- matriculado HOJE
  contrato_valid_to  date,
  portador           integer,                          -- 166 acordos | 195 mensalidades
  coletado_em        timestamptz not null default now(),
  constraint prime_cadastro_sync_cpf_digitos check (cpf ~ '^[0-9]{11}$'),
  -- Portão de escopo: a Reativa só responde por estes dois portadores.
  -- Os judiciais (165, 202) e os demais 120 da Prime não são nossos.
  constraint prime_cadastro_sync_portador_nosso check (portador in (166, 195))
);

comment on table public.prime_cadastro_sync is
  'Espelho do cadastro da Ulbra Prime API (somente-leitura). Fonte de conferência, NÃO é fonte de verdade financeira. Preenchido pela Edge Function prime-sync.';
comment on column public.prime_cadastro_sync.contrato_vigente is
  'Contrato sem cancelamento e com validade ainda em curso = aluno estuda hoje. Muda a abordagem de cobrança.';

create index if not exists prime_cadastro_sync_vigente_idx
  on public.prime_cadastro_sync (contrato_vigente) where contrato_vigente;

alter table public.prime_cadastro_sync enable row level security;
revoke all on public.prime_cadastro_sync from anon, authenticated;
-- Sem POLICY nenhuma = deny-all para anon/authenticated. service_role ignora RLS.

-- ----------------------------------------------------------------------------
-- 2. Auditoria de cada execução do sync e de cada aplicação
-- ----------------------------------------------------------------------------
create table if not exists public.prime_cadastro_execucoes (
  id            uuid primary key default gen_random_uuid(),
  acao          text not null,                 -- 'coletar' | 'aplicar'
  iniciado_em   timestamptz not null default now(),
  terminado_em  timestamptz,
  alvos         integer not null default 0,
  encontrados   integer not null default 0,
  aplicados     integer not null default 0,
  erros         integer not null default 0,
  detalhe       jsonb,                         -- contadores por campo, sem PII
  constraint prime_cadastro_execucoes_acao_valida check (acao in ('coletar','aplicar'))
);

comment on table public.prime_cadastro_execucoes is
  'Log de execuções do sync da Prime. `detalhe` guarda apenas contadores agregados -- nunca CPF, nome ou telefone.';

alter table public.prime_cadastro_execucoes enable row level security;
revoke all on public.prime_cadastro_execucoes from anon, authenticated;

-- Gestão pode LER o log (são só contadores, sem PII).
drop policy if exists prime_cadastro_execucoes_gestao_le on public.prime_cadastro_execucoes;
create policy prime_cadastro_execucoes_gestao_le
  on public.prime_cadastro_execucoes for select
  to authenticated
  using (public.usuario_e_gestao());
grant select on public.prime_cadastro_execucoes to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Backup de tudo que for sobrescrito (padrão da casa: nunca escrever sem rede)
-- ----------------------------------------------------------------------------
create table if not exists public.prime_cadastro_aplicado (
  id            uuid primary key default gen_random_uuid(),
  execucao_id   uuid references public.prime_cadastro_execucoes(id) on delete set null,
  aluno_id      uuid not null,
  campo         text not null,
  valor_antes   text,
  valor_depois  text,
  aplicado_em   timestamptz not null default now()
);

comment on table public.prime_cadastro_aplicado is
  'Trilha campo a campo do que a Prime preencheu em `alunos`. Permite desfazer.';

create index if not exists prime_cadastro_aplicado_aluno_idx
  on public.prime_cadastro_aplicado (aluno_id);
create index if not exists prime_cadastro_aplicado_execucao_idx
  on public.prime_cadastro_aplicado (execucao_id);

alter table public.prime_cadastro_aplicado enable row level security;
revoke all on public.prime_cadastro_aplicado from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Alvos: devedores cujo cadastro está incompleto no CRM
-- ----------------------------------------------------------------------------
-- Prioriza por saldo: quem deve mais e não tem como ser acionado vem primeiro.
create or replace function public.prime_alvos_cadastro(p_limite integer default 300)
returns table (cpf text, saldo numeric, falta_telefone boolean, falta_academico boolean)
language sql
security definer
set search_path = public
as $$
  select
    regexp_replace(a.cpf, '\D', '', 'g')                             as cpf,
    a.saldo_total                                                    as saldo,
    (a.telefone is null
      or length(regexp_replace(a.telefone, '\D', '', 'g')) < 10)     as falta_telefone,
    (a.curso is null or a.situacao_academica is null)                as falta_academico
  from public.alunos a
  where coalesce(a.saldo_total, 0) > 0
    and a.cpf is not null
    and length(regexp_replace(a.cpf, '\D', '', 'g')) = 11
    and (
          a.telefone is null
       or length(regexp_replace(a.telefone, '\D', '', 'g')) < 10
       or a.curso is null
       or a.situacao_academica is null
    )
    -- não repete quem já foi coletado nas últimas 24h
    and not exists (
      select 1 from public.prime_cadastro_sync s
      where s.cpf = regexp_replace(a.cpf, '\D', '', 'g')
        and s.coletado_em > now() - interval '24 hours'
    )
  order by a.saldo_total desc
  limit greatest(1, least(coalesce(p_limite, 300), 1000));
$$;

revoke all on function public.prime_alvos_cadastro(integer) from public, anon, authenticated;
comment on function public.prime_alvos_cadastro(integer) is
  'Devedores com cadastro incompleto, do maior saldo para o menor. Só service_role (a Edge Function).';

-- ----------------------------------------------------------------------------
-- 5. Aplicação: copia do espelho para `alunos`, SÓ onde está vazio
-- ----------------------------------------------------------------------------
-- Regras duras:
--   * jamais sobrescreve valor já preenchido;
--   * jamais toca em campo financeiro ou operacional;
--   * registra cada campo escrito em prime_cadastro_aplicado.
create or replace function public.prime_cadastro_aplicar(p_execucao_id uuid default null)
returns table (alunos_tocados integer, telefones integer, cursos integer, situacoes integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tel  integer := 0;
  v_cur  integer := 0;
  v_sit  integer := 0;
  v_tot  integer := 0;
  r      record;
  v_novo text;
begin
  for r in
    select a.id as aluno_id, a.telefone, a.curso, a.situacao_academica,
           s.telefones, s.curso as p_curso, s.status_academico as p_status
    from public.alunos a
    join public.prime_cadastro_sync s
      on s.cpf = regexp_replace(a.cpf, '\D', '', 'g')
    where coalesce(a.saldo_total, 0) > 0
  loop
    -- TELEFONE: só se o nosso está vazio/inválido e a Prime tem um válido
    if (r.telefone is null or length(regexp_replace(r.telefone, '\D', '', 'g')) < 10)
       and array_length(r.telefones, 1) >= 1 then
      v_novo := r.telefones[1];
      update public.alunos
         set telefone = v_novo,
             sem_telefone = false,
             atualizado_em = now()
       where id = r.aluno_id;
      insert into public.prime_cadastro_aplicado (execucao_id, aluno_id, campo, valor_antes, valor_depois)
      values (p_execucao_id, r.aluno_id, 'telefone', r.telefone, v_novo);
      v_tel := v_tel + 1;
    end if;

    -- CURSO
    if r.curso is null and r.p_curso is not null then
      update public.alunos
         set curso = r.p_curso,
             academico_fonte = 'prime',
             academico_atualizado_em = now()
       where id = r.aluno_id;
      insert into public.prime_cadastro_aplicado (execucao_id, aluno_id, campo, valor_antes, valor_depois)
      values (p_execucao_id, r.aluno_id, 'curso', null, r.p_curso);
      v_cur := v_cur + 1;
    end if;

    -- SITUAÇÃO ACADÊMICA
    if r.situacao_academica is null and r.p_status is not null then
      update public.alunos
         set situacao_academica = r.p_status,
             academico_fonte = 'prime',
             academico_atualizado_em = now()
       where id = r.aluno_id;
      insert into public.prime_cadastro_aplicado (execucao_id, aluno_id, campo, valor_antes, valor_depois)
      values (p_execucao_id, r.aluno_id, 'situacao_academica', null, r.p_status);
      v_sit := v_sit + 1;
    end if;

    v_tot := v_tot + 1;
  end loop;

  return query select v_tot, v_tel, v_cur, v_sit;
end;
$$;

revoke all on function public.prime_cadastro_aplicar(uuid) from public, anon, authenticated;
comment on function public.prime_cadastro_aplicar(uuid) is
  'Copia cadastro do espelho da Prime para `alunos` SOMENTE onde o campo está vazio. Nunca sobrescreve, nunca toca em financeiro. Só service_role.';

-- ----------------------------------------------------------------------------
-- 6. Leitura para a gestão: quem a Prime diz que ESTUDA HOJE e nos deve
-- ----------------------------------------------------------------------------
-- Devedor com matrícula vigente é abordagem de cobrança diferente. O CRM não
-- tem esse dado hoje.
create or replace function public.prime_devedores_estudando()
returns table (
  aluno_id uuid, nome text, cpf_mascarado text, curso text, campus text,
  saldo_total numeric, contrato_valid_to date, operador text
)
language sql
security definer
set search_path = public
as $$
  select a.id, a.nome,
         regexp_replace(regexp_replace(a.cpf,'\D','','g'), '^(\d{3})\d{5}(\d{3})$', '\1*****\2'),
         coalesce(a.curso, s.curso), s.campus,
         a.saldo_total, s.contrato_valid_to,
         coalesce(a.operador, a.responsavel_atual_nome)
  from public.alunos a
  join public.prime_cadastro_sync s
    on s.cpf = regexp_replace(a.cpf, '\D', '', 'g')
  where s.contrato_vigente
    and coalesce(a.saldo_total, 0) > 0
    and public.usuario_e_gestao()
  order by a.saldo_total desc;
$$;

comment on function public.prime_devedores_estudando() is
  'Devedores que, segundo a Prime, têm matrícula vigente. CPF mascarado. Só gestão.';
grant execute on function public.prime_devedores_estudando() to authenticated;
