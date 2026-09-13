-- Titulo importado pelo "Relatorio de Titulos em Aberto" passa a nascer com
-- saldo_corrigido preenchido, igual ao borderô ja faz.
--
-- O PROBLEMA
-- ----------
-- Existem dois caminhos de importacao e eles preenchem colunas de valor
-- DIFERENTES:
--
--   borderô (src/pages/Borderos.jsx)      -> valor_original + saldo_corrigido
--   Relatorio de Titulos em Aberto        -> valor_original + valor_em_aberto
--   (src/pages/ImportacaoAcordos.jsx, que chama esta funcao)
--
-- Enquanto o titulo do segundo caminho fica com status 'vinculada' nao ha
-- problema: ele nao e cobravel e ninguem o soma. Mas quando o acordo e
-- cancelado, `acordo_cancelar` devolve o titulo para 'em_aberto' -- e ele vira
-- cobravel SEM saldo_corrigido.
--
-- Cinco rotinas leem `coalesce(saldo_corrigido, 0)` sem cair para as outras
-- colunas, e para elas esse titulo vale ZERO:
--
--   listar_casos_sem_valor      -- classifica o aluno como "sem valor"
--   receber_leads               -- distribui lead por valor
--   resumo_carteira_operador    -- subestima a carteira
--   dashboard_gestao_geral_impl -- painel por unidade
--   saldo_titulos_aberto
--
-- Medido em producao em 13/09/2026, somente leitura:
--   51 titulos ja cobraveis nessa situacao        R$  79.381,07
--   32 alunos afetados, 13 com caso aberto
--   23 alunos cujo saldo INTEIRO vem desses       R$  62.893,14
--   312 titulos ainda 'vinculada' sem a coluna    R$ 297.472,09
--   311 deles com acordo ATIVO (exposicao viva)   R$ 297.043,37
--   ultima importacao por este caminho: 11/09/2026
--
-- O QUE ESTA MIGRATION FAZ
-- ------------------------
-- Acrescenta `saldo_corrigido` ao INSERT de acordos_titulos, com o MESMO valor
-- que ja vai para `valor_original` e `valor_em_aberto` (`i.valor`). Duas
-- palavras no comando; o resto da funcao e identico, byte a byte.
--
-- PROSPECTIVA. Vale so para INSERT novo. Nao ha UPDATE, nao ha backfill:
--   * os 392 titulos existentes nao sao tocados;
--   * os 51 ja cobraveis continuam como estao;
--   * os 311 ainda vinculados continuam como estao.
-- A correcao do estoque existente e decisao separada.
--
-- Nao toca Santander/pagamentos, Prime, cron, casos, acordos nem
-- acordo_cancelar.
create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '180000'
as $function$
declare v_alunos_novos int:=0; v_titulos int:=0; v_fila int:=0; v_usuario text;
        v_completados int:=0; v_dup int:=0; v_pulados int:=0; v_linhas_puladas int:=0;
        v_ja_representados int:=0;
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'SEM_PERMISSAO_IMPORTACAO_BORDERO';
  end if;

  perform set_config('reativa.importando', 'on', true);
  perform pg_advisory_xact_lock(hashtextextended(p_importacao_id::text, 0));

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

  create temp table _pular on commit drop as
  select distinct regexp_replace(coalesce(al.cpf,''),'\D','','g') as cpf_n
  from public.casos c
  join public.alunos al on al.id = c.aluno_id
  where c.quitado_em is not null and c.quitado_em >= current_date - 7
    and exists (select 1 from public.acordos a where a.aluno_id = c.aluno_id)
    and coalesce(al.cpf,'') <> '';
  create index on _pular(cpf_n);

  select count(*) into v_linhas_puladas from _imp i join _pular p on p.cpf_n = i.cpf;
  select count(distinct i.cpf) into v_pulados from _imp i join _pular p on p.cpf_n = i.cpf;
  delete from _imp i using _pular p where p.cpf_n = i.cpf;

  create temp table _al on commit drop as select id, regexp_replace(coalesce(cpf,''),'\D','','g') as cpf_n from public.alunos;
  create index on _al(cpf_n);

  insert into public.alunos (nome,cpf,unidade,situacao_academica,status_jornada,tipo_base,origem,observacao)
  select distinct on (i.cpf) coalesce(i.nome,'(sem nome)'),i.cpf,i.unidade,i.situacao,'Em cobrança','ACORDO_IMPORTADO','IMPORT_ACORDOS',
         'Importado do Relatorio de Titulos em Aberto (Acordo) — lote '||p_importacao_id::text
  from _imp i where i.cpf<>'' and not exists (select 1 from _al a where a.cpf_n=i.cpf) order by i.cpf;
  get diagnostics v_alunos_novos = row_count;
  insert into _al (id,cpf_n) select id, regexp_replace(coalesce(cpf,''),'\D','','g')
  from public.alunos where origem='IMPORT_ACORDOS' and observacao like '%'||p_importacao_id::text;

  -- A divida ja representada no CRM nao vira titulo de novo.
  select count(*) into v_ja_representados from _imp i
   where exists (select 1 from public.parcelas p where p.boleto = ltrim(i.documento,'0'))
      or (i.documento ~ '^\d{12}$'
          and exists (select 1 from public.acordos a
                       where a.numero_ulbra = substr(i.documento,4,5)
                         and upper(coalesce(a.status,'')) <> 'CANCELADO'));

  -- saldo_corrigido nasce junto, com o MESMO valor de valor_original e
  -- valor_em_aberto. Sem isto, o titulo fica invisivel para as cinco rotinas
  -- que leem `coalesce(saldo_corrigido, 0)` no dia em que o acordo for
  -- cancelado e ele voltar para 'em_aberto'. E o que o borderô ja faz.
  insert into public.acordos_titulos (aluno_id,cpf,documento,vencimento,valor_original,valor_em_aberto,saldo_corrigido,situacao,status,tipo_boleto,importacao_id)
  select (select a.id from _al a where a.cpf_n=i.cpf limit 1), i.cpf,i.documento,i.venc,i.valor,i.valor,i.valor,'ABERTO','vinculada','Acordo',p_importacao_id
  from _imp i
  where not exists (select 1 from public.acordos_titulos t where t.documento=i.documento)
    -- ja existe parcela com esse documento: a parcela representa a divida
    and not exists (select 1 from public.parcelas p where p.boleto = ltrim(i.documento,'0'))
    -- o acordo ja existe no CRM: as parcelas dele cobrem a divida
    and not (i.documento ~ '^\d{12}$'
             and exists (select 1 from public.acordos a
                          where a.numero_ulbra = substr(i.documento,4,5)
                            and upper(coalesce(a.status,'')) <> 'CANCELADO'));
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

  -- Acordo novo so nasce se aquele numero da Ulbra ainda nao existe no CRM.
  insert into public.acordos (aluno_id,cpf,tipo,forma_pagamento,valor_total,qtd_parcelas,status,unidade,saldo,observacao,criado_por_email,criado_por_nome,numero_ulbra,criado_em,atualizado_em)
  select f.aluno_id,f.cpf,'ACORDO','PARCELADO',f.valor_total,f.qtd_parcelas,'ATIVO',f.unidade,f.valor_total,
         'Importado do Relatorio de Titulos em Aberto (Acordo) — lote '||p_importacao_id::text,
         'importacao@sistema','Importacao Acordos', substr(f.acordo_base,4,5), now(),now()
  from public.fila_acordos_confirmar f
  where f.importacao_id=p_importacao_id
    and f.acordo_base ~ '^\d{10}$'
    and not exists (select 1 from public.acordos a where a.numero_ulbra = substr(f.acordo_base,4,5))
    and not exists (select 1 from public.acordos a where a.aluno_id=f.aluno_id
                    and a.valor_total=f.valor_total and a.observacao like '%'||p_importacao_id::text)
  on conflict do nothing;

  select count(*) into v_dup from public.acordos a
   where a.duplicado_de is not null and a.observacao like '%'||p_importacao_id::text;

  select count(*) into v_completados
  from public.completar_parcelas_acordo(
         p_limite => 100000, p_dry_run => false,
         p_lote => 'import_'||p_importacao_id::text, p_executado_por=> v_usuario);

  update public.importacoes set qtd_registros=coalesce(qtd_registros,0)+v_titulos where id=p_importacao_id;
  return json_build_object('alunos_novos',v_alunos_novos,'titulos_inseridos',v_titulos,'acordos_na_fila',v_fila,
                           'acordos_completados',v_completados,'acordos_duplicados_sinalizados',v_dup,
                           'cpfs_pulados_quitados',v_pulados,'linhas_puladas_quitados',v_linhas_puladas,
                           'linhas_ja_representadas_no_crm',v_ja_representados,
                           'importacao_id',p_importacao_id);
end; $function$;

revoke all on function public.importar_acordos(jsonb, uuid) from public, anon;
grant execute on function public.importar_acordos(jsonb, uuid) to authenticated;

comment on function public.importar_acordos(jsonb, uuid) is
  'Importa o Relatorio de Titulos em Aberto (acordos). O titulo nasce com valor_original = valor_em_aberto = saldo_corrigido, para nao ficar invisivel as rotinas que leem coalesce(saldo_corrigido,0) quando o acordo for cancelado e ele voltar a em_aberto. Prospectiva: nao altera titulo existente.'
