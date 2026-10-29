-- Acordos importados entravam só com o valor total: a RPC importar_acordos criava
-- o cabeçalho do acordo (valor_total, qtd_parcelas) mas NÃO populava a tabela
-- `parcelas` (fonte que a Ficha 360 / Aba Acordos lê). As parcelas reais ficavam
-- apenas em acordos_titulos (sem acordo_id). Ontem isso foi corrigido em massa via
-- completar_parcelas_acordo; hoje reincidiu para os lotes novos.
--
-- Esta migration:
--  1) Cria a fila de revisão de acordos sem parcelas seguras (acordos_revisao_parcelas).
--  2) Enfileira os 9 acordos do lote 63fbaa7b cujas parcelas estão em quarentena e
--     não têm correspondência SEGURA (soma não bate valor_total por causa de entrada,
--     e a origem se mistura com o lote de risco de dobra 743aafd3). Não reconstruir
--     por aproximação — decisão humana.
--  3) Corrige a CAUSA RAIZ: importar_acordos passa a chamar completar_parcelas_acordo
--     ao final, para toda importação futura já popular `parcelas` (idempotente/logado).
--
-- O backfill dos 56 acordos do lote de hoje (títulos vivos em acordos_titulos) foi
-- executado à parte via completar_parcelas_acordo (lotes acordos_fix_20260731_*).

-- ---------------------------------------------------------------------------
-- 1) Fila de revisão
-- ---------------------------------------------------------------------------
create table if not exists public.acordos_revisao_parcelas (
  acordo_id      uuid primary key references public.acordos(id) on delete cascade,
  numero_acordo  bigint,
  aluno_id       uuid,
  cpf            text,
  valor_total    numeric,
  qtd_parcelas   integer,
  importacao_id  uuid,
  motivo         text not null,
  status         text not null default 'PENDENTE',
  criado_em      timestamptz not null default now(),
  resolvido_em   timestamptz,
  resolvido_por  text
);

alter table public.acordos_revisao_parcelas enable row level security;

-- Leitura para quem cuida de importação/gestão de acordos; escrita idem.
drop policy if exists arp_select on public.acordos_revisao_parcelas;
create policy arp_select on public.acordos_revisao_parcelas
  for select using (
    coalesce(auth.role(),'') = 'service_role'
    or public.fila_acordos_pode_vincular()
    or public.app_pode_borderos_importacoes()
  );

drop policy if exists arp_write on public.acordos_revisao_parcelas;
create policy arp_write on public.acordos_revisao_parcelas
  for all using (
    coalesce(auth.role(),'') = 'service_role'
    or public.fila_acordos_pode_vincular()
    or public.app_pode_borderos_importacoes()
  ) with check (
    coalesce(auth.role(),'') = 'service_role'
    or public.fila_acordos_pode_vincular()
    or public.app_pode_borderos_importacoes()
  );

-- ---------------------------------------------------------------------------
-- 2) Enfileira acordos ATIVOS sem parcelas cujas parcelas NÃO existem vivas em
--    acordos_titulos (não alcançáveis por completar_parcelas_acordo). Idempotente.
-- ---------------------------------------------------------------------------
insert into public.acordos_revisao_parcelas
  (acordo_id, numero_acordo, aluno_id, cpf, valor_total, qtd_parcelas, importacao_id, motivo)
select a.id, a.numero_acordo, a.aluno_id, a.cpf, a.valor_total, a.qtd_parcelas,
       substring(a.observacao from 'lote ([0-9a-f-]{36})')::uuid,
       'Sem parcela viva em acordos_titulos; origem em quarentena e sem correspondencia segura (soma nao bate valor_total por entrada / lote de risco de dobra). Revisar manualmente com o arquivo de origem.'
from public.acordos a
where upper(coalesce(a.status,'')) = 'ATIVO'
  and not exists (select 1 from public.parcelas p where p.acordo_id = a.id)
  and not exists (
    select 1 from public.acordos_titulos t
    where t.aluno_id = a.aluno_id
      and length(regexp_replace(coalesce(t.documento,''),'\D','','g')) >= 10
  )
on conflict (acordo_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3) Causa raiz: importar_acordos passa a completar parcelas ao final.
-- ---------------------------------------------------------------------------
create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '180000'
as $function$
declare v_alunos_novos int:=0; v_titulos int:=0; v_fila int:=0; v_usuario text; v_completados int:=0;
begin
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

  -- CAUSA RAIZ: popular a tabela `parcelas` (fonte da Ficha 360 / Aba Acordos) a partir
  -- dos titulos do acordo. Idempotente e logado; move titulo p/ quarentena (sem dobra).
  select count(*) into v_completados
  from public.completar_parcelas_acordo(
         p_limite       => 100000,
         p_dry_run      => false,
         p_lote         => 'import_'||p_importacao_id::text,
         p_executado_por=> v_usuario);

  update public.importacoes set qtd_registros=coalesce(qtd_registros,0)+v_titulos where id=p_importacao_id;
  return json_build_object('alunos_novos',v_alunos_novos,'titulos_inseridos',v_titulos,'acordos_na_fila',v_fila,'acordos_completados',v_completados,'importacao_id',p_importacao_id);
end; $function$;
