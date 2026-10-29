-- =====================================================================
-- ROLLBACK da E2 — 20261026210000_e2_vinculo_delega_e_proveniencia
-- =====================================================================
-- Desfaz os três blocos na ordem inversa. O bloco 4 saiu da migration (a
-- contenção de `desvincular_titulos_acordo` é da PR #757), então não há o que
-- reverter nela aqui.
--
-- SEM NENHUMA REGEX, de proposito. A primeira versao deste arquivo revertia os
-- patches com `regexp_replace`, e o escape de apostrofo dentro de um literal
-- SQL que ja esta dentro de um bloco `do $$` produziu um padrao que nunca
-- casava -- o rollback "rodava" e devolvia um corpo errado. Aqui cada reversao
-- e um `replace()` do texto NOVO pelo texto ANTIGO, com os dois literais
-- copiados da propria migration.
--
-- A prova de fidelidade nao e "rodou sem erro": cada bloco confere, DEPOIS de
-- reescrever, que o md5 do `prosrc` voltou a ser EXATAMENTE o de producao em
-- 26/10/2026, e que nenhum dos textos novos sobrou no corpo. Se qualquer uma
-- das duas falhar, a transacao inteira aborta e nada muda.
--
-- Isto nao e um restore: PITR nao esta habilitado neste projeto. E reversao por
-- texto, sobre os mesmos trechos que a migration trocou.
--
-- Dado de negocio: nada a desfazer. A migration e ZERO DML.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- BLOCO 3 (inverso) — devolve titulo_reavaliar
-- ---------------------------------------------------------------------
do $$
declare
  v_md5_original constant text := 'a86ab9bf86267fbf4c273a916b072cb7';
  v_def  text;
  v_novo text;
  v_md5  text;
  v_de_1 constant text :=
'  -- E2 (26/10/2026): STATUS DO ACORDO NAO BASTA. A terceira condicao e
  -- cobertura comprovada: a soma das mensalidades com vinculo ativo no acordo
  -- tem de caber no valor pelo qual a divida foi renegociada. Sem isso um
  -- pagamento de R$ 3.313,09 quitava R$ 5.739,46 de mensalidade (caso medido
  -- em 26/10/2026). Quando a cobertura nao se comprova o titulo fica
  -- NEGOCIADO -- nao vai para PAGO e nao volta para ABERTO -- e
  -- acordo_cobertura_detalhe diz com quais numeros.
  v_quitado := v_status_acordo = ''QUITADO''
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'''')) not in (''PAGO'',''CANCELADA'',''RENEGOCIADA'',''DEVOLVIDA'',''SUSPENSA''))
    and public.acordo_cobertura_comprovada(v_acordo);';
  v_para_1 constant text :=
'  v_quitado := v_status_acordo = ''QUITADO''
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'''')) not in (''PAGO'',''CANCELADA'',''RENEGOCIADA'',''DEVOLVIDA'',''SUSPENSA''));';
begin
  select pg_get_functiondef(p.oid), md5(p.prosrc) into v_def, v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'titulo_reavaliar'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo uuid';

  if v_def is null then
    raise exception 'ROLLBACK/BLOCO3: titulo_reavaliar(p_titulo uuid) nao existe';
  end if;
  if v_md5 = v_md5_original then
    raise notice 'ROLLBACK/BLOCO3: ja esta no corpo original, nada a fazer';
    return;
  end if;
  if position('E2 (26/10/2026): STATUS DO ACORDO NAO BASTA' in v_def) = 0 then
    raise exception 'ROLLBACK/BLOCO3: o corpo nao tem a marca da E2 e tambem nao e o original -- nao vou adivinhar';
  end if;

  v_novo := v_def;
  v_novo := replace(v_novo, v_de_1, v_para_1);

  if position(v_de_1 in v_novo) > 0 then
    raise exception 'ROLLBACK/BLOCO3: a troca 1 nao saiu do corpo';
  end if;

  execute v_novo;

  select md5(p.prosrc) into v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'titulo_reavaliar'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo uuid';
  if v_md5 <> v_md5_original then
    raise exception 'ROLLBACK/BLOCO3: md5 voltou % e o original e % -- o rollback NAO foi fiel',
      v_md5, v_md5_original;
  end if;
  raise notice 'ROLLBACK/BLOCO3: corpo original restaurado, md5 confere';
end $$;

-- ---------------------------------------------------------------------
-- BLOCO 2 (inverso) — devolve vincular_titulos_acordo
-- ---------------------------------------------------------------------
do $$
declare
  v_md5_original constant text := '1ea3ca97f0dea404c299ae2beda50502';
  v_def  text;
  v_novo text;
  v_md5  text;
  v_de_1 constant text :=
'  -- E2 (26/10/2026): O VINCULADOR NAO DECIDE QUITACAO. Antes, quando o acordo
  -- estava QUITADO sem parcela viva, ele escrevia PAGO/quitada aqui mesmo -- e
  -- com isso calava o motor, porque titulo_reavaliar retorna na guarda de PAGO
  -- e e o motor que grava origem_liquidacao/_ref/_em. Resultado medido: 798
  -- titulos quitados sem proveniencia nenhuma.
  --
  -- Agora o titulo sai sempre NEGOCIADO/vinculada e a decisao financeira e do
  -- motor, chamado pelo gatilho trg_titulo_situacao_por_vinculo no insert do
  -- vinculo logo abaixo. O motor ve NEGOCIADO (nao PAGO), nao retorna na
  -- guarda, exige cobertura comprovada e grava a proveniencia quando quita.
  --
  -- v_quitado continua DECLARADO e deixa de ser usado: as quatro leituras dele
  -- (a atribuicao aqui, o if da escrita e os dois estado_titulo do retorno)
  -- saem juntas nos tres trechos que este bloco troca. Conferido em producao:
  -- nao ha nenhuma quinta ocorrencia no corpo.';
  v_para_1 constant text :=
'  -- O estado da mensalidade segue o acordo (20260902140000): acordo pago deixa
  -- a mensalidade quitada; acordo ativo deixa negociada.
  v_quitado := v_status_acordo = ''QUITADO''
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = p_acordo_id
         and public.parcela_viva(p.status));';
  v_de_2 constant text :=
'  if v_novos is not null then
    -- E2: UM CAMINHO SO. A bifurcacao saiu inteira em vez de ficar como ramo
    -- morto: deixar a escrita de PAGO no corpo, ainda que inalcancavel, seria
    -- uma armadilha para quem ler a funcao depois.
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = ''NEGOCIADO'', status = ''vinculada'',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    get diagnostics v_n = row_count;
  end if;';
  v_para_2 constant text :=
'  if v_novos is not null then
    if v_quitado then
      update public.acordos_titulos t
         set acordo_id = p_acordo_id, situacao = ''PAGO'', status = ''quitada'',
             motivo_ajuste = coalesce(t.motivo_ajuste,'''')
               || case when coalesce(t.motivo_ajuste,'''') = '''' then '''' else '' | '' end
               || ''quitada junto com o acordo '' || v_numero
               || '': a divida desta mensalidade foi negociada nele e o acordo foi pago'',
             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    else
      update public.acordos_titulos t
         set acordo_id = p_acordo_id, situacao = ''NEGOCIADO'', status = ''vinculada'',
             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    end if;
    get diagnostics v_n = row_count;
  end if;';
  v_de_3 constant text :=
'(select string_agg(distinct lower(coalesce(t.status,'''')), '','' order by lower(coalesce(t.status,''''))) from public.acordos_titulos t where t.id = any(p_titulo_ids))';
  v_para_3 constant text :=
'case when v_quitado then ''quitada'' else ''vinculada'' end';
begin
  select pg_get_functiondef(p.oid), md5(p.prosrc) into v_def, v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'vincular_titulos_acordo'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo_ids uuid[], p_acordo_id uuid';

  if v_def is null then
    raise exception 'ROLLBACK/BLOCO2: vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid) nao existe';
  end if;
  if v_md5 = v_md5_original then
    raise notice 'ROLLBACK/BLOCO2: ja esta no corpo original, nada a fazer';
    return;
  end if;
  if position('E2 (26/10/2026): O VINCULADOR NAO DECIDE QUITACAO' in v_def) = 0 then
    raise exception 'ROLLBACK/BLOCO2: o corpo nao tem a marca da E2 e tambem nao e o original -- nao vou adivinhar';
  end if;

  v_novo := v_def;
  v_novo := replace(v_novo, v_de_1, v_para_1);
  v_novo := replace(v_novo, v_de_2, v_para_2);
  v_novo := replace(v_novo, v_de_3, v_para_3);

  if position(v_de_1 in v_novo) > 0 then
    raise exception 'ROLLBACK/BLOCO2: a troca 1 nao saiu do corpo';
  end if;
  if position(v_de_2 in v_novo) > 0 then
    raise exception 'ROLLBACK/BLOCO2: a troca 2 nao saiu do corpo';
  end if;
  if position(v_de_3 in v_novo) > 0 then
    raise exception 'ROLLBACK/BLOCO2: a troca 3 nao saiu do corpo';
  end if;

  execute v_novo;

  select md5(p.prosrc) into v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'vincular_titulos_acordo'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo_ids uuid[], p_acordo_id uuid';
  if v_md5 <> v_md5_original then
    raise exception 'ROLLBACK/BLOCO2: md5 voltou % e o original e % -- o rollback NAO foi fiel',
      v_md5, v_md5_original;
  end if;
  raise notice 'ROLLBACK/BLOCO2: corpo original restaurado, md5 confere';
end $$;

-- ---------------------------------------------------------------------
-- BLOCO 1 (inverso) — remove as duas funções novas
-- ---------------------------------------------------------------------
-- Nesta ordem: a comprovada depende da detalhe, e o BLOCO 3 inverso já tirou a
-- única referência a elas no motor.
drop function if exists public.acordo_cobertura_comprovada(uuid);
drop function if exists public.acordo_cobertura_detalhe(uuid);

commit;
