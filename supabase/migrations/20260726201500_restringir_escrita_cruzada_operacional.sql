-- ============================================================================
-- Migration: restringir escrita cruzada operacional (alunos, casos, acordos,
--            acordos_titulos)
-- Data.......: 2026-07-26
-- Branch.....: security/restringir-escrita-cruzada-operacional
-- Objetivo...: substituir policies de INSERT/UPDATE/DELETE com USING true /
--              WITH CHECK true que permitiam escrita cruzada (assumir/alterar/
--              excluir registro de outro operador por envio direto de ID).
--
-- Princípios:
--   * Menor privilégio para o papel `authenticated`.
--   * Preserva integralmente: service_role, postgres, role interna
--     `reativa_responsavel_executor` e todas as RPCs SECURITY DEFINER (que
--     continuam ignorando RLS por serem owned=postgres).
--   * NÃO reabre itens já corrigidos: mantém painel_negado / painel_sem_casos,
--     os guards existentes (_guard_resp_aluno, _guard_resp_acordo,
--     bloquear_alteracoes_restritas_casos) e as policies *_select / *_executor.
--   * "Gestão" = public.usuario_e_gestao() (amanda / cobranca04 / cobranca07),
--     consistente com o modelo de SELECT já vigente. NÃO amplia para todo
--     perfil administrativo.
--
-- Idempotente: DROP POLICY IF EXISTS + CREATE; CREATE OR REPLACE FUNCTION;
--              DROP TRIGGER IF EXISTS + CREATE TRIGGER.
-- NÃO aplicar merge/deploy nesta etapa.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. HELPERS DE IDENTIDADE
-- ----------------------------------------------------------------------------

-- E-mail do usuário logado, normalizado. STABLE (sem SECURITY DEFINER: apenas
-- lê o JWT do próprio request).
create or replace function public.app_email()
returns text
language sql
stable
set search_path to 'public'
as $$
  select lower(coalesce((auth.jwt() ->> 'email'), ''));
$$;

-- Usuário autenticado E cadastrado E ativo em public.usuarios.
-- Bloqueia anon (email vazio), authenticated sem cadastro e inativo.
-- SECURITY DEFINER para ler usuarios independentemente da RLS do chamador.
-- A resolução por e-mail espelha o login do app (App.jsx: usuarios.email + ativo).
create or replace function public.app_usuario_ativo()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.usuarios u
    where lower(u.email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
      and u.ativo is true
  );
$$;

revoke all on function public.app_email() from public;
revoke all on function public.app_usuario_ativo() from public;
grant execute on function public.app_email() to authenticated, service_role;
grant execute on function public.app_usuario_ativo() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. ALUNOS
-- ----------------------------------------------------------------------------

-- INSERT: bloqueia inserir aluno já pertencente a outro operador.
drop policy if exists "Enable insert for authenticated users only" on public.alunos;
create policy alunos_insert on public.alunos
  for insert to authenticated
  with check (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or coalesce(responsavel_atual_email, '') = ''
      or lower(responsavel_atual_email) = public.app_email()
    )
  );

-- UPDATE: só a própria carteira (responsável = eu), registro livre, ou gestão.
-- A troca da coluna responsavel_atual_email continua barrada por _guard_resp_aluno.
drop policy if exists alunos_update on public.alunos;
create policy alunos_update on public.alunos
  for update to authenticated
  using (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or coalesce(responsavel_atual_email, '') = ''
      or lower(responsavel_atual_email) = public.app_email()
    )
  )
  with check (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or coalesce(responsavel_atual_email, '') = ''
      or lower(responsavel_atual_email) = public.app_email()
    )
  );

-- Guard de colunas sensíveis (financeiro/link/baixa/unificação) em alunos.
-- Essas colunas são gravadas exclusivamente por RPCs/triggers SECURITY DEFINER
-- (rodam como postgres) e nunca pelas telas de operador. Bloqueia adulteração
-- direta por operador sobre a própria carteira. Gestão e roles internas passam.
create or replace function public._guard_cols_aluno()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if current_user in ('postgres','supabase_admin','service_role','reativa_responsavel_executor') then
    return new;
  end if;
  if public.usuario_e_gestao() then
    return new;
  end if;
  if new.valor_em_aberto          is distinct from old.valor_em_aberto
     or new.status_link_pagamento is distinct from old.status_link_pagamento
     or new.status_baixa_pagamento is distinct from old.status_baixa_pagamento
     or new.ultimo_link_pagamento_id is distinct from old.ultimo_link_pagamento_id
     or new.ultima_baixa_pagamento_id is distinct from old.ultima_baixa_pagamento_id
     or new.registro_unico       is distinct from old.registro_unico
     or new.unificacao_status    is distinct from old.unificacao_status
     or new.chave_unificacao     is distinct from old.chave_unificacao
  then
    raise exception 'SEM_PERMISSAO_ALTERAR_COLUNA_SENSIVEL_ALUNO';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_cols_aluno on public.alunos;
create trigger trg_guard_cols_aluno
  before update on public.alunos
  for each row execute function public._guard_cols_aluno();

-- ----------------------------------------------------------------------------
-- 3. CASOS
-- ----------------------------------------------------------------------------
-- painel_negado / painel_sem_casos (RESTRICTIVE) e o guard financeiro
-- bloquear_alteracoes_restritas_casos permanecem inalterados.

-- INSERT: só caso da própria carteira (ou sem dono, ou gestão).
drop policy if exists casos_insert_todos on public.casos;
create policy casos_insert_todos on public.casos
  for insert to authenticated
  with check (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or operador_email is null
      or lower(operador_email) = public.app_email()
    )
  );

-- UPDATE: só a própria carteira, sem dono, ou gestão.
drop policy if exists casos_update_todos on public.casos;
create policy casos_update_todos on public.casos
  for update to authenticated
  using (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or operador_email is null
      or lower(operador_email) = public.app_email()
    )
  )
  with check (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or operador_email is null
      or lower(operador_email) = public.app_email()
    )
  );

-- DELETE: operador NÃO exclui caso. Somente gestão.
drop policy if exists casos_delete_todos on public.casos;
create policy casos_delete_gestao on public.casos
  for delete to authenticated
  using (
    public.app_usuario_ativo()
    and public.usuario_e_gestao()
  );

-- ----------------------------------------------------------------------------
-- 4. ACORDOS
-- ----------------------------------------------------------------------------
-- painel_negado (RESTRICTIVE), _guard_resp_acordo (troca de responsável) e
-- acordos_update_executor (role interna) permanecem inalterados.

-- INSERT: só cria acordo para aluno do próprio atendimento (ou gestão).
drop policy if exists acordos_insert on public.acordos;
create policy acordos_insert on public.acordos
  for insert to authenticated
  with check (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or (
        (coalesce(operador_responsavel_email, '') = ''
         or lower(operador_responsavel_email) = public.app_email())
        and exists (
          select 1 from public.alunos a
          where a.id = acordos.aluno_id
            and (coalesce(a.responsavel_atual_email, '') = ''
                 or lower(a.responsavel_atual_email) = public.app_email())
        )
      )
    )
  );

-- UPDATE: só acordo do próprio operador/aluno (ou gestão). Money columns
-- permanecem editáveis pelo dono (criar/cancelar/quitar), mas nunca cruzado.
drop policy if exists acordos_update on public.acordos;
create policy acordos_update on public.acordos
  for update to authenticated
  using (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or coalesce(operador_responsavel_email, '') = ''
      or lower(operador_responsavel_email) = public.app_email()
      or exists (
        select 1 from public.alunos a
        where a.id = acordos.aluno_id
          and public.app_email() <> ''
          and lower(coalesce(a.responsavel_atual_email, '')) = public.app_email()
      )
    )
  )
  with check (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or coalesce(operador_responsavel_email, '') = ''
      or lower(operador_responsavel_email) = public.app_email()
      or exists (
        select 1 from public.alunos a
        where a.id = acordos.aluno_id
          and public.app_email() <> ''
          and lower(coalesce(a.responsavel_atual_email, '')) = public.app_email()
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 5. ACORDOS_TITULOS
-- ----------------------------------------------------------------------------
-- painel_negado (RESTRICTIVE) permanece inalterado. Não havia guard nesta tabela;
-- a proteção passa a ser por titularidade do aluno.

-- INSERT: só inclui título para aluno do próprio atendimento (ou gestão).
drop policy if exists acordos_titulos_insert_authenticated on public.acordos_titulos;
create policy acordos_titulos_insert_authenticated on public.acordos_titulos
  for insert to authenticated
  with check (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or exists (
        select 1 from public.alunos a
        where a.id = acordos_titulos.aluno_id
          and (coalesce(a.responsavel_atual_email, '') = ''
               or lower(a.responsavel_atual_email) = public.app_email())
      )
    )
  );

-- UPDATE: só título de aluno do próprio atendimento (ou gestão).
drop policy if exists acordos_titulos_update_authenticated on public.acordos_titulos;
create policy acordos_titulos_update_authenticated on public.acordos_titulos
  for update to authenticated
  using (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or exists (
        select 1 from public.alunos a
        where a.id = acordos_titulos.aluno_id
          and (coalesce(a.responsavel_atual_email, '') = ''
               or lower(a.responsavel_atual_email) = public.app_email())
      )
    )
  )
  with check (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or exists (
        select 1 from public.alunos a
        where a.id = acordos_titulos.aluno_id
          and (coalesce(a.responsavel_atual_email, '') = ''
               or lower(a.responsavel_atual_email) = public.app_email())
      )
    )
  );

commit;
