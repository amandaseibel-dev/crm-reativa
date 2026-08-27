-- A importacao nao ressuscita quem foi quitado nesta semana.
--
-- Amanda, 27/08/2026: "quando esta quitado tudo e tem acordo nao importar se
-- for da mesma semana, e sinal que ja foi validado e baixado no sistema".
--
-- O PROBLEMA. O relatorio da Prime e uma foto: lista os titulos que estavam em
-- aberto quando foi gerado. Quando a Amanda quita um aluno aqui, a Prime demora
-- a refletir -- entao o arquivo da semana seguinte AINDA traz aquele aluno com
-- divida. Importar isso recria titulo, fila e acordo para alguem ja conferido e
-- baixado: a divida volta do zero e o trabalho e refeito.
--
-- Sao 131 quitacoes nos ultimos 7 dias, 61 delas com acordo, R$ 227.268,01 --
-- exatamente o que a proxima importacao traria de volta.
--
-- A REGRA. Pula o CPF que, ao mesmo tempo:
--   1. esta quitado de verdade  (casos.quitado_em preenchido -- a ancora com
--      data, valor e origem; nao e "parece zerado")
--   2. tem acordo no sistema
--   3. a quitacao e RECENTE: ultimos 7 dias
--
-- OS TRES JUNTOS. Quitado ha meses volta a ser importado normalmente -- ai
-- divida nova e divida nova de verdade.
--
-- POR QUE 7 DIAS CORRIDOS e nao a semana do calendario: se ela importa numa
-- segunda-feira, a semana do calendario cobre so a segunda, e tudo que foi
-- quitado na sexta e no sabado voltaria. Sete dias corridos cobrem a janela que
-- ela chamou de "mesma semana" em qualquer dia que ela rode.
--
-- O corte acontece no _imp, logo depois de montar -- entao vale para titulos,
-- fila e acordos de uma vez. E devolve quantos CPFs pulou, para a tela dizer.
--
-- Traz junto (de 20260827131950) o sinal `reativa.importando`, que faz a trava
-- de duplicidade SINALIZAR em vez de derrubar o lote inteiro.

create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '180000'
as $function$
declare v_alunos_novos int:=0; v_titulos int:=0; v_fila int:=0; v_usuario text;
        v_completados int:=0; v_dup int:=0; v_pulados int:=0; v_linhas_puladas int:=0;
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'SEM_PERMISSAO_IMPORTACAO_BORDERO';
  end if;

  -- Duplicidade na importacao e AVISO, nao parede: a trava marca acordos.
  -- duplicado_de em vez de derrubar o lote inteiro. Local a esta transacao.
  perform set_config('reativa.importando', 'on', true);

  -- Serializa chunks do MESMO lote: elimina a corrida que gerava acordos duplicados.
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

  -- CPFs quitados nesta semana COM acordo: a Prime ainda nao refletiu a baixa.
  create temp table _pular on commit drop as
  select distinct regexp_replace(coalesce(al.cpf,''),'\D','','g') as cpf_n
  from public.casos c
  join public.alunos al on al.id = c.aluno_id
  where c.quitado_em is not null
    and c.quitado_em >= current_date - 7
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
                    and a.valor_total=f.valor_total and a.observacao like '%'||p_importacao_id::text)
  on conflict do nothing;

  -- Quantos entraram sinalizados como duplicata neste lote.
  select count(*) into v_dup
  from public.acordos a
  where a.duplicado_de is not null
    and a.observacao like '%'||p_importacao_id::text;

  select count(*) into v_completados
  from public.completar_parcelas_acordo(
         p_limite       => 100000,
         p_dry_run      => false,
         p_lote         => 'import_'||p_importacao_id::text,
         p_executado_por=> v_usuario);

  update public.importacoes set qtd_registros=coalesce(qtd_registros,0)+v_titulos where id=p_importacao_id;
  return json_build_object('alunos_novos',v_alunos_novos,'titulos_inseridos',v_titulos,'acordos_na_fila',v_fila,
                           'acordos_completados',v_completados,'acordos_duplicados_sinalizados',v_dup,
                           'cpfs_pulados_quitados',v_pulados,'linhas_puladas_quitados',v_linhas_puladas,
                           'importacao_id',p_importacao_id);
end; $function$;
