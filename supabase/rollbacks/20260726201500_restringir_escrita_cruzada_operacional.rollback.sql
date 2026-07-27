-- ============================================================================
-- ROLLBACK de 20260726201500_restringir_escrita_cruzada_operacional
-- ============================================================================
-- ATENÇÃO / EMERGÊNCIA:
--   Este script REABRE a escrita cruzada em alunos/casos/acordos/acordos_titulos
--   (USING true / WITH CHECK true), volta a permitir INSERT livre/de terceiro,
--   reabre DELETE de caso para qualquer autenticado e REMOVE a trava de
--   Borderô/Importação (importar_acordos volta a aceitar qualquer chamador
--   autorizado por grant). Use SOMENTE em emergência e reverta o quanto antes.
--   Não altera grants nem os guards pré-existentes.
-- ============================================================================

begin;

-- ---- ACORDOS_TITULOS ----
drop policy if exists acordos_titulos_insert_authenticated on public.acordos_titulos;
create policy acordos_titulos_insert_authenticated on public.acordos_titulos
  for insert to authenticated with check (true);
drop policy if exists acordos_titulos_update_authenticated on public.acordos_titulos;
create policy acordos_titulos_update_authenticated on public.acordos_titulos
  for update to authenticated using (true) with check (true);

-- ---- ACORDOS ----
drop policy if exists acordos_insert on public.acordos;
create policy acordos_insert on public.acordos
  for insert to authenticated with check (true);
drop policy if exists acordos_update on public.acordos;
create policy acordos_update on public.acordos
  for update to authenticated using (true);

-- ---- CASOS ----
drop policy if exists casos_insert_todos on public.casos;
create policy casos_insert_todos on public.casos
  for insert to authenticated with check (true);
drop policy if exists casos_update_todos on public.casos;
create policy casos_update_todos on public.casos
  for update to authenticated using (true) with check (true);
drop policy if exists casos_delete_gestao on public.casos;
create policy casos_delete_todos on public.casos
  for delete to authenticated using (true);

-- ---- ALUNOS ----
drop policy if exists alunos_insert on public.alunos;
create policy "Enable insert for authenticated users only" on public.alunos
  for insert to authenticated with check (true);
drop policy if exists alunos_update on public.alunos;
create policy alunos_update on public.alunos
  for update to authenticated using (not eh_painel());

-- ---- IMPORTAR_ACORDOS: remover a trava (versão anterior, sem guard) ----
create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
 returns json language plpgsql security definer set search_path to 'public'
 set statement_timeout to '180000'
as $function$
declare v_alunos_novos int:=0; v_titulos int:=0; v_fila int:=0; v_usuario text;
begin
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

-- ---- HELPERS: remover ----
drop function if exists public.app_pode_borderos_importacoes();
drop function if exists public.app_usuario_ativo();
drop function if exists public.app_email();

commit;
