-- ============================================================================
-- Migration: restringir escrita cruzada operacional (alunos, casos, acordos,
--            acordos_titulos)  +  Borderôs/Importações somente Amanda
-- Data.......: 2026-07-26
-- Branch.....: security/restringir-escrita-cruzada-operacional
--
-- ESCOPO (endurecimento de RLS compatível com os fluxos atuais):
--   1. Borderôs e Importações: SOMENTE Amanda (permissão central única).
--   2. Inclusão manual: operador só cria aluno/caso atribuído a si mesmo
--      (auth.email). Registro "livre" ou de terceiro: bloqueado para operador.
--   3. Escrita cruzada: operador só atualiza registros do próprio escopo;
--      DELETE de caso só gestão; DELETE de aluno/acordo/título continua sem
--      policy (bloqueado); anon/sem-cadastro/inativo bloqueados.
--   4. Fluxos financeiros ATUAIS preservados: a escrita financeira direta do
--      operador (criar/cancelar/quitar acordo, incluir/quitar título) continua
--      funcionando DESDE QUE o registro seja do próprio atendimento.
--
-- NÃO faz parte desta branch (fica para a branch financeira exclusiva):
--   * RPCs de criar/cancelar/quitar acordo;
--   * guard abrangente de colunas financeiras (saldo/valor/situação/quitação);
--   * alterações em baixas_pagamento, acordo_titulo_vinculo, carteira_operador.
--
-- RISCO RESIDUAL (documentado): após esta branch o operador NÃO altera dados
--   financeiros de OUTRO atendimento, mas AINDA pode enviar alterações
--   financeiras diretas nos registros do PRÓPRIO atendimento. Isso será
--   eliminado na branch financeira dedicada.
--
-- Preserva: service_role, postgres, role interna reativa_responsavel_executor,
--   RPCs SECURITY DEFINER, painel_negado/painel_sem_casos e os guards já
--   existentes (_guard_resp_aluno, _guard_resp_acordo,
--   bloquear_alteracoes_restritas_casos).
--
-- Idempotente. NÃO aplicar merge/deploy nesta etapa.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. HELPERS DE IDENTIDADE
-- ----------------------------------------------------------------------------

create or replace function public.app_email()
returns text language sql stable set search_path to 'public' as $$
  select lower(coalesce((auth.jwt() ->> 'email'), ''));
$$;

-- Autenticado + cadastrado + ativo (bloqueia anon, sem-cadastro e inativo).
create or replace function public.app_usuario_ativo()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
      and u.ativo is true
  );
$$;

-- Permissão CENTRAL e ÚNICA para Borderôs e Importações: SOMENTE Amanda.
-- (Não usa usuario_e_gestao(), que também autoriza Fernanda e Amanda ADM.)
-- A decisão é por e-mail do JWT (o chamador), não por current_user, para
-- funcionar corretamente dentro de RPCs SECURITY DEFINER (que rodam como
-- postgres). Chamadas de sistema sem usuário (cron/service_role/postgres)
-- permanecem preservadas.
create or replace function public.app_pode_borderos_importacoes()
returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    -- sem contexto de usuário final: chamadas internas de sistema
    return current_user in ('postgres','supabase_admin','service_role');
  end if;
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$$;

revoke all on function public.app_email() from public;
revoke all on function public.app_usuario_ativo() from public;
revoke all on function public.app_pode_borderos_importacoes() from public;
grant execute on function public.app_email() to authenticated, service_role;
grant execute on function public.app_usuario_ativo() to authenticated, service_role;
grant execute on function public.app_pode_borderos_importacoes() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. ALUNOS
-- ----------------------------------------------------------------------------

-- INSERT: operador só cria aluno ATRIBUÍDO A SI. Sem registro livre / de
-- terceiro. Gestão mantém o fluxo administrativo. Registros livres em massa
-- entram por importação/distribuição (RPCs SECURITY DEFINER, que ignoram RLS).
drop policy if exists "Enable insert for authenticated users only" on public.alunos;
create policy alunos_insert on public.alunos
  for insert to authenticated
  with check (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or lower(coalesce(responsavel_atual_email, '')) = public.app_email()
    )
  );

-- UPDATE: SOMENTE a própria carteira (responsável = eu) ou gestão.
-- NÃO permite update direto de registro livre/sem responsável: assumir aluno
-- livre é exclusivamente pela RPC sistema_assumir_atendimento (SECURITY
-- DEFINER), que valida operador ativo, atribuição atômica, limite de carteira
-- e fidelização. Troca de responsável continua barrada por _guard_resp_aluno.
drop policy if exists alunos_update on public.alunos;
create policy alunos_update on public.alunos
  for update to authenticated
  using (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or lower(coalesce(responsavel_atual_email, '')) = public.app_email()
    )
  )
  with check (
    not eh_painel()
    and public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or lower(coalesce(responsavel_atual_email, '')) = public.app_email()
    )
  );

-- ----------------------------------------------------------------------------
-- 3. CASOS
-- ----------------------------------------------------------------------------

-- INSERT: operador só cria caso ATRIBUÍDO A SI. Gestão mantém o fluxo.
drop policy if exists casos_insert_todos on public.casos;
create policy casos_insert_todos on public.casos
  for insert to authenticated
  with check (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email, '')) = public.app_email()
    )
  );

-- UPDATE: SOMENTE a própria carteira (operador_email = eu) ou gestão.
-- NÃO permite update direto de caso livre/sem dono: assumir caso livre é
-- exclusivamente pela RPC de assumir atendimento (SECURITY DEFINER), que
-- valida atribuição atômica, limite de 500 e fidelização. Isso impede que um
-- UPDATE direto contorne o limite de carteira.
drop policy if exists casos_update_todos on public.casos;
create policy casos_update_todos on public.casos
  for update to authenticated
  using (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email, '')) = public.app_email()
    )
  )
  with check (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email, '')) = public.app_email()
    )
  );

-- DELETE: operador NÃO exclui caso. Somente gestão.
drop policy if exists casos_delete_todos on public.casos;
create policy casos_delete_gestao on public.casos
  for delete to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao());

-- ----------------------------------------------------------------------------
-- 4. ACORDOS
-- ----------------------------------------------------------------------------
-- _guard_resp_acordo (troca de responsável) e acordos_update_executor
-- permanecem. Fluxos financeiros do próprio atendimento preservados.

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

-- ----------------------------------------------------------------------------
-- 6. IMPORTAÇÃO DE ACORDOS (Borderô) — trava de permissão SOMENTE Amanda
--    Recriação idêntica da função com um guard no topo; corpo inalterado.
-- ----------------------------------------------------------------------------
create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '180000'
as $function$
declare v_alunos_novos int:=0; v_titulos int:=0; v_fila int:=0; v_usuario text;
begin
  -- >>> trava de permissão: Borderô/Importação SOMENTE Amanda (ou sistema).
  if not public.app_pode_borderos_importacoes() then
    raise exception 'SEM_PERMISSAO_IMPORTACAO_BORDERO';
  end if;

  v_usuario := coalesce(nullif(auth.jwt()->>'email',''), 'sistema');
  insert into public.importacoes (id,tipo,referencia,arquivo_nome,usuario,status,retroativo)
  values (p_importacao_id,'ACORDOS','Relatorio de Titulos em Aberto (Acordo)','Relatorio Titulos em Aberto',v_usuario,'Concluída',false)
  on conflict (id) do nothing;

  create temp table _imp on commit drop as
  with base as (
    select regexp_replace(coalesce(l->>'cpf',''),'\D','','g') as cpf, nullif(trim(l->>'nome'),'') as nome,
           regexp_replace(coalesce(l->>'documento',''),'\D','','g') as documento, nullif(l->>'venc','')::date as venc,
           nullif(l->>'valor','')::numeric as valor, nullif(trim(l->>'unidade'),'') as unidade, nullif(trim(l->>'situacao'),'') as situacao
    from jsonb_array_elements(p_linhas) l)
  select cpf,nome,documento,venc,valor,unidade,situacao, left(documento,greatest(length(documento)-2,1)) as acordo_base
  from base where documento <> '';
  create index on _imp(cpf);
  create temp table _al on commit drop as select id, regexp_replace(coalesce(cpf,''),'\D','','g') as cpf_n from public.alunos;
  create index on _al(cpf_n);

  insert into public.alunos (nome,cpf,unidade,situacao_academica,status_jornada,tipo_base,origem,observacao)
  select distinct on (i.cpf) coalesce(i.nome,'(sem nome)'),i.cpf,i.unidade,i.situacao,'Em cobrança','ACORDO_IMPORTADO','IMPORT_ACORDOS',
         'Importado do Relatorio de Titulos em Aberto (Acordo) — lote '||p_importacao_id::text
  from _imp i where i.cpf<>'' and not exists (select 1 from _al a where a.cpf_n=i.cpf) order by i.cpf;
  get diagnostics v_alunos_novos = row_count;
  insert into _al (id,cpf_n) select id, regexp_replace(coalesce(cpf,''),'\D','','g')
  from public.alunos where origem='IMPORT_ACORDOS' and observacao like '%'||p_importacao_id::text;

  insert into public.acordos_titulos (aluno_id,cpf,documento,vencimento,valor_original,valor_em_aberto,situacao,status,tipo_boleto,importacao_id)
  select (select a.id from _al a where a.cpf_n=i.cpf limit 1), i.cpf,i.documento,i.venc,i.valor,i.valor,'ABERTO','vinculada','Acordo',p_importacao_id
  from _imp i where not exists (select 1 from public.acordos_titulos t where t.documento=i.documento);
  get diagnostics v_titulos = row_count;

  insert into public.fila_acordos_confirmar (aluno_id,cpf,nome,acordo_base,qtd_parcelas,valor_total,unidade,situacao_aluno,importacao_id)
  select (select a.id from _al a where a.cpf_n=i.cpf limit 1), i.cpf, max(i.nome), i.acordo_base, count(*), round(sum(coalesce(i.valor,0)),2), max(i.unidade), max(i.situacao), p_importacao_id
  from _imp i group by i.cpf, i.acordo_base
  on conflict (cpf,acordo_base) do nothing;
  get diagnostics v_fila = row_count;

  update public.fila_acordos_confirmar f set qtd_parcelas=a.qtd, valor_total=a.total
  from (select regexp_replace(coalesce(cpf,''),'\D','','g') cpf_n, left(documento,greatest(length(documento)-2,1)) acordo_base,
               count(*) qtd, round(sum(coalesce(valor_em_aberto,valor_original,0)),2) total
        from public.acordos_titulos where importacao_id=p_importacao_id and tipo_boleto='Acordo' group by 1,2) a
  where regexp_replace(coalesce(f.cpf,''),'\D','','g')=a.cpf_n and f.acordo_base=a.acordo_base;

  insert into public.acordos (aluno_id,cpf,tipo,forma_pagamento,valor_total,qtd_parcelas,status,unidade,saldo,observacao,criado_por_email,criado_por_nome,criado_em,atualizado_em)
  select f.aluno_id,f.cpf,'ACORDO','PARCELADO',f.valor_total,f.qtd_parcelas,'ATIVO',f.unidade,f.valor_total,
         'Importado do Relatorio de Titulos em Aberto (Acordo) — lote '||p_importacao_id::text,'importacao@sistema','Importacao Acordos',now(),now()
  from public.fila_acordos_confirmar f
  where f.importacao_id=p_importacao_id
    and not exists (select 1 from public.acordos a where a.aluno_id=f.aluno_id
                    and a.valor_total=f.valor_total and a.observacao like '%'||p_importacao_id::text);

  update public.importacoes set qtd_registros=coalesce(qtd_registros,0)+v_titulos where id=p_importacao_id;
  return json_build_object('alunos_novos',v_alunos_novos,'titulos_inseridos',v_titulos,'acordos_na_fila',v_fila,'importacao_id',p_importacao_id);
end; $function$;

commit;
