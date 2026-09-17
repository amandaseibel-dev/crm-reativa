-- ROLLBACK de 20260917200000_parcela_paga_antes_da_extracao.
-- Recria os quatro corpos EXATOS de producao de 17/09/2026 e remove as quatro
-- funcoes novas. Nao desfaz parcela ja reconstruida (isso e dado, com auditoria
-- RECONSTRUCAO_PARCELA_PAGA_ANTES_DA_EXTRACAO) e deixa a linha de
-- fluxo_pagamentos_config (sem funcao, a etapa nao roda).
--   _pagamentos_baixar_lote     6a0a351ce133c8d5e1ab89050a12f456
--   fluxo_pagamentos_rodar      8255c8d416683c59ddcaa28b5c5195a2
--   completar_parcelas_acordo   1e4c6853005940da5048bb5e052f9153
--   importar_acordos            1bb69aed2ed0b263ff43009e6b744691

-- ---------------------------------------------------------------------------
-- _pagamentos_baixar_lote (producao 17/09/2026)
-- ---------------------------------------------------------------------------
create or replace function public._pagamentos_baixar_lote()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_res jsonb;
begin
  perform set_config('reativa.fluxo_pagamentos','on', true);
  begin
    v_res := public.baixa_pelo_relatorio_pagamento(true, (current_date - 180));
  exception when others then
    -- a baixa e melhoria, nao condicao: a importacao nao pode cair por causa
    -- dela. Fica o registro para alguem olhar.
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina','BAIXA_LOTE_FALHOU','pagamentos', null,
            jsonb_build_object('erro', SQLERRM));
    return null;
  end;
  return null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- fluxo_pagamentos_rodar (producao 17/09/2026)
-- ---------------------------------------------------------------------------
create or replace function public.fluxo_pagamentos_rodar(p_origem text default 'cron'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_antes numeric; v_depois numeric; v_res jsonb := '{}'::jsonb;
  v_liga boolean; v_carga jsonb; v_erro text;
begin
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
    values (p_origem, jsonb_build_object('pulou','sistema sob carga'));
    return jsonb_build_object('pulou','sistema sob carga');
  end if;

  perform set_config('reativa.fluxo_pagamentos','on', true);
  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  begin
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='amarrar_boleto';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('amarrar_boleto', public.parcelas_amarrar_boleto());
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='pos_importacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('pos_importacao', public.acordos_pos_importacao(null, true));
    end if;

    -- le o numero no pagamento, grava na parcela e baixa
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_pelo_relatorio';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa_pelo_relatorio', public.baixa_pelo_relatorio_pagamento(true, (current_date - 180)));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_por_documento';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa', public.baixa_por_documento_aplicar('2026-07-01', true));
    else
      v_res := v_res || jsonb_build_object('baixa_previa', public.baixa_por_documento_aplicar('2026-07-01', false));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='sinalizar_duplicado';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('duplicados', public.acordos_sinalizar_boleto_repetido());
    end if;

    -- O acordo diz de onde veio. Por ultimo: nao altera as etapas acima.
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='vinculo_por_negociacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('vinculo_por_negociacao', public.prime_vincular_por_negociacao(true, 3));
    end if;
  exception when others then
    v_erro := SQLERRM;
  end;

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;
  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values (p_origem, v_antes, v_depois, v_res, v_erro);

  return jsonb_build_object('carteira_antes',v_antes,'carteira_depois',v_depois,
    'variacao', round(v_depois-v_antes,2), 'etapas', v_res, 'erro', v_erro);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- completar_parcelas_acordo (producao 17/09/2026)
-- ---------------------------------------------------------------------------
create or replace function public.completar_parcelas_acordo(
  p_limite integer default 5,
  p_dry_run boolean default true,
  p_lote text default null::text,
  p_executado_por text default 'completar_parcelas_acordo'::text)
 returns table(acordo_id uuid, numero_acordo bigint, aluno_id uuid,
               qtd_parcelas integer, valor_total numeric, acao text)
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  r record; t record;
  v_n int := 0;
  v_lote text := coalesce(p_lote, to_char(now(),'YYYYMMDDHH24MISS'));
  v_pid uuid; v_qtd int; v_soma numeric;
begin
  if not public._gate_completar_parcelas() then
    raise exception 'Acesso negado: completar_parcelas_acordo exige permissao de importacao ou gestao de acordos.' using errcode='42501';
  end if;

  for r in
    with alvo as (
      select a.id, a.aluno_id, a.numero_acordo, a.valor_total
      from public.acordos a
      where upper(coalesce(a.status,''))='ATIVO'
        and not exists (select 1 from public.parcelas pa where pa.acordo_id=a.id)
    ),
    qbase as (
      select t2.aluno_id,
        left(regexp_replace(t2.documento,'\D','','g'), length(regexp_replace(t2.documento,'\D','','g'))-2) as base,
        count(*) qtd, round(sum(coalesce(t2.valor_original,t2.valor_em_aberto,0)),2) soma
      from public.acordos_titulos t2
      where length(regexp_replace(coalesce(t2.documento,''),'\D','','g')) >= 10
      group by 1,2
    )
    select alvo.id, alvo.aluno_id, alvo.numero_acordo, alvo.valor_total, qb.base, qb.qtd, qb.soma
    from alvo
    join qbase qb on qb.aluno_id=alvo.aluno_id and abs(qb.soma-alvo.valor_total)<=0.02
    where (select count(*) from qbase qx where qx.aluno_id=alvo.aluno_id and abs(qx.soma-alvo.valor_total)<=0.02)=1
      and (select count(*) from public.acordos a2 where a2.aluno_id=alvo.aluno_id and abs(a2.valor_total-alvo.valor_total)<=0.02
             and upper(coalesce(a2.status,''))='ATIVO' and not exists (select 1 from public.parcelas pa where pa.acordo_id=a2.id))=1
    order by alvo.numero_acordo
  loop
    exit when v_n >= coalesce(p_limite, 2147483647);
    acordo_id:=r.id; numero_acordo:=r.numero_acordo; aluno_id:=r.aluno_id; valor_total:=r.valor_total; qtd_parcelas:=r.qtd;
    if p_dry_run then acao:='DRY_RUN'; return next; v_n:=v_n+1; continue; end if;

    v_qtd:=0; v_soma:=0;
    for t in
      select tt.id, right(regexp_replace(tt.documento,'\D','','g'),2)::int as numero,
             coalesce(tt.valor_original,tt.valor_em_aberto,0) as valor, tt.vencimento,
             -- ACRESCENTADO: o boleto da PROPRIA linha-fonte, normalizado para o
             -- formato de 11 digitos que o CRM usa. Nao deriva de numero, valor
             -- nem vencimento.
             ltrim(regexp_replace(tt.documento,'\D','','g'),'0') as boleto,
             to_jsonb(tt.*) as snap
      from public.acordos_titulos tt
      where tt.aluno_id=r.aluno_id
        and length(regexp_replace(coalesce(tt.documento,''),'\D','','g'))>=10
        and left(regexp_replace(tt.documento,'\D','','g'), length(regexp_replace(tt.documento,'\D','','g'))-2)=r.base
      order by 1
    loop
      v_pid:=gen_random_uuid();
      -- ACRESCENTADO no INSERT: a coluna `boleto`, alimentada por t.boleto.
      insert into public.parcelas(id,acordo_id,numero,valor,vencimento,status,is_entrada,boleto,observacao,criado_em,atualizado_em)
      values(v_pid,r.id,t.numero,t.valor,t.vencimento,
             case when t.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,false,
             t.boleto,
             'Gerada da importacao (lote '||v_lote||') a partir do titulo do acordo; titulo movido p/ quarentena (sem dobra).',now(),now());
      insert into public._backup_completar_parcelas_lote(lote,acordo_id,acao,parcela_id,executado_por)
      values(v_lote,r.id,'PARCELA_CRIADA',v_pid,p_executado_por);

      insert into public._backup_parcelas_acordo_erro_import
        (id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,tipo_boleto,dados,importacao_id,created_at,status,valor_em_aberto,competencia,motivo_ajuste,atualizado_em,acordo_id,vinculado_em,vinculado_por)
      select src.id,src.aluno_id,src.cpf,src.documento,src.vencimento,src.valor_original,src.saldo_corrigido,src.situacao,src.tipo_boleto,src.dados,src.importacao_id,src.created_at,src.status,src.valor_em_aberto,src.competencia,
             'Movido p/ quarentena ao gerar parcela do acordo (lote '||v_lote||') - evita dobra',src.atualizado_em,src.acordo_id,src.vinculado_em,src.vinculado_por
      from public.acordos_titulos src where src.id=t.id;
      insert into public._backup_completar_parcelas_lote(lote,acordo_id,acao,titulo_id,titulo_snapshot,executado_por)
      values(v_lote,r.id,'TITULO_QUARENTENA',t.id,t.snap,p_executado_por);
      delete from public.acordos_titulos src where src.id=t.id;

      v_qtd:=v_qtd+1; v_soma:=v_soma+coalesce(t.valor,0);
    end loop;
    if abs(v_soma-r.valor_total)>0.02 then
      raise exception 'Divergencia acordo %: soma parcelas % <> valor_total %', r.numero_acordo, v_soma, r.valor_total;
    end if;
    acao:='COMPLETADO('||v_qtd||')'; return next; v_n:=v_n+1;
  end loop;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- importar_acordos (producao 17/09/2026)
-- ---------------------------------------------------------------------------
create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '180000'
as $fn$
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
end; $fn$;

drop function if exists public.parcela_paga_antes_apos_importar_acordos(uuid);
drop function if exists public.parcela_paga_antes_reconstruir_pendentes(integer, uuid[]);
drop function if exists public.parcela_paga_antes_reconstruir(uuid, boolean);
drop function if exists public.parcela_paga_antes_previa(uuid);
